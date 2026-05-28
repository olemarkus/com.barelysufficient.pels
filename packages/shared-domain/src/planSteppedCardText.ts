import type { SteppedLoadProfile } from '../../contracts/src/types.js';
import type { DeviceOverviewSnapshot } from './deviceOverview.js';
import { PLAN_REASON_CODES } from './planReasonSemanticsCore.js';
import type { DeviceReason } from './planReasonSemanticsCore.js';
import {
  PLAN_STATE_DAILY_BUDGET_STATUS,
  PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS,
  PLAN_STATE_HELD_FALLBACK_STATUS,
  PLAN_STATE_HOURLY_BUDGET_STATUS,
} from './planStateLabels.js';

const capitalize = (s: string): string => (
  s.length === 0 ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}`
);

// Match stored ampere step ids like `6a`, `16a`, `32a` (digits followed by a
// lowercase `a`). The persisted stepId is the contract surface — log
// schemas, plan signatures, and downstream consumers all read it — so this
// helper only changes the *display* string for human-facing surfaces (step
// rail, status lines). Numeric values are returned as `"N A"` (uppercase
// ampere, separated with a space per the SI unit convention) so the label
// cannot read as `"6 am"`.
const AMPERE_STEP_PATTERN = /^([0-9]+)a$/i;

const formatStepDisplayLabelInternal = (stepId: string): string => {
  const trimmed = stepId.trim();
  if (trimmed.length === 0) return '';
  const match = AMPERE_STEP_PATTERN.exec(trimmed);
  if (match) return `${match[1]} A`;
  return capitalize(trimmed);
};

const isOffLikeId = (id: string | undefined): boolean => {
  const n = (id ?? '').trim().toLowerCase();
  return n === '' || n === 'off';
};

// Broader than the shared `isOffLikeState` in `deviceStatePredicates.ts`:
// also treats empty / `'disappeared'` as off-for-display so the stepped card
// renders "Off now" when the device has no fresh observation. Intentionally
// not unified — the shared predicate is the strict off-or-unknown semantic
// used elsewhere; this one is display-only.
const isSteppedCardOffLikeState = (state: string | undefined): boolean => {
  const n = (state ?? '').trim().toLowerCase();
  return n === '' || n === 'off' || n === 'unknown' || n === 'disappeared';
};

type SteppedLoadCardState = {
  reportedStepId: string | null;
  targetStepId: string | null;
  commandPending: boolean;
};

type SteppedCardDevice = DeviceOverviewSnapshot & {
  steppedLoad?: SteppedLoadCardState;
};

const resolveCurrentStepId = (device: SteppedCardDevice): string | null => (
  device.steppedLoad?.reportedStepId ?? null
);

const resolveTargetStepId = (device: SteppedCardDevice): string | null => (
  device.steppedLoad?.targetStepId ?? null
);

const normalizeStepId = (id: string | null): string | null => (
  id === null ? null : id.toLowerCase()
);

const findStepIndex = (profile: SteppedLoadProfile, stepId: string | null): number => {
  const norm = normalizeStepId(stepId);
  return norm === null ? -1 : profile.steps.findIndex((s) => s.id.toLowerCase() === norm);
};

const findStepLabel = (profile: SteppedLoadProfile, stepId: string | null): string | null => {
  const norm = normalizeStepId(stepId);
  if (!norm) return null;
  const step = profile.steps.find((s) => s.id.toLowerCase() === norm);
  return step ? formatStepDisplayLabelInternal(step.id) : null;
};

const isPoweredStep = (profile: SteppedLoadProfile, stepId: string | null): boolean => {
  if (!stepId || isOffLikeId(stepId)) return false;
  const norm = normalizeStepId(stepId);
  const step = profile.steps.find((s) => s.id.toLowerCase() === norm);
  return step !== undefined && step.planningPowerW > 0;
};

export const resolveSteppedStateLabel = (device: SteppedCardDevice): string => {
  if (isSteppedCardOffLikeState(device.currentState)) return 'Off now';
  const stepId = resolveCurrentStepId(device);
  if (!stepId) return 'Level unknown';
  if (isOffLikeId(stepId)) return 'Off now';
  return `Level: ${formatStepDisplayLabelInternal(stepId)}`;
};

export const resolveSteppedActiveStepId = (
  device: SteppedCardDevice,
  profile: SteppedLoadProfile,
): string | null => {
  if (isSteppedCardOffLikeState(device.currentState)) {
    const offStep = profile.steps.find((s) => s.id.toLowerCase() === 'off');
    return offStep?.id ?? 'off';
  }
  return resolveCurrentStepId(device);
};

export const isSteppedTransit = (device: {
  steppedLoad?: Pick<SteppedLoadCardState, 'commandPending'>;
}): boolean => (
  device.steppedLoad?.commandPending === true
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
  || code === PLAN_REASON_CODES.neutralStartupHold
  || code === PLAN_REASON_CODES.startupStabilization
);

const isWaitingReason = (code: string): boolean => (
  code === PLAN_REASON_CODES.insufficientHeadroom
  || code === PLAN_REASON_CODES.shortfall
  || code === PLAN_REASON_CODES.waitingForOtherDevices
  || code === PLAN_REASON_CODES.restoreThrottled
  || code === PLAN_REASON_CODES.swapPending
  || code === PLAN_REASON_CODES.swappedOut
);

const isLimitedReason = (code: string): boolean => (
  isWaitingReason(code)
  || code === PLAN_REASON_CODES.shedInvariant
  || code === PLAN_REASON_CODES.capacity
  || code === PLAN_REASON_CODES.hourlyBudget
  || code === PLAN_REASON_CODES.dailyBudget
);

type SteppedDevice = SteppedCardDevice;

export const resolveSteppedChip = (device: SteppedDevice): SteppedChip | null => {
  if (isSteppedTransit(device)) return { label: 'Applying', tone: 'ok' };
  return null;
};

const isAtTargetStep = (device: SteppedDevice): boolean => {
  const reportedId = normalizeStepId(resolveCurrentStepId(device));
  const targetId = normalizeStepId(resolveTargetStepId(device));
  return reportedId !== null && targetId !== null && reportedId === targetId;
};

// Settling reasons that only fire while the planner is *checking headroom* for a
// possible escalation (e.g. boost wanting a higher step). Reasons in this set are
// safe to suppress when the device is already at its target step. Other settling
// reasons (cooldown_shedding, cooldown_restore, activation_backoff, restore_pending,
// startup holds) imply the planner is actively holding the device and must keep
// rendering their countdown / status text even at-target.
const isHeadroomCheckSettlingReason = (code: string): boolean => (
  code === PLAN_REASON_CODES.meterSettling
  || code === PLAN_REASON_CODES.headroomCooldown
);

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
      return `Resumed ${ago} — checking power reading`;
    }
    return `Limited — will try to resume in ${formatSec(reason.remainingSec)} if power is available`;
  }
  if (reason.code === PLAN_REASON_CODES.cooldownRestore) {
    const ago = resolveElapsedAgoText(reason.countdownStartedAtMs, nowMs);
    return `Resumed ${ago} — checking power reading`;
  }
  if (reason.code === PLAN_REASON_CODES.cooldownShedding) {
    return `Limited — will try to resume in ${formatSec(reason.remainingSec)} if power is available`;
  }
  if (reason.code === PLAN_REASON_CODES.meterSettling) {
    return `Waiting for power meter to stabilise — ${formatSec(reason.remainingSec)}`;
  }
  if (reason.code === PLAN_REASON_CODES.activationBackoff) {
    return `Briefly holding — ${formatSec(reason.remainingSec)}`;
  }
  if (reason.code === PLAN_REASON_CODES.restorePending) {
    return `Queued to resume — ${formatSec(reason.remainingSec)}`;
  }
  if (reason.code === PLAN_REASON_CODES.neutralStartupHold) {
    return 'Holding at startup';
  }
  if (reason.code === PLAN_REASON_CODES.startupStabilization) {
    return 'Stabilising after startup';
  }
  return null;
};

const resolveTransitStatusLine = (device: SteppedDevice, profile: SteppedLoadProfile): string | null => {
  const targetId = resolveTargetStepId(device);
  if (!isPoweredStep(profile, targetId)) return 'Turning off to stay below limit';
  const label = findStepLabel(profile, targetId);
  if (isSteppedCardOffLikeState(device.currentState)) {
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
  if (isSteppedCardOffLikeState(device.currentState)) {
    const gap = resolveHeadroomGapKw(device.reason);
    return gap !== null ? `Waiting to resume — ${gap.toFixed(1)} kW more needed` : null;
  }
  const currentId = resolveCurrentStepId(device);
  const currentIdx = findStepIndex(profile, currentId);
  const targetIdx = findStepIndex(profile, targetId);
  if (currentIdx >= 0 && targetIdx > currentIdx) {
    const gap = resolveHeadroomGapKw(device.reason);
    return gap !== null ? `Waiting to increase — ${gap.toFixed(1)} kW more needed` : null;
  }
  return null;
};

const resolveOffStatusLine = (device: SteppedDevice): string | null => {
  if (isWaitingReason(device.reason.code)) {
    const gap = resolveHeadroomGapKw(device.reason);
    return gap !== null ? `Waiting to resume — ${gap.toFixed(1)} kW more needed` : 'Waiting for available power';
  }
  if (device.reason.code === PLAN_REASON_CODES.deferredObjectiveAvoid) return PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS;
  if (device.reason.code === PLAN_REASON_CODES.dailyBudget) return PLAN_STATE_DAILY_BUDGET_STATUS;
  if (device.reason.code === PLAN_REASON_CODES.hourlyBudget) return PLAN_STATE_HOURLY_BUDGET_STATUS;
  if (isLimitedReason(device.reason.code)) return PLAN_STATE_HELD_FALLBACK_STATUS;
  return null;
};

export const resolveSteppedStatusLine = (
  device: SteppedDevice,
  profile: SteppedLoadProfile,
  nowMs: number,
): string | null => {
  if (isSteppedTransit(device)) return resolveTransitStatusLine(device, profile);
  if (isSettlingReason(device.reason.code)) {
    const suppressed = isHeadroomCheckSettlingReason(device.reason.code) && isAtTargetStep(device);
    if (!suppressed) return resolveSettlingStatusLine(device.reason, nowMs);
  }
  if (device.reason.code === PLAN_REASON_CODES.shedInvariant) {
    const r = device.reason;
    const n = r.shedDeviceCount;
    const stepLabel = formatStepDisplayLabelInternal(r.maxStep);
    const noun = n === 1 ? 'device' : 'devices';
    return `Limited to ${stepLabel} — ${n} ${noun} still limited`;
  }
  const blocked = resolveBlockedStatusLine(device, profile);
  if (blocked !== null) return blocked;
  if (isSteppedCardOffLikeState(device.currentState)) return resolveOffStatusLine(device);
  const stepId = resolveCurrentStepId(device);
  return stepId && !isOffLikeId(stepId) ? 'Maintaining level' : null;
};

export const resolveSteppedTemperatureText = (device: {
  currentTemperature?: number;
  plannedTarget?: number;
}): string | null => {
  const { currentTemperature, plannedTarget } = device;
  if (typeof currentTemperature !== 'number') return null;
  if (typeof plannedTarget !== 'number') return null;
  return `${currentTemperature.toFixed(1)}° → ${plannedTarget.toFixed(0)}°`;
};

export const resolveSteppedPowerText = (device: {
  measuredPowerKw?: number;
}): string | null => {
  const { measuredPowerKw } = device;
  if (typeof measuredPowerKw !== 'number') return null;
  return `${measuredPowerKw.toFixed(1)} kW`;
};

const EV_CHARGING_STATE_LABELS: Record<string, string> = {
  plugged_in_charging: 'Charging',
  plugged_in_paused: 'Paused',
  plugged_in: 'Waiting for car',
  plugged_in_discharging: 'Discharging',
  plugged_out: 'Unplugged',
};

export const resolveEvChargingStateLabel = (device: {
  evChargingState?: string;
  controlCapabilityId?: string;
}): string | null => {
  if (device.controlCapabilityId !== 'evcharger_charging') return null;
  const state = (device.evChargingState ?? '').trim().toLowerCase();
  return EV_CHARGING_STATE_LABELS[state] ?? null;
};

export { capitalize as capitalizeStepLabel };
export { formatStepDisplayLabelInternal as formatStepDisplayLabel };
