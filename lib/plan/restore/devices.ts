import {
  getSteppedLoadHighestStep,
  getSteppedLoadStep,
  isSteppedLoadOffStep,
} from '../../utils/deviceControlProfiles';
import { PLAN_REASON_CODES, type DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import { resolveCommandabilityDetail } from '../../../packages/shared-domain/src/commandableNowReason';
import type { DevicePlanDevice, SteppedPlanDevice } from '../planTypes';
import { isBinaryPlanDevice } from '../planBinaryDevice';
import { compareDeviceIdAsc, sortByPriorityAsc, sortByPriorityDesc } from '../planSort';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import { isTemperaturePlanDevice } from '../planTemperatureDevice';

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
  device: DevicePlanDevice;
};

export function isRestoreLiveEligibleDevice(device: DevicePlanDevice): boolean {
  return device.controllable
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
  // On/off is a binary-only question — narrow first, then read the resolved
  // `currentOn` (a binary device is never 'unknown'). `currentOn` already folds
  // the stepped-off step for binary+stepped devices, so a capped binary stepper
  // reads 'off' here.
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

export function isBinaryRestoreCandidate(device: DevicePlanDevice): boolean {
  return isRestoreLiveEligibleDevice(device) && resolveRestoreObservedState(device) === 'off';
}

export function isSteppedRestoreCandidate(device: DevicePlanDevice): device is SteppedPlanDevice {
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

export function isSwapRestoreCandidate(device: DevicePlanDevice): boolean {
  const observedState = resolveRestoreObservedState(device);
  return isRestoreLiveEligibleDevice(device) && (observedState === 'on' || observedState === 'target_only');
}

export function getOffDevices(planDevices: DevicePlanDevice[]): DevicePlanDevice[] {
  const filtered = planDevices
    .filter((device) => !isSteppedLoadDevice(device) && isBinaryRestoreCandidate(device));
  return sortByPriorityAsc(filtered);
}

export function getSteppedRestoreCandidates(planDevices: DevicePlanDevice[]): SteppedPlanDevice[] {
  const filtered = planDevices
    .filter((device): device is SteppedPlanDevice => isSteppedRestoreCandidate(device));
  return sortByPriorityAsc(filtered);
}

export function getRestoreCandidates(planDevices: DevicePlanDevice[]): RestoreCandidate[] {
  const candidates: RestoreCandidate[] = [
    ...planDevices
      .filter((device) => !isSteppedLoadDevice(device) && isBinaryRestoreCandidate(device))
      .map((device) => ({ kind: 'binary' as const, device })),
    ...planDevices
      .filter((device) => isOffSteppedRestoreCandidate(device))
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
  getShedBehavior: (deviceId: string) => {
    action: 'turn_off' | 'set_temperature' | 'set_step';
    temperature: number | null;
    stepId: string | null;
  },
): DevicePlanDevice[] {
  const filtered = planDevices
    .filter((device) => {
      if (!isSwapRestoreCandidate(device)) return false;
      const behavior = getShedBehavior(device.id);
      if (isSteppedLoadDevice(device)) {
        return behavior.action === 'turn_off'
          && isBinaryPlanDevice(device)
          && canSwapOutDevice(device, behavior);
      }
      return canSwapOutDevice(device, behavior);
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
    .filter((device) => isBinaryRestoreCandidate(device))
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
  behavior: { action: 'turn_off' | 'set_temperature' | 'set_step'; temperature: number | null; stepId: string | null },
): boolean {
  if (behavior.action !== 'set_temperature' || behavior.temperature === null) return true;
  // A non-temperature device has no setpoint to compare — swappable. The old
  // fail-open on a null observed target is gone with the nullable field.
  if (!isTemperaturePlanDevice(dev)) return true;
  return dev.currentTarget > behavior.temperature;
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
