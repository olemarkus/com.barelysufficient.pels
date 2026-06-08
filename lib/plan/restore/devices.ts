import { getSteppedLoadHighestStep } from '../../utils/deviceControlProfiles';
import { PLAN_REASON_CODES, type DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import { resolveEvBlockReasonForDevice } from '../../../packages/shared-domain/src/commandableNow';
import type { DevicePlanDevice } from '../planTypes';
import { isObservedOff, isObservedOn } from '../../observer/observedState';
import { sortByPriorityAsc, sortByPriorityDesc } from '../planSort';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import { isTemperaturePlanDevice } from '../planTemperatureDevice';

export const NEUTRAL_STARTUP_HOLD_REASON: DeviceReason = { code: PLAN_REASON_CODES.neutralStartupHold };

export type RestoreCandidate = {
  kind: 'binary' | 'stepped';
  device: DevicePlanDevice;
};

export function isRestoreLiveEligibleDevice(device: DevicePlanDevice): boolean {
  // No explicit staleness check: `resolveRestoreObservedState` reads
  // `isObservedOff` / `isObservedOn` from observer, both of which already
  // short-circuit on stale observations. A stale device resolves to 'unknown'
  // / 'target_only' there and is not classified as a binary or stepped
  // restore candidate.
  return device.controllable !== false
    && device.plannedState !== 'shed';
}

type RestoreObservedState = 'off' | 'on' | 'target_only' | 'unknown';

function resolveRestoreObservedState(device: DevicePlanDevice): RestoreObservedState {
  if (isObservedOff(device)) return 'off';
  if (isObservedOn(device)) return 'on';
  return device.currentState === 'not_applicable' ? 'target_only' : 'unknown';
}

export function isBinaryRestoreCandidate(device: DevicePlanDevice): boolean {
  return isRestoreLiveEligibleDevice(device) && resolveRestoreObservedState(device) === 'off';
}

export function isSteppedRestoreCandidate(device: DevicePlanDevice): boolean {
  if (!isSteppedLoadDevice(device) || !device.steppedLoadProfile?.steps?.length) return false;
  if (!isRestoreLiveEligibleDevice(device)) return false;
  const observedState = resolveRestoreObservedState(device);
  return observedState === 'off'
    || (
      observedState === 'on'
      && (
      device.selectedStepId !== undefined
      && device.selectedStepId !== getSteppedLoadHighestStep(device.steppedLoadProfile)?.id
      )
    );
}

export function isOffSteppedRestoreCandidate(device: DevicePlanDevice): boolean {
  if (!isSteppedLoadDevice(device) || !device.steppedLoadProfile?.steps?.length) return false;
  if (!isRestoreLiveEligibleDevice(device)) return false;
  return resolveRestoreObservedState(device) === 'off';
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

export function getSteppedRestoreCandidates(planDevices: DevicePlanDevice[]): DevicePlanDevice[] {
  const filtered = planDevices
    .filter((device) => isSteppedRestoreCandidate(device));
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
  return candidates.slice().sort((a, b) => (a.device.priority ?? 999) - (b.device.priority ?? 999));
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
          && device.controlCapabilityId !== undefined
          && canSwapOutDevice(device, behavior);
      }
      return canSwapOutDevice(device, behavior);
    });
  return sortByPriorityDesc(filtered);
}

export function getEvRestoreStateBlockReason(dev: DevicePlanDevice): string | null {
  // Delegate EV identity AND EV-state → reason to the shared device-shaped
  // resolver (one source of truth, also behind resolveCommandableNow). Its own
  // `isEvDevice` gate covers BOTH the `evcharger_charging` control capability and
  // an `evcharger` device class, so an evcharger-class device that happens to
  // control via a different capability is no longer silently skipped. Non-EV
  // devices resolve to `null`. This consumer never touches the raw charging-state
  // string — no plug-state re-derivation here.
  return resolveEvBlockReasonForDevice(dev);
}

export function getInactiveReason(dev: DevicePlanDevice): DeviceReason | null {
  const evStateBlock = getEvRestoreStateBlockReason(dev);
  if (evStateBlock) return { code: PLAN_REASON_CODES.inactive, detail: evStateBlock };

  return null;
}

export function markOffDevicesStayOff(params: {
  deviceMap: Map<string, DevicePlanDevice>;
  timing: {
    activeOvershoot: boolean;
    inCooldown: boolean;
    inStartupStabilization: boolean;
    restoreCooldownSeconds: number;
    shedCooldownRemainingSec: number | null;
    shedCooldownStartedAtMs?: number | null;
    shedCooldownTotalSec?: number | null;
    restoreCooldownStartedAtMs?: number | null;
    restoreCooldownTotalSec?: number | null;
    startupStabilizationRemainingSec: number | null;
  };
  setDevice: (id: string, updates: Partial<DevicePlanDevice>) => void;
  reasonOverride?: (dev: DevicePlanDevice) => DeviceReason;
  blockedPlannedState?: 'shed' | 'keep';
  getLastControlledMs?: (deviceId: string) => number | undefined;
}): void {
  const {
    deviceMap,
    timing,
    setDevice,
    reasonOverride,
    blockedPlannedState = 'shed',
    getLastControlledMs,
  } = params;
  const offDevices = Array.from(deviceMap.values())
    .filter((device) => isBinaryRestoreCandidate(device));
  for (const dev of offDevices) {
    const inactiveReason = getInactiveReason(dev);
    if (inactiveReason) {
      setDevice(dev.id, { plannedState: 'inactive', reason: inactiveReason });
      continue;
    }
    const defaultReason = dev.reason ?? { code: PLAN_REASON_CODES.capacity, detail: null };
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
  const devCurrentTarget = isTemperaturePlanDevice(dev) ? dev.currentTarget : null;
  let currentTarget: number | null = null;
  if (typeof devCurrentTarget === 'number') {
    currentTarget = devCurrentTarget;
  } else if (typeof dev.plannedTarget === 'number') {
    currentTarget = dev.plannedTarget;
  }
  if (currentTarget === null) return true;
  return currentTarget > behavior.temperature;
}

function resolveOffDeviceReason(
  timing: {
    activeOvershoot: boolean;
    inCooldown: boolean;
    inStartupStabilization: boolean;
    restoreCooldownSeconds: number;
    shedCooldownRemainingSec: number | null;
    shedCooldownStartedAtMs?: number | null;
    shedCooldownTotalSec?: number | null;
    restoreCooldownStartedAtMs?: number | null;
    restoreCooldownTotalSec?: number | null;
    startupStabilizationRemainingSec: number | null;
  },
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
