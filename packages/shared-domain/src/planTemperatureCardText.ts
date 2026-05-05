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

const isHeating = (device: TemperatureDevice): boolean => (
  typeof device.measuredPowerKw === 'number' && device.measuredPowerKw > 0.05
);

// ─── Output state ─────────────────────────────────────────────────────────────

export const resolveTemperatureOutputState = (device: TemperatureDevice): string => {
  const state = (device.currentState ?? '').trim().toLowerCase();
  if (!state || state === 'off' || state === 'unknown' || state === 'disappeared') return 'Off';
  if (!isHeating(device)) return 'On · idle';
  return 'On';
};

// ─── Temperature line ─────────────────────────────────────────────────────────

export const resolveTemperatureLine = (device: TemperatureDevice): string | null => {
  const { currentTemperature, plannedTarget } = device;
  if (typeof currentTemperature !== 'number') return null;
  if (typeof plannedTarget !== 'number') return null;
  return `${currentTemperature.toFixed(1)}° · target ${plannedTarget.toFixed(0)}°`;
};

// ─── Delta / reason line ──────────────────────────────────────────────────────

const resolveDeltaText = (delta: number): string => {
  const abs = Math.abs(delta);
  if (abs < 0.2) return 'At target';
  if (delta > 0) return `${delta.toFixed(1)}° below target`;
  return `${abs.toFixed(1)}° above target`;
};

const resolveReasonSuffix = (
  kind: string,
  reasonCode: string,
): string | null => {
  if (kind === 'held') {
    if (isWaitingReason(reasonCode)) return 'waiting for headroom';
    if (isLimitedReason(reasonCode)) return 'limited by capacity';
    return 'paused by PELS';
  }
  if (kind === 'idle') {
    if (isWaitingReason(reasonCode)) return 'waiting for headroom';
    if (isLimitedReason(reasonCode)) return 'limited by capacity';
    return null;
  }
  if (kind === 'resuming') return 'restoring';
  if (kind === 'active') return null;
  return null;
};

export const resolveTemperatureReasonLine = (device: TemperatureDevice): string | null => {
  const { currentTemperature, plannedTarget } = device;
  if (typeof currentTemperature !== 'number' || typeof plannedTarget !== 'number') return null;

  const delta = plannedTarget - currentTemperature;
  const reasonCode = (device.reason as { code?: string } | undefined)?.code ?? '';
  const kind = resolvePlanStateKind(device);
  const deltaText = resolveDeltaText(delta);
  const suffix = resolveReasonSuffix(kind, reasonCode);

  return suffix !== null ? `${deltaText} · ${suffix}` : deltaText;
};
