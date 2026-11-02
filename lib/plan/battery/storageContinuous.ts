import type { ContinuousStoragePlan, ObservedStorageInput } from '../../../packages/planner-types/src/planInputDevice';
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

/**
 * The Main-meter export a period may add on top of covering the house, W. Only a
 * selling period carries the owner's ceiling; household supply stops at the
 * house's measured draw. Measured demand can take part or all of a planned
 * sale: the lever never raises discharge to keep a forecast export quantity.
 */
const exportAllowanceW = (plan: ContinuousStoragePlan): number => (
  plan.reason === 'export_energy' ? plan.netExportCeilingW : 0
);

/**
 * A battery reading older than the meter sample by more than this, ms, lags it.
 * The house's draw without the battery is the meter less the battery's own
 * power; with a lagging battery reading that difference mixes two moments, and
 * a battery that has since cut its discharge would read as house demand.
 * Batteries report less often than meters, so a strict "older than" would
 * freeze discharge between battery reports.
 */
export const STORAGE_READING_LAG_TOLERANCE_MS = 15_000;

/**
 * The most discharge a plan may ask for this cycle, W. A lagging reading may
 * hold a discharge but never raise it: no more than the battery is observed
 * delivering. A battery that already sits at the setpoint PELS holds it to is
 * the exception: Homey stamps a reading only when it changes, so a battery
 * steady at its setpoint reads old while being exactly where it was put, and
 * bounding it would freeze its discharge for good.
 */
const laggingDischargeCeilingW = (
  storage: ObservedStorageInput,
  previous: StorageLeverState | undefined,
  balance: StorageBalance,
): number => {
  if (balance.sampledAtMs - storage.observedAtMs <= STORAGE_READING_LAG_TOLERANCE_MS) return Number.POSITIVE_INFINITY;
  const atHeldSetpoint = previous !== undefined && Math.abs(storage.signedPowerW - previous.setpointW)
    <= storageSetpointToleranceW(previous.setpointW, previous.stepW);
  return atHeldSetpoint ? Number.POSITIVE_INFINITY : ownDischargeWOf(storage);
};

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
  const dischargeRoomW = Math.min(
    Math.max(0, importWithoutBatteryW + exportAllowanceW(plan) - marginW),
    laggingDischargeCeilingW(storage, previous, balance),
  );
  const desiredW = plan.setpointW < 0
    ? -Math.min(-plan.setpointW, storage.deliveryCeilingW, dischargeRoomW)
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
    sampledAtMs: power.sampledAtMs,
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
