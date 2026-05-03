import type { SteppedLoadProfile } from '../../contracts/src/types.js';
import type { DeviceOverviewSnapshot } from './deviceOverview.js';
import { PLAN_REASON_CODES } from './planReasonSemanticsCore.js';
import type { DeviceReason } from './planReasonSemanticsCore.js';

const capitalize = (s: string): string => (
  s.length === 0 ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}`
);

const isOffLikeId = (id: string | undefined): boolean => {
  const n = (id ?? '').trim().toLowerCase();
  return n === '' || n === 'off';
};

const isOffLikeState = (state: string | undefined): boolean => {
  const n = (state ?? '').trim().toLowerCase();
  return n === '' || n === 'off' || n === 'unknown' || n === 'disappeared';
};

const resolveCurrentStepId = (device: DeviceOverviewSnapshot): string | null => (
  device.reportedStepId ?? device.actualStepId ?? device.assumedStepId ?? device.selectedStepId ?? null
);

const resolveTargetStepId = (device: DeviceOverviewSnapshot): string | null => (
  device.targetStepId ?? device.desiredStepId ?? null
);

const findStepIndex = (profile: SteppedLoadProfile, stepId: string | null): number => (
  stepId === null ? -1 : profile.steps.findIndex((s) => s.id === stepId)
);

const findStepLabel = (profile: SteppedLoadProfile, stepId: string | null): string | null => {
  if (!stepId) return null;
  const step = profile.steps.find((s) => s.id === stepId);
  return step ? capitalize(step.id) : null;
};

const isPoweredStep = (profile: SteppedLoadProfile, stepId: string | null): boolean => {
  if (!stepId || isOffLikeId(stepId)) return false;
  const step = profile.steps.find((s) => s.id === stepId);
  return step !== undefined && step.planningPowerW > 0;
};

export const resolveSteppedStateLabel = (device: DeviceOverviewSnapshot): string => {
  if (isOffLikeState(device.currentState)) return 'Off now';
  const stepId = resolveCurrentStepId(device);
  if (!stepId || isOffLikeId(stepId)) return 'Off now';
  return `Level: ${capitalize(stepId)}`;
};

export const resolveSteppedActiveStepId = (
  device: DeviceOverviewSnapshot,
  profile: SteppedLoadProfile,
): string | null => {
  if (isOffLikeState(device.currentState)) {
    const offStep = profile.steps.find((s) => s.id.toLowerCase() === 'off');
    return offStep ? offStep.id : null;
  }
  return resolveCurrentStepId(device);
};

export const isSteppedTransit = (device: {
  binaryCommandPending?: boolean;
  pendingTargetCommand?: unknown;
}): boolean => (
  device.binaryCommandPending === true || device.pendingTargetCommand != null
);

// ─── Chip resolution ──────────────────────────────────────────────────────────

export type SteppedChip = { label: string; tone: 'ok' | 'warn' };

const isSettlingReason = (code: string): boolean => (
  code === PLAN_REASON_CODES.headroomCooldown
  || code === PLAN_REASON_CODES.meterSettling
  || code === PLAN_REASON_CODES.cooldownRestore
  || code === PLAN_REASON_CODES.cooldownShedding
  || code === PLAN_REASON_CODES.activationBackoff
  || code === PLAN_REASON_CODES.restorePending
  || code === PLAN_REASON_CODES.shedInvariant
  || code === PLAN_REASON_CODES.neutralStartupHold
  || code === PLAN_REASON_CODES.startupStabilization
);

const isLimitedReason = (code: string): boolean => (
  code === PLAN_REASON_CODES.insufficientHeadroom
  || code === PLAN_REASON_CODES.shortfall
  || code === PLAN_REASON_CODES.capacity
  || code === PLAN_REASON_CODES.hourlyBudget
  || code === PLAN_REASON_CODES.dailyBudget
  || code === PLAN_REASON_CODES.swappedOut
  || code === PLAN_REASON_CODES.swapPending
  || code === PLAN_REASON_CODES.waitingForOtherDevices
  || code === PLAN_REASON_CODES.restoreThrottled
);

type SteppedDevice = DeviceOverviewSnapshot & { binaryCommandPending?: boolean; pendingTargetCommand?: unknown };

export const resolveSteppedChip = (device: SteppedDevice): SteppedChip | null => {
  if (isSteppedTransit(device)) return { label: 'Applying', tone: 'ok' };
  if (isSettlingReason(device.reason.code)) return { label: 'Settling', tone: 'warn' };
  if (isLimitedReason(device.reason.code)) return { label: 'Limited', tone: 'warn' };
  return null;
};

// ─── Status line ──────────────────────────────────────────────────────────────

const resolveHeadroomGapKw = (reason: DeviceReason): number | null => {
  if (reason.code === PLAN_REASON_CODES.insufficientHeadroom) {
    const avail = reason.effectiveAvailableKw ?? reason.availableKw ?? 0;
    const gap = reason.needKw - avail;
    return gap > 0.01 ? gap : null;
  }
  if (reason.code === PLAN_REASON_CODES.shortfall) {
    const avail = reason.headroomKw ?? 0;
    const need = reason.needKw ?? 0;
    const gap = need - avail;
    return gap > 0.01 ? gap : null;
  }
  return null;
};

const formatSec = (sec: number): string => `${Math.round(Math.max(0, sec))}s`;

const resolveElapsedAgoText = (countdownStartedAtMs: number | undefined, nowMs: number): string => {
  if (countdownStartedAtMs === undefined) return 'recently';
  const elapsed = Math.round((nowMs - countdownStartedAtMs) / 1000);
  return elapsed >= 0 ? `${elapsed}s ago` : 'recently';
};

const resolveSettlingStatusLine = (reason: DeviceReason, nowMs: number): string | null => {
  if (reason.code === PLAN_REASON_CODES.headroomCooldown) {
    if (reason.kind === 'recent_pels_restore') {
      const ago = resolveElapsedAgoText(reason.countdownStartedAtMs, nowMs);
      return `Restored ${ago} — confirming no overshoot`;
    }
    return `Recently reduced · can increase in ${formatSec(reason.remainingSec)}`;
  }
  if (reason.code === PLAN_REASON_CODES.cooldownRestore) {
    const ago = resolveElapsedAgoText(reason.countdownStartedAtMs, nowMs);
    return `Restored ${ago} — confirming no overshoot`;
  }
  if (reason.code === PLAN_REASON_CODES.cooldownShedding) {
    return `Recently reduced · can increase in ${formatSec(reason.remainingSec)}`;
  }
  if (reason.code === PLAN_REASON_CODES.meterSettling) {
    return `Waiting for meter reading (${formatSec(reason.remainingSec)})`;
  }
  return null;
};

const resolveTransitStatusLine = (device: SteppedDevice, profile: SteppedLoadProfile): string | null => {
  const targetId = resolveTargetStepId(device);
  if (!isPoweredStep(profile, targetId)) return 'Turning off to stay below limit';
  const label = findStepLabel(profile, targetId);
  if (isOffLikeState(device.currentState)) {
    return label ? `Turning on to ${label}` : 'Turning on';
  }
  const currentId = resolveCurrentStepId(device);
  const currentIdx = findStepIndex(profile, currentId);
  const targetIdx = findStepIndex(profile, targetId);
  if (targetIdx > currentIdx && currentIdx >= 0) return label ? `Increasing to ${label}` : 'Increasing';
  if (targetIdx < currentIdx && currentIdx >= 0) return label ? `Reducing to ${label}` : 'Reducing';
  return null;
};

const resolveBlockedStatusLine = (device: SteppedDevice, profile: SteppedLoadProfile): string | null => {
  const targetId = resolveTargetStepId(device);
  if (!targetId || !isPoweredStep(profile, targetId)) return null;
  if (isOffLikeState(device.currentState)) {
    const gap = resolveHeadroomGapKw(device.reason);
    return gap !== null ? `Needs ${gap.toFixed(1)} kW more to turn on` : null;
  }
  const currentId = resolveCurrentStepId(device);
  const currentIdx = findStepIndex(profile, currentId);
  const targetIdx = findStepIndex(profile, targetId);
  if (currentIdx >= 0 && targetIdx > currentIdx) {
    const gap = resolveHeadroomGapKw(device.reason);
    return gap !== null ? `Needs ${gap.toFixed(1)} kW more to increase` : null;
  }
  return null;
};

export const resolveSteppedStatusLine = (
  device: SteppedDevice,
  profile: SteppedLoadProfile,
  nowMs: number,
): string | null => {
  if (isSteppedTransit(device)) return resolveTransitStatusLine(device, profile);
  if (isSettlingReason(device.reason.code)) return resolveSettlingStatusLine(device.reason, nowMs);
  const blocked = resolveBlockedStatusLine(device, profile);
  if (blocked !== null) return blocked;
  if (!isOffLikeState(device.currentState)) {
    const stepId = resolveCurrentStepId(device);
    if (stepId && !isOffLikeId(stepId)) return 'Maintaining level';
  }
  return null;
};

export const resolveSteppedTemperatureText = (device: {
  currentTemperature?: number;
  plannedTarget?: number | null;
}): string | null => {
  const { currentTemperature, plannedTarget } = device;
  if (typeof currentTemperature !== 'number') return null;
  if (typeof plannedTarget !== 'number') return null;
  return `${currentTemperature.toFixed(1)}° → ${plannedTarget.toFixed(0)}°`;
};

export { capitalize as capitalizeStepLabel };
