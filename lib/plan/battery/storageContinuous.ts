import type { ObservedStorageInput } from '../../../packages/planner-types/src/planInputDevice';
import type { StorageLeverState } from '../planState';
import type { PlanInputDevice } from '../planTypes';
import type { MeasuredPower } from '../planContext';
import type { StorageSurplusOffer } from '../planSurplusAbsorb';
import { floorStorageSetpointW } from '../../utils/storageSetpoint';
import { storageSetpointToleranceW } from '../../planContract/storageDecision';
import { claimSurplusLever, summarizeHold } from './storageHold';
import {
  STORAGE_RELIEF_SETTLE_WINDOW_MS, drawMarginWFor, hasStorageLeverInput, ownChargeWOf,
  ownDischargeWOf, resolveStorageHoldBlock,
} from './storageLadder';
import type { StorageBalance, StorageRelief, StorageStateSummary } from './storageReliefTypes';

function dischargeCredit(
  storage: ObservedStorageInput,
  previous: StorageLeverState | undefined,
  setpointW: number,
  nowTs: number,
): Pick<StorageLeverState, 'increaseDecidedAtMs' | 'creditBaseW'> {
  const observedW = ownDischargeWOf(storage);
  if (setpointW >= 0) return { increaseDecidedAtMs: nowTs - STORAGE_RELIEF_SETTLE_WINDOW_MS, creditBaseW: 0 };
  if (previous === undefined) return { increaseDecidedAtMs: nowTs, creditBaseW: observedW };
  const requestedW = Math.max(0, -previous.setpointW);
  const open = nowTs - previous.increaseDecidedAtMs < STORAGE_RELIEF_SETTLE_WINDOW_MS;
  const unanswered = requestedW - observedW > storageSetpointToleranceW(previous.setpointW, previous.stepW);
  if (-setpointW <= requestedW || open || unanswered) {
    return { increaseDecidedAtMs: previous.increaseDecidedAtMs, creditBaseW: previous.creditBaseW };
  }
  return { increaseDecidedAtMs: nowTs, creditBaseW: Math.max(observedW, requestedW) };
}

export const continuousLever = (
  storage: ObservedStorageInput,
  previous: StorageLeverState | undefined,
  balance: StorageBalance,
  offer: StorageSurplusOffer,
  nowTs: number,
): StorageLeverState => {
  const plan = storage.continuousPlan;
  if (plan === undefined) throw new Error('A continuous hold requires a battery plan');
  const marginW = drawMarginWFor(storage);
  const importWithoutBatteryW = balance.netImportW - storage.signedPowerW;
  const desiredW = plan.setpointW < 0
    ? -Math.min(-plan.setpointW, storage.deliveryCeilingW, Math.max(0, importWithoutBatteryW - marginW))
    : Math.min(plan.setpointW, storage.chargeCeilingW);
  // Replacing a discharge with charge must first pay back that discharge;
  // it is not measured room for a new charging load.
  const roomCeilingW = balance.headroomW === null
    ? desiredW
    : Math.max(0, storage.signedPowerW + balance.headroomW - marginW);
  const solarCeilingW = plan.reason === 'store_solar' || offer.demandAbove === 'waiting'
    ? Math.max(0, offer.availableW - offer.addedBackW + ownChargeWOf(storage) - marginW)
    : storage.chargeCeilingW;
  const boundedW = desiredW > 0
    ? Math.min(desiredW, roomCeilingW, solarCeilingW)
    : desiredW;
  const setpointW = floorStorageSetpointW(Math.max(-storage.deliveryCeilingW, boundedW), storage.range);
  const hold = claimSurplusLever(storage, setpointW, nowTs);
  return {
    ...hold,
    purpose: 'continuous',
    continuousReason: plan.reason,
    preClaimSignedW: previous?.preClaimSignedW ?? storage.signedPowerW,
    ownModeChargeW: Math.max(0, plan.setpointW),
    ...dischargeCredit(storage, previous, setpointW, nowTs),
  };
};

export function resumeContinuousStorage(
  relief: StorageRelief,
  beforeHandBack: StorageRelief,
  devices: readonly PlanInputDevice[],
  power: MeasuredPower,
  offers: ReadonlyMap<string, StorageSurplusOffer>,
  nowTs: number,
): StorageRelief {
  const balance: StorageBalance = {
    deficitW: power.headroomKw === null ? 0 : Math.max(0, -power.headroomKw * 1000),
    headroomW: power.headroomKw === null ? null : Math.max(0, power.headroomKw * 1000),
    netImportW: power.drawKw * 1000,
  };
  const resumed = relief.batteries.flatMap((battery) => {
    if (battery.decision.kind !== 'release' || battery.decision.reason !== 'restored') return [];
    const device = devices.find(candidate => candidate.id === battery.deviceId);
    if (device === undefined || !hasStorageLeverInput(device) || device.storage.reading !== 'observed') return [];
    const { storage } = device;
    const offer = offers.get(device.id);
    if (storage.continuousPlan === undefined || storage.continuousPlan.validUntilMs <= nowTs
      || resolveStorageHoldBlock(storage) !== 'holdable' || offer === undefined) return [];
    const fresh = continuousLever(storage, undefined, balance, offer, nowTs);
    const lever = {
      ...fresh,
      preClaimSignedW: beforeHandBack.levers[device.id]?.preClaimSignedW ?? fresh.preClaimSignedW,
    };
    const summary: StorageStateSummary = {
      ...summarizeHold(device.id, storage, lever, 0),
      decision: { kind: 'setpoint', setpointW: lever.setpointW, stepW: lever.stepW, restored: true },
    };
    return [{ lever, summary }];
  });
  const byId = new Map(resumed.map(item => [item.summary.deviceId, item.summary]));
  const levers = {
    ...relief.levers,
    ...Object.fromEntries(resumed.map(item => [item.summary.deviceId, item.lever])),
  };
  const batteries = relief.batteries.map(battery => byId.get(battery.deviceId) ?? battery);
  return { ...relief, levers, batteries };
}
