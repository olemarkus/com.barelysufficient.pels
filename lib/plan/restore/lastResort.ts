import { PLAN_REASON_CODES } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlanDevice } from '../planTypes';
import { buildInsufficientHeadroomUpdate, computeRestoreRequirementKw } from './accounting';
import { resolveReserveAdmission, isReserveAdmitted, buildReservedForStartReason } from '../admission';
import { spendPowerHeadroom } from '../powerLimitMath';
import { attemptSwapRestore, holdPendingSwapTargetUntilSourcesAreOff } from './swap';
import { getOnDevices, resolveInactiveRestoreUpdate } from './devices';
import { shouldWaitForOtherRecovery } from './coordination';
import { sortByPriorityAsc } from '../planSort';
import type { RestoreHeadroomLedger } from './headroomLedger';
import { buildRestoreCooldownReason, resolveMeterSettlingReason } from './timing';
import { setRestorePlanDevice } from './planDeviceUpdates';
import type { RestoreCycle, RestoreLoopState } from './types';

export type LastResortRestoreCandidate = DevicePlanDevice & {
  lastResort: NonNullable<DevicePlanDevice['lastResort']> & { observedOffAtMs: number };
};

function isLastResortRestoreCandidate(device: DevicePlanDevice): device is LastResortRestoreCandidate {
  return device.lastResort?.observedOffAtMs !== undefined
    && (device.lastResort.metered !== true || device.lastResortOwnedOffAtMs !== undefined)
    && device.control.commandAuthority && device.commandableNow
    && device.currentState === 'off' && device.plannedState === 'keep' && !device.externalOffHoldActive;
}

export function getNextLastResortRestore(devices: DevicePlanDevice[]): LastResortRestoreCandidate | undefined {
  return sortByPriorityAsc(devices.filter(isLastResortRestoreCandidate))[0];
}

export function applyLastResortRestorePass(
  cycle: RestoreCycle, ledger: RestoreHeadroomLedger, device: LastResortRestoreCandidate,
): boolean {
  if (holdPendingSwapTargetUntilSourcesAreOff(cycle.swapLedger, device, cycle.deviceMap)) return false;
  const availableHeadroom = ledger.availableFor(device);
  const result = planLastResortRestore(cycle, device, { availableHeadroom, restoredOneThisCycle: false });
  if (availableHeadroom !== null && result.availableHeadroom !== null) {
    ledger.commit(device, availableHeadroom - result.availableHeadroom);
  }
  return result.restoredOneThisCycle;
}

function planLastResortRestore(
  cycle: RestoreCycle, device: LastResortRestoreCandidate, loop: RestoreLoopState,
): RestoreLoopState {
  const { lastResort } = device;
  const afterLastChange = Math.max(
    lastResort.observedOffAtMs, device.lastResortOwnedOffAtMs ?? 0, cycle.state.actuation.lastRestoreMs ?? 0,
  );
  const waitingForReading = resolveMeterSettlingReason(cycle.timing, afterLastChange);
  if (waitingForReading || shouldWaitForOtherRecovery(cycle.deviceMap, device.id, false)) {
    setRestorePlanDevice(cycle.deviceMap, device.id, {
      plannedState: 'shed', reason: waitingForReading ?? { code: PLAN_REASON_CODES.waitingForOtherDevices },
    });
    return loop;
  }
  const { state, timing } = cycle;
  const blockingTarget = cycle.swapLedger.blockingTarget(device, cycle.deviceMap);
  if (blockingTarget !== undefined) {
    setRestorePlanDevice(cycle.deviceMap, device.id, {
      plannedState: 'shed', reason: { code: PLAN_REASON_CODES.swapPending, targetName: blockingTarget.name },
    });
    return loop;
  }

  const devPower = lastResort.maximumW / 1000;
  const needed = computeRestoreRequirementKw(devPower, state.actuation.lastDeviceShedMs[device.id], timing.nowTs);
  const reserved = resolveReserveAdmission(device, loop.availableHeadroom, needed, cycle.headroomReserves);
  const admitted = {
    plannedState: 'keep', lastResortCommand: 'on', reason: { code: PLAN_REASON_CODES.keep, detail: null },
  } as const;
  if (isReserveAdmitted(reserved)) {
    setRestorePlanDevice(cycle.deviceMap, device.id, admitted);
    cycle.restoredThisCycle.add(device.id);
    return {
      availableHeadroom: spendPowerHeadroom(loop.availableHeadroom, needed),
      restoredOneThisCycle: true,
    };
  }
  if (reserved.kind === 'blocked_by_reserve') {
    setRestorePlanDevice(cycle.deviceMap, device.id, {
      plannedState: 'shed', reason: buildReservedForStartReason(reserved.holderName),
    });
    return loop;
  }
  const rejected = buildInsufficientHeadroomUpdate(
    needed, reserved.availableKw, reserved.admission.marginKw, null, null, null,
  );
  const onDevices = getOnDevices(
    [...cycle.deviceMap.values()], cycle.deps.getShedBehavior, cycle.deps.temperatureSetpoints,
  );
  const swap = attemptSwapRestore(
    cycle, onDevices, device, reserved.availableKw,
    { needed, devPower, penaltyLevel: 0, penaltyExtraKw: 0 },
    `binary:${device.id}`, { admitted, rejected },
  );
  if (swap.kind === 'decided') return swap;
  setRestorePlanDevice(cycle.deviceMap, device.id, rejected);
  return loop;
}

/** Account for waiting and held relays even when no relay restore was admitted. */
export function markUnrestoredLastResort(cycle: RestoreCycle, limiting: boolean): void {
  const { timing, state, deviceMap } = cycle;
  const reason = limiting || timing.activeOvershoot ? { code: PLAN_REASON_CODES.capacity }
    : (resolveMeterSettlingReason(timing, state.actuation.lastRestoreMs)
      ?? (timing.inRestoreCooldown ? buildRestoreCooldownReason(timing)
        : { code: PLAN_REASON_CODES.waitingForOtherDevices }));
  for (const [id, device] of deviceMap) {
    if (!device.lastResort || !device.control.commandAuthority || device.currentState !== 'off'
      || device.plannedState !== 'keep' || device.lastResortCommand === 'on') continue;
    const inactive = resolveInactiveRestoreUpdate(device);
    if (inactive) setRestorePlanDevice(deviceMap, id, inactive);
    else if (isLastResortRestoreCandidate(device)) {
      setRestorePlanDevice(deviceMap, id, { plannedState: 'shed', reason });
    }
  }
}
