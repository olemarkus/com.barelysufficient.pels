import { PLAN_REASON_CODES } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlanDevice } from '../planTypes';
import { buildInsufficientHeadroomUpdate, computeRestoreRequirementKw } from './accounting';
import { resolveReserveAdmission, isReserveAdmitted, buildReservedForStartReason } from '../admission';
import { spendPowerHeadroom } from '../powerLimitMath';
import { attemptSwapRestore } from './swap';
import { buildRestoreCooldownReason, resolveMeterSettlingReason } from './timing';
import { setRestorePlanDevice } from './planDeviceUpdates';
import type { RestoreCycle, RestoreLane, RestoreLoopState } from './types';

export function planLastResortRestore(
  cycle: RestoreCycle, lane: RestoreLane, device: DevicePlanDevice, loop: RestoreLoopState,
): RestoreLoopState {
  if (device.lastResortOwnedOffAtMs === undefined || !device.commandableNow || !device.lastResort
    || device.currentState !== 'off' || device.externalOffHoldActive) return loop;
  const afterLastChange = Math.max(device.lastResortOwnedOffAtMs, cycle.state.actuation.lastRestoreMs ?? 0);
  const waitingForReading = resolveMeterSettlingReason(cycle.timing, afterLastChange, loop.restoredOneThisCycle);
  if (waitingForReading || device.binaryCommandPending) {
    setRestorePlanDevice(cycle.deviceMap, device.id, {
      plannedState: 'shed', reason: waitingForReading ?? { code: PLAN_REASON_CODES.meterSettling },
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

  const devPower = device.lastResort.maximumW / 1000;
  const needed = computeRestoreRequirementKw(devPower, state.actuation.lastDeviceShedMs[device.id], timing.nowTs);
  const reserved = resolveReserveAdmission(device, loop.availableHeadroom, needed, cycle.headroomReserves);
  const admitted = {
    plannedState: 'keep', lastResortCommand: 'on', reason: { code: PLAN_REASON_CODES.keep, detail: null },
  } as const;
  if (isReserveAdmitted(reserved)) {
    setRestorePlanDevice(cycle.deviceMap, device.id, admitted);
    cycle.restoredThisCycle.add(device.id);
    // eslint-disable-next-line functional/immutable-data, no-param-reassign -- The restore pass owns its batch.
    cycle.batchState.enabled = false;
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
  const swap = attemptSwapRestore(
    cycle, lane.onDevices, device, reserved.availableKw,
    { needed, devPower, penaltyLevel: 0, penaltyExtraKw: 0 },
    `binary:${device.id}`, { admitted, rejected },
  );
  if (swap.kind === 'decided') return swap;
  setRestorePlanDevice(cycle.deviceMap, device.id, rejected);
  return loop;
}

/** Keep owned OFF devices held even when the ordinary restore lane did not run. */
export function markUnrestoredLastResort(cycle: RestoreCycle, limiting: boolean): void {
  const { timing, state, deviceMap } = cycle;
  const reason = limiting || timing.activeOvershoot ? { code: PLAN_REASON_CODES.capacity }
    : (resolveMeterSettlingReason(timing, state.actuation.lastRestoreMs)
      ?? (timing.inRestoreCooldown ? buildRestoreCooldownReason(timing)
        : { code: PLAN_REASON_CODES.waitingForOtherDevices }));
  for (const [id, device] of deviceMap) {
    if (device.lastResortOwnedOffAtMs !== undefined && device.currentState === 'off' && device.plannedState === 'keep'
      && device.lastResortCommand !== 'on') setRestorePlanDevice(deviceMap, id, { plannedState: 'shed', reason });
  }
}
