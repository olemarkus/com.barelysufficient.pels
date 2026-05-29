import { PLAN_REASON_CODES } from './planReasonSemanticsCore.js';
import {
  PLAN_STATE_DAILY_BUDGET_STATUS,
  PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS,
  PLAN_STATE_HELD_FALLBACK_STATUS,
  PLAN_STATE_HOURLY_BUDGET_STATUS,
  resolvePlanStateKind,
} from './planStateLabels.js';
import type { DeviceOverviewSnapshot } from './deviceOverview.js';

type TemperatureDevice = DeviceOverviewSnapshot & {
  measuredPowerKw?: number;
  currentTemperature?: number;
  currentTarget?: unknown;
  plannedTarget?: number;
};

const isWaitingReason = (code: string): boolean => (
  code === PLAN_REASON_CODES.insufficientHeadroom
  || code === PLAN_REASON_CODES.shortfall
  || code === PLAN_REASON_CODES.headroomCooldown
  || code === PLAN_REASON_CODES.cooldownRestore
  || code === PLAN_REASON_CODES.cooldownShedding
  || code === PLAN_REASON_CODES.meterSettling
  || code === PLAN_REASON_CODES.activationBackoff
  || code === PLAN_REASON_CODES.restorePending
  || code === PLAN_REASON_CODES.waitingForOtherDevices
  || code === PLAN_REASON_CODES.neutralStartupHold
  || code === PLAN_REASON_CODES.startupStabilization
);

const isLimitedReason = (code: string): boolean => (
  code === PLAN_REASON_CODES.capacity
  || code === PLAN_REASON_CODES.hourlyBudget
  || code === PLAN_REASON_CODES.dailyBudget
  || code === PLAN_REASON_CODES.swappedOut
  || code === PLAN_REASON_CODES.swapPending
);

// ─── Output state ─────────────────────────────────────────────────────────────

export const resolveTemperatureOutputState = (device: TemperatureDevice): string => {
  const state = (device.currentState ?? '').trim().toLowerCase();
  if (!state || state === 'off' || state === 'unknown' || state === 'disappeared') return 'Off';
  return 'On';
};

// ─── Temperature line ─────────────────────────────────────────────────────────

export const resolveTemperatureLine = (device: TemperatureDevice): string | null => {
  const { currentTemperature, currentTarget, plannedTarget } = device;
  if (typeof plannedTarget !== 'number') return null;
  const targetText = typeof currentTarget === 'number' && currentTarget !== plannedTarget
    ? `${currentTarget.toFixed(0)}° → ${plannedTarget.toFixed(0)}°`
    : `${plannedTarget.toFixed(0)}°`;
  // Middle-dot separator for the data line — em-dash is reserved for status
  // copy (see notes/ui-terminology.md:9). Source: TODO #8.
  if (typeof currentTemperature !== 'number') return `target ${targetText} · sensor unavailable`;
  return `${currentTemperature.toFixed(1)}° · target ${targetText}`;
};

// ─── Reason line ─────────────────────────────────────────────────────────────

const resolveHeadroomGapKw = (reason: unknown): number | null => {
  if (!reason || typeof reason !== 'object') return null;
  const r = reason as Record<string, unknown>;
  const code = r['code'];
  if (code === PLAN_REASON_CODES.insufficientHeadroom) {
    const avail = (r['effectiveAvailableKw'] ?? r['availableKw'] ?? 0) as number;
    const need = (r['needKw'] ?? 0) as number;
    const gap = need - avail;
    return gap > 0.01 ? gap : null;
  }
  if (code === PLAN_REASON_CODES.shortfall) {
    const need = (r['needKw'] ?? 0) as number;
    const avail = (r['headroomKw'] ?? 0) as number;
    const gap = need - avail;
    return gap > 0.01 ? gap : null;
  }
  return null;
};

const resolveWaitingText = (reason: unknown): string => {
  const gap = resolveHeadroomGapKw(reason);
  return gap !== null ? `Waiting to resume — ${gap.toFixed(1)} kW more needed` : 'Waiting for available power';
};

// Map a reason code to its limited-status label. Extracted so the parent
// resolver stays under the SonarJS / ESLint complexity caps after the
// deferred-objective avoid branch was added.
const resolveLimitedReasonLabel = (reasonCode: string): string | null => {
  if (reasonCode === PLAN_REASON_CODES.deferredObjectiveAvoid) return PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS;
  if (reasonCode === PLAN_REASON_CODES.dailyBudget) return PLAN_STATE_DAILY_BUDGET_STATUS;
  if (reasonCode === PLAN_REASON_CODES.hourlyBudget) return PLAN_STATE_HOURLY_BUDGET_STATUS;
  if (isLimitedReason(reasonCode)) return PLAN_STATE_HELD_FALLBACK_STATUS;
  return null;
};

export const resolveTemperatureReasonLine = (device: TemperatureDevice): string | null => {
  const { currentTemperature, plannedTarget } = device;
  if (typeof currentTemperature !== 'number' || typeof plannedTarget !== 'number') return null;

  const reasonCode = (device.reason as { code?: string } | undefined)?.code ?? '';
  const kind = resolvePlanStateKind(device);

  if (kind !== 'held' && kind !== 'idle' && kind !== 'resuming') return null;
  if (kind === 'idle') return null;
  if (kind === 'resuming') return 'Resuming';
  if (isWaitingReason(reasonCode)) return resolveWaitingText(device.reason);
  const limitedLabel = resolveLimitedReasonLabel(reasonCode);
  if (limitedLabel !== null) return limitedLabel;
  return kind === 'held' ? 'Lowered by PELS' : null;
};
