import { getSteppedLoadHighestStep } from '../../utils/deviceControlProfiles';
import { PLAN_REASON_CODES, type DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import { resolveEvBlockReason } from '../../../packages/shared-domain/src/commandableNowReason';
import type { DevicePlanDevice } from '../planTypes';
import { isObservedOff, isObservedOn } from '../../observer/observedState';
import { sortByPriorityAsc, sortByPriorityDesc } from '../planSort';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import { isEvPlanDevice } from '../planEvDevice';

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
  if (dev.controlCapabilityId !== 'evcharger_charging') return null;
  // `controlCapabilityId === 'evcharger_charging'` already proves this is an EV
  // device; `isEvPlanDevice` re-establishes that for the compiler so evChargingState
  // narrows off the EV-omitted base. The gateless EV-state → reason switch lives in
  // commandableNowReason (one source of truth, shared with resolveCommandableNow +
  // the device-projection snapshot gate); a non-narrowed dev (unreachable here)
  // resolves to state_unknown via `undefined`.
  return resolveEvBlockReason(isEvPlanDevice(dev) ? dev.evChargingState : undefined);
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
  let currentTarget: number | null = null;
  if (typeof dev.currentTarget === 'number') {
    currentTarget = dev.currentTarget;
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
