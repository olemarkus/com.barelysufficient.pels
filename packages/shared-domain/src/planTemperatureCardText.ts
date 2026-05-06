import { PLAN_REASON_CODES } from './planReasonSemanticsCore.js';
import { resolvePlanStateKind } from './planStateLabels.js';
import type { DeviceOverviewSnapshot } from './deviceOverview.js';

type TemperatureDevice = DeviceOverviewSnapshot & {
  measuredPowerKw?: number;
  currentTemperature?: number;
  plannedTarget?: number | null;
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
  const { currentTemperature, plannedTarget } = device;
  if (typeof currentTemperature !== 'number') return null;
  if (typeof plannedTarget !== 'number') return null;
  return `${currentTemperature.toFixed(1)}° · target ${plannedTarget.toFixed(0)}°`;
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
  return gap !== null ? `Needs ${gap.toFixed(1)} kW more` : 'Waiting for headroom';
};

export const resolveTemperatureReasonLine = (device: TemperatureDevice): string | null => {
  const { currentTemperature, plannedTarget } = device;
  if (typeof currentTemperature !== 'number' || typeof plannedTarget !== 'number') return null;

  const reasonCode = (device.reason as { code?: string } | undefined)?.code ?? '';
  const kind = resolvePlanStateKind(device);

  if (kind !== 'held' && kind !== 'idle' && kind !== 'resuming') return null;
  if (kind === 'resuming') return 'Restoring';
  if (isWaitingReason(reasonCode)) return resolveWaitingText(device.reason);
  if (isLimitedReason(reasonCode)) return 'Limited by capacity';
  return kind === 'held' ? 'Paused by PELS' : null;
};
