import { PLAN_REASON_CODES, type DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { PowerLimitCeiling } from '../../../packages/contracts/src/capacitySettings';
import type { DevicePlanDevice } from '../planTypes';
import { buildInsufficientHeadroomUpdate, computeRestoreBufferKw, computeRestoreRequirementKw } from './accounting';
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

/**
 * A relay whose maximum, plus the room PELS keeps for its start, is above the
 * highest rate admission can offer from the grid fits only while solar export or
 * a discharging battery makes the difference. Giving it the priority turn would
 * hold every other start behind it, so it gets none: it starts when measured
 * room covers it (`applyOpportunisticLastResortRestore`), and its card asks the
 * owner to correct the setup.
 */
export function resolveLastResortAboveLimitReason(
  device: DevicePlanDevice, ceiling: PowerLimitCeiling | null,
): DeviceReason | null {
  if (ceiling === null || device.lastResort === undefined) return null;
  const maximumKw = device.lastResort.maximumW / 1000;
  if (maximumKw + computeRestoreBufferKw(maximumKw) <= ceiling.kw) return null;
  return { code: PLAN_REASON_CODES.lastResortAboveLimit, maximumKw, limitKw: ceiling.kw, limit: ceiling.limit };
}

/** The next relay due its priority turn, and the next relay above the ceiling, each in Modes order. */
export function getNextLastResortRestores(
  devices: DevicePlanDevice[], ceiling: PowerLimitCeiling | null,
): { target: LastResortRestoreCandidate | undefined; aboveLimit: LastResortRestoreCandidate | undefined } {
  const candidates = sortByPriorityAsc(devices.filter(isLastResortRestoreCandidate));
  return {
    target: candidates.find((device) => resolveLastResortAboveLimitReason(device, ceiling) === null),
    aboveLimit: candidates.find((device) => resolveLastResortAboveLimitReason(device, ceiling) !== null),
  };
}

export function applyLastResortRestorePass(
  cycle: RestoreCycle, ledger: RestoreHeadroomLedger, device: LastResortRestoreCandidate,
): boolean {
  return applyLastResortRestore(cycle, ledger, device, true);
}

/**
 * Start a relay above the ceiling only when measured room already covers it. It
 * takes no device's power by a swap and holds nothing; left off, it keeps its
 * above-limit reason.
 */
export function applyOpportunisticLastResortRestore(
  cycle: RestoreCycle, ledger: RestoreHeadroomLedger, device: LastResortRestoreCandidate,
): boolean {
  return applyLastResortRestore(cycle, ledger, device, false);
}

function applyLastResortRestore(
  cycle: RestoreCycle, ledger: RestoreHeadroomLedger, device: LastResortRestoreCandidate, allowSwap: boolean,
): boolean {
  if (holdPendingSwapTargetUntilSourcesAreOff(cycle.swapLedger, device, cycle.deviceMap)) return false;
  const availableHeadroom = ledger.availableFor(device);
  const result = planLastResortRestore(cycle, device, { availableHeadroom, restoredOneThisCycle: false }, allowSwap);
  if (availableHeadroom !== null && result.availableHeadroom !== null) {
    ledger.commit(device, availableHeadroom - result.availableHeadroom);
  }
  return result.restoredOneThisCycle;
}

function planLastResortRestore(
  cycle: RestoreCycle, device: LastResortRestoreCandidate, loop: RestoreLoopState, allowSwap: boolean,
): RestoreLoopState {
  const { lastResort } = device;
  // An above-limit relay keeps its owner-action warning through transient waits.
  const aboveLimit = allowSwap ? null : resolveLastResortAboveLimitReason(device, cycle.deps.admissionCeiling);
  const afterLastChange = Math.max(
    lastResort.observedOffAtMs, device.lastResortOwnedOffAtMs ?? 0, cycle.state.actuation.lastRestoreMs ?? 0,
  );
  const waitingForReading = resolveMeterSettlingReason(cycle.timing, afterLastChange);
  if (waitingForReading || shouldWaitForOtherRecovery(cycle.deviceMap, device.id, false)) {
    const waiting = waitingForReading ?? { code: PLAN_REASON_CODES.waitingForOtherDevices };
    return keepRelayOff(cycle, device, aboveLimit ?? waiting, loop);
  }
  const { state, timing } = cycle;
  const blockingTarget = cycle.swapLedger.blockingTarget(device, cycle.deviceMap);
  if (blockingTarget !== undefined) {
    const swapPending = { code: PLAN_REASON_CODES.swapPending, targetName: blockingTarget.name } as const;
    return keepRelayOff(cycle, device, aboveLimit ?? swapPending, loop);
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
    return keepRelayOff(cycle, device, buildReservedForStartReason(reserved.holderName), loop);
  }
  if (aboveLimit !== null) return keepRelayOff(cycle, device, aboveLimit, loop);
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

function keepRelayOff(
  cycle: RestoreCycle, device: LastResortRestoreCandidate, reason: DeviceReason, loop: RestoreLoopState,
): RestoreLoopState {
  setRestorePlanDevice(cycle.deviceMap, device.id, { plannedState: 'shed', reason });
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
      const aboveLimit = resolveLastResortAboveLimitReason(device, cycle.deps.admissionCeiling);
      setRestorePlanDevice(deviceMap, id, { plannedState: 'shed', reason: aboveLimit ?? reason });
    }
  }
}
