import {
  getSteppedLoadHighestStep,
  getSteppedLoadStep,
  isSteppedLoadOffStep,
} from '../../utils/deviceControlProfiles';
import { PLAN_REASON_CODES, type DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import { resolveCommandabilityDetail } from '../../../packages/shared-domain/src/commandableNowReason';
import type {
  DevicePlanDevice, MeteredDevicePlanDevice, MeteredKind, ShedBehavior, SteppedPlanDevice,
} from '../planTypes';
import { isMeteredPlanDevice } from '../planMeteredDevice';
import { isBinaryPlanDevice } from '../planBinaryDevice';
import { compareDeviceIdAsc, sortByPriorityAsc, sortByPriorityDesc } from '../planSort';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import { isTemperaturePlanDevice } from '../planTemperatureDevice';
import { temperatureSetpointsFor } from '../planTemperatureSetpoints';
import type { TemperatureSetpointsByDevice } from '../../../packages/planner-types/src/temperatureSetpoints';
import type { ShedDecisions } from '../shedDecisions';

export const NEUTRAL_STARTUP_HOLD_REASON: DeviceReason = { code: PLAN_REASON_CODES.neutralStartupHold };

/**
 * The timing facts `resolveOffDeviceReason` arbitrates between. A structural
 * subset of `RestoreTiming` (`restore/timing.ts`), named here because two lanes
 * now consume it: the binary stay-off lane below and the setpoint hold lane
 * (`planReasonsHoldDecisions.ts`).
 */
export type OffDeviceReasonTiming = {
  activeOvershoot: boolean;
  inCooldown: boolean;
  inStartupStabilization: boolean;
  restoreCooldownSeconds: number;
  shedCooldownRemainingSec: number | null;
  shedCooldownStartedAtMs?: number | null;
  shedCooldownTotalSec?: number | null;
  restoreCooldownStartedAtMs?: number | null;
  restoreCooldownTotalSec?: number | null;
};

export type RestoreCandidate = {
  kind: 'binary' | 'stepped';
  device: MeteredDevicePlanDevice;
};

export function isRestoreLiveEligibleDevice(device: DevicePlanDevice): device is MeteredDevicePlanDevice {
  // Resuming a device is admitting its draw into available power, which only a
  // device with a power reading can be priced for. A temperature device planned
  // without one keeps its setpoint logic and is never a restore, swap or
  // reservation candidate — this is the gate all of those funnel through.
  return isMeteredPlanDevice(device)
    && device.control.commandAuthority
    && device.plannedState !== 'shed'
    && device.plannedState !== 'inactive'
    // "Leave off until turned on again": the single gate every restore-candidate
    // predicate funnels through, so excluding the device here removes it from
    // binary restore, stepped restore, headroom reservation, and swap
    // beneficiary selection at once. The device stays managed and its measured
    // draw still counts toward whole-home power — PELS just never resumes it.
    && device.externalOffHoldActive !== true;
}

type RestoreObservedState = 'off' | 'on' | 'target_only' | 'unknown';

function resolveRestoreObservedState(device: DevicePlanDevice): RestoreObservedState {
  // `currentOn` already folds the stepped-off step for binary+stepped devices,
  // so a capped binary stepper reads 'off' here.
  if (isBinaryPlanDevice(device)) {
    return device.currentOn ? 'on' : 'off';
  }
  // A step-only stepped device (no binary handle — e.g. target-power) carries no
  // `currentOn`, but its on/off is still a real question answered by the STEP
  // axis: parked at the off step ⇒ 'off', at an active step ⇒ 'on'. The step
  // shed/restore lanes drive these devices (`deviceActionProjection` resolves
  // them to `set_step`), so they must stay restore-eligible after a cap — read
  // the step primitives directly, not the `currentState` label.
  if (isSteppedLoadDevice(device)) {
    // Membership, not presence: the step is producer-guaranteed, but the EV
    // target-power substitution can cap it out of the planner profile.
    const step = getSteppedLoadStep(device.steppedLoadProfile, device.selectedStepId);
    if (!step) return 'unknown';
    return isSteppedLoadOffStep(device.steppedLoadProfile, step.id) ? 'off' : 'on';
  }
  return device.currentState === 'not_applicable' ? 'target_only' : 'unknown';
}

export function isOffBinaryRestoreHoldCandidate(device: DevicePlanDevice): device is MeteredDevicePlanDevice {
  // This observed-OFF predicate is only used by shed/shortfall hold lanes: an
  // off device must not be commanded ON while the planner is standing down.
  // It does not classify a restoration; that comes from the previous plan.
  return isRestoreLiveEligibleDevice(device) && resolveRestoreObservedState(device) === 'off';
}

function needsRestoreAdmission(device: DevicePlanDevice, shedDecisions: ShedDecisions): boolean {
  // A newly appearing device is admitted from shed posture regardless of its
  // binary observation.
  if (shedDecisions.wasShedOrUnplanned(device.id)) return true;
  // Otherwise only an off device is a start, and it skips admission only when
  // the previous plan kept it with command authority (it drifted off). Left
  // `inactive` (held off, unavailable), kept without authority, or no plan yet:
  // turning it on is a start PELS has not admitted. A running device stays
  // governed by its measured contribution to whole-home headroom.
  return resolveRestoreObservedState(device) === 'off' && !shedDecisions.lastPlannedKeptIds.has(device.id);
}

export function isShedPostureBinaryRestoreCandidate(
  device: DevicePlanDevice,
  shedDecisions: ShedDecisions,
): device is MeteredDevicePlanDevice {
  // The previous plan's shed posture — or the baseline shed posture of a device
  // absent from that plan — moves to keep only through admission. Its observed
  // on/off value does not classify this transition.
  return needsRestoreAdmission(device, shedDecisions)
    && isBinaryPlanDevice(device)
    && device.shedAction !== 'set_temperature'
    && isRestoreLiveEligibleDevice(device);
}

export function isShedPostureSteppedRestoreCandidate(
  device: DevicePlanDevice,
  shedDecisions: ShedDecisions,
): device is SteppedPlanDevice & MeteredKind {
  // Planned history classifies the transition; a device missing from that
  // history starts in shed posture. The step observation prices the rung change
  // but does not decide whether admission is needed.
  return needsRestoreAdmission(device, shedDecisions)
    && isSteppedLoadDevice(device)
    && device.shedAction !== 'set_temperature'
    && device.steppedLoadProfile.steps.length > 0
    && isRestoreLiveEligibleDevice(device);
}

export function isSteppedRestoreCandidate(
  device: DevicePlanDevice,
): device is SteppedPlanDevice & MeteredKind {
  if (!isSteppedLoadDevice(device) || device.steppedLoadProfile.steps.length === 0) return false;
  if (!isRestoreLiveEligibleDevice(device)) return false;
  const observedState = resolveRestoreObservedState(device);
  return observedState === 'off'
    || (
      observedState === 'on'
      && device.selectedStepId !== getSteppedLoadHighestStep(device.steppedLoadProfile)?.id
    );
}

export function isOffSteppedRestoreCandidate(device: DevicePlanDevice): boolean {
  if (!isSteppedLoadDevice(device) || device.steppedLoadProfile.steps.length === 0) return false;
  if (!isRestoreLiveEligibleDevice(device)) return false;
  return resolveRestoreObservedState(device) === 'off';
}

// Active counterpart of `isOffSteppedRestoreCandidate`: a stepped device observed
// ON via the step axis (an active, below-target step). Step-only steppers (no
// binary handle) resolve their on-state from the step too, so a binary-only
// `currentOn` check would drop them — use this at the "active stepped" sites.
export function isActiveSteppedRestoreCandidate(device: DevicePlanDevice): boolean {
  if (!isSteppedLoadDevice(device) || device.steppedLoadProfile.steps.length === 0) return false;
  if (!isRestoreLiveEligibleDevice(device)) return false;
  return resolveRestoreObservedState(device) === 'on';
}

export function isSwapRestoreCandidate(device: DevicePlanDevice): device is MeteredDevicePlanDevice {
  const observedState = resolveRestoreObservedState(device);
  return isRestoreLiveEligibleDevice(device) && (observedState === 'on' || observedState === 'target_only');
}

export function getOffDevices(
  planDevices: DevicePlanDevice[],
): MeteredDevicePlanDevice[] {
  const filtered = planDevices
    .filter((device): device is MeteredDevicePlanDevice => (
      !isSteppedLoadDevice(device) && isOffBinaryRestoreHoldCandidate(device)
    ));
  return sortByPriorityAsc(filtered);
}

export function getSteppedRestoreCandidates(planDevices: DevicePlanDevice[]): Array<SteppedPlanDevice & MeteredKind> {
  const filtered = planDevices
    .filter((device): device is SteppedPlanDevice & MeteredKind => isSteppedRestoreCandidate(device));
  return sortByPriorityAsc(filtered);
}

export function getRestoreCandidates(
  planDevices: DevicePlanDevice[],
  shedDecisions: ShedDecisions,
): RestoreCandidate[] {
  const candidates: RestoreCandidate[] = [
    ...planDevices
      .filter((device): device is MeteredDevicePlanDevice => (
        !isSteppedLoadDevice(device) && isShedPostureBinaryRestoreCandidate(device, shedDecisions)
      ))
      .map((device) => ({ kind: 'binary' as const, device })),
    ...planDevices
      // Previous shed posture or absence from the prior plan classifies the
      // transition; observed binary state does not. The helper also proves the
      // stepped profile and power axis are available.
      .filter((device): device is SteppedPlanDevice & MeteredKind => (
        isShedPostureSteppedRestoreCandidate(device, shedDecisions)
      ))
      .map((device) => ({ kind: 'stepped' as const, device })),
  ];
  return candidates.slice().sort((a, b) => {
    const byPriority = (a.device.priority ?? 999) - (b.device.priority ?? 999);
    if (byPriority !== 0) return byPriority;
    // Defensive tiebreak for partial/legacy inputs, shared with shed. Normal
    // active-home plan inputs already carry unique relative ranks.
    return compareDeviceIdAsc(a.device, b.device);
  });
}

export function getOnDevices(
  planDevices: DevicePlanDevice[],
  getShedBehavior: (deviceId: string) => ShedBehavior,
  temperatureSetpoints: TemperatureSetpointsByDevice,
): MeteredDevicePlanDevice[] {
  const filtered = planDevices
    .filter((device): device is MeteredDevicePlanDevice => {
      if (!isSwapRestoreCandidate(device)) return false;
      const behavior = getShedBehavior(device.id);
      if (isSteppedLoadDevice(device)) {
        return behavior.action === 'turn_off'
          && isBinaryPlanDevice(device)
          && canSwapOutDevice(device, behavior, temperatureSetpoints);
      }
      return canSwapOutDevice(device, behavior, temperatureSetpoints);
    });
  return sortByPriorityDesc(filtered);
}

export function getInactiveReason(dev: DevicePlanDevice): DeviceReason | null {
  if (dev.commandableNow === false) {
    // The wording is derived from the same observed state the decision was made
    // from, at the surface that shows it — nothing carries a reason string.
    return { code: PLAN_REASON_CODES.inactive, detail: resolveCommandabilityDetail(dev) };
  }
  if (dev.externalOffHoldActive === true) return { code: PLAN_REASON_CODES.externalOffHold };
  // "Only PELS starts this device", once the device is actually off. While it is
  // still running the plan must say `shed`, because that is what makes the
  // executor turn it off; once it IS off there is nothing left to do and the
  // honest posture is `inactive` — the device is not being held back from
  // anything, off is its baseline.
  //
  // The producer-resolved flag, NOT the owner's raw policy: a device whose smart
  // task is driving it this hour is not held, and it is precisely a HELD-OFF
  // device the task has to be able to start. Reading the raw enum here pinned
  // every such device `inactive`, and no start intent is ever built for an
  // inactive device — so "it runs when a Smart task needs it to" was false for
  // every device the hold had already taken off.
  //
  // This is also the whole of the card treatment. `inactive` resolves to the
  // `Off` state word (`resolvePlanStateKind`), where `shed` resolves to
  // `Limited` and the empty reason string falls through to "Waiting to resume" —
  // a line that would promise the owner PELS intends to bring the device back
  // once power frees up, when only a smart task ever will.
  if (dev.startPolicyHoldActive === true) return { code: PLAN_REASON_CODES.awaitingPelsStart };

  return null;
}

export function markOffDevicesStayOff(params: {
  deviceMap: Map<string, DevicePlanDevice>;
  timing: OffDeviceReasonTiming;
  setDevice: (id: string, updates: Partial<DevicePlanDevice>) => void;
  reasonOverride?: (dev: DevicePlanDevice) => DeviceReason;
  blockedPlannedState?: 'shed' | 'keep';
  getLastControlledMs?: (deviceId: string) => number | undefined;
  deviceFilter?: (dev: DevicePlanDevice) => boolean;
}): void {
  const {
    deviceMap,
    timing,
    setDevice,
    reasonOverride,
    blockedPlannedState = 'shed',
    getLastControlledMs,
    deviceFilter,
  } = params;
  const offDevices = Array.from(deviceMap.values())
    .filter((device) => isOffBinaryRestoreHoldCandidate(device))
    .filter((device) => deviceFilter?.(device) ?? true);
  for (const dev of offDevices) {
    const inactiveReason = getInactiveReason(dev);
    if (inactiveReason) {
      setDevice(dev.id, { plannedState: 'inactive', reason: inactiveReason });
      continue;
    }
    const defaultReason = dev.reason;
    const nextReason = reasonOverride
      ? reasonOverride(dev)
      : resolveOffDeviceReason(timing, defaultReason, getLastControlledMs?.(dev.id));
    if (nextReason === null) {
      setDevice(dev.id, { plannedState: 'shed', reason: NEUTRAL_STARTUP_HOLD_REASON });
      continue;
    }
    setDevice(dev.id, { plannedState: blockedPlannedState, reason: nextReason });
  }
}

function canSwapOutDevice(
  dev: DevicePlanDevice,
  behavior: ShedBehavior,
  temperatureSetpoints: TemperatureSetpointsByDevice,
): boolean {
  if (behavior.action !== 'set_temperature') return true;
  // A non-temperature device has no setpoint to compare — swappable. The old
  // fail-open on a null observed target is gone with the nullable field.
  if (!isTemperaturePlanDevice(dev)) return true;
  // Swappable while moving it to its limit would still release demand — a
  // thermostat already at its limit frees nothing. Resolved before the planner,
  // because that is a question of which way the device moves demand.
  const { shed } = temperatureSetpointsFor(temperatureSetpoints, dev.id);
  return shed.action === 'set_temperature' && shed.releasesDemand;
}

/**
 * Precedence ladder for a device PELS is declining to resume this cycle:
 * startup stabilization → active overshoot (the caller's own reason stands) →
 * shed cooldown → restore cooldown.
 *
 * Exported so the setpoint hold lane (`planReasonsHoldDecisions.ts`) runs THIS
 * ladder instead of re-deriving precedence: `inShedWindow` folds four causes
 * into one boolean (`restore/timing.ts`), three of them timers, and a lane that
 * cannot tell them apart labels a timer hold as a power-ceiling hold. A
 * thermostat at its shed floor and the binary device beside it are held by the
 * same timer and must say so identically.
 *
 * The terminal branch is an unconditional restore cooldown, so callers must only
 * consult the ladder when one of the four causes actually holds.
 *
 * `null` means "still inside the startup window on a device PELS has never
 * controlled" — no hold is PELS's to claim. The binary lane answers that with
 * `NEUTRAL_STARTUP_HOLD_REASON`; an actuating lane keeps its own reason.
 */
export function resolveOffDeviceReason(
  timing: OffDeviceReasonTiming,
  defaultReason: DeviceReason,
  lastControlledMs?: number,
): DeviceReason | null {
  if (timing.inStartupStabilization) {
    return lastControlledMs === undefined ? null : { code: PLAN_REASON_CODES.startupStabilization };
  }
  if (timing.activeOvershoot) return defaultReason;
  if (timing.inCooldown) {
    const seconds = timing.shedCooldownRemainingSec ?? 0;
    return {
      code: PLAN_REASON_CODES.cooldownShedding,
      remainingSec: seconds,
      ...(typeof timing.shedCooldownStartedAtMs === 'number'
        ? { countdownStartedAtMs: timing.shedCooldownStartedAtMs }
        : {}),
      ...(typeof timing.shedCooldownTotalSec === 'number' && timing.shedCooldownTotalSec > 0
        ? { countdownTotalSec: timing.shedCooldownTotalSec }
        : {}),
    };
  }
  return {
    code: PLAN_REASON_CODES.cooldownRestore,
    remainingSec: timing.restoreCooldownSeconds,
    ...(typeof timing.restoreCooldownStartedAtMs === 'number'
      ? { countdownStartedAtMs: timing.restoreCooldownStartedAtMs }
      : {}),
    ...(typeof timing.restoreCooldownTotalSec === 'number' && timing.restoreCooldownTotalSec > 0
      ? { countdownTotalSec: timing.restoreCooldownTotalSec }
      : {}),
  };
}
