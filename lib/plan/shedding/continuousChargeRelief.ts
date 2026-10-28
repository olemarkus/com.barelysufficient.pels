import type { LatchedMeterReading } from '../../power/lastTotalPower';
import type { PlanEngineState, ShedPlanLatch, ShedRelief, StorageLeverState } from '../planState';
import type { PlanInputDevice } from '../planTypes';
import { isStorageReliefCreditable, type StorageRelief } from '../battery/storageRelief';
import type { StorageSetpoint } from './types';
import { isStorageLimitScope, type LimitableStorageDevice } from './storageCandidate';
import type { ShedPressure } from './pressure';
import {
  latchShedDecision, PENDING_RELIEF_EPSILON_KW, resolvePendingShedRelief, type PendingShedRelief,
} from './pendingRelief';

/** A renewed charging load withdraws its newest stopped-charge promises first. */
function cancelChargeRaise(latch: ShedPlanLatch | null, deviceId: string, raisedKw: number): ShedPlanLatch | null {
  const previous = latch?.decisions.get(deviceId);
  if (latch === null || previous === undefined) return latch;
  let newerKw = previous.reduce((sum, decision) => sum + decision.creditedKw, 0);
  const retained = previous.map(decision => {
    newerKw -= decision.creditedKw;
    const cancelled = Math.min(decision.creditedKw, Math.max(0, raisedKw - newerKw));
    return { ...decision, creditedKw: decision.creditedKw - cancelled };
  }).filter(decision => decision.creditedKw > PENDING_RELIEF_EPSILON_KW);
  const decisions = new Map(latch.decisions);
  if (retained.length > 0) decisions.set(deviceId, retained);
  else decisions.delete(deviceId);
  return { ...latch, decisions };
}

function newStoppedChargeKw(
  device: LimitableStorageDevice,
  previous: StorageLeverState | undefined,
  next: StorageLeverState,
  carried: PendingShedRelief | null,
): number {
  const { storage } = device;
  const observedW = Math.max(0, storage.signedPowerW);
  const previousW = previous === undefined ? observedW : Math.max(0, previous.setpointW);
  const newKw = Math.max(0, Math.min(observedW, previousW) - Math.max(0, next.setpointW)) / 1000;
  // An expired unanswered command cannot renew its credit by moving lower.
  const undelivered = carried?.undeliveredKwByDevice.get(device.id) ?? 0;
  return observedW > previousW + PENDING_RELIEF_EPSILON_KW * 1000 && undelivered <= PENDING_RELIEF_EPSILON_KW
    ? 0 : newKw;
}

/** Bank routine stopped charge in the same bounded ledger as selected charge limits.
 * This carrier is bookkeeping only; its setpoints never become capacity decisions. */
export function resolveContinuousChargeRelief(
  state: PlanEngineState,
  devices: readonly PlanInputDevice[],
  storage: StorageRelief,
  pressure: ShedPressure,
  measurement: LatchedMeterReading,
  nowTs: number,
) {
  let priorLatch = state.shedPlanLatch;
  const priorLevers = Object.fromEntries(Object.entries(state.storageLeverByDevice).map(([deviceId, previous]) => {
    const next = storage.levers[deviceId];
    if (next?.purpose !== 'continuous') return [deviceId, previous];
    const raisedKw = (Math.max(0, next.setpointW) - Math.max(0, previous.setpointW)) / 1000;
    if (raisedKw <= PENDING_RELIEF_EPSILON_KW) return [deviceId, previous];
    priorLatch = cancelChargeRaise(priorLatch, deviceId, raisedKw);
    return [deviceId, next];
  }));
  const carried = resolvePendingShedRelief(
    priorLatch, devices, measurement.powerW, nowTs, priorLevers, pressure,
  );
  const storageSetpoints = new Map<string, StorageSetpoint>();
  const reliefByDevice = new Map<string, ShedRelief>();
  for (const device of devices) {
    const next = storage.levers[device.id];
    if (next?.purpose !== 'continuous' || !isStorageLimitScope(device)
      || !isStorageReliefCreditable(device.storage)) continue;
    const previous = state.storageLeverByDevice[device.id];
    const newKw = newStoppedChargeKw(device, previous, next, carried);
    if (newKw <= PENDING_RELIEF_EPSILON_KW) continue;
    storageSetpoints.set(device.id, { setpointW: next.setpointW, banked: true, storage: device.storage });
    reliefByDevice.set(device.id, { kind: 'electrical', creditedKw: newKw });
  }
  if (storageSetpoints.size === 0) return carried;
  const latch = latchShedDecision({
    shedSet: new Set(), shedReasons: new Map(), shedStepTargets: new Map(), storageSetpoints, reliefByDevice,
  }, carried, measurement.powerW, nowTs, devices);
  return resolvePendingShedRelief(latch, devices, measurement.powerW, nowTs, storage.levers, pressure);
}
