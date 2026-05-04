import { PLAN_REASON_CODES } from './planReasonSemanticsCore.js';
import { resolvePlanStateKind } from './planStateLabels.js';
import type { DeviceOverviewSnapshot } from './deviceOverview.js';

type TemperatureDevice = DeviceOverviewSnapshot & {
  measuredPowerKw?: number;
  currentTemperature?: number;
  plannedTarget?: number | null;
};

// ─── Chip ─────────────────────────────────────────────────────────────────────

export type TemperatureChip = { label: string; tone: string };

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

const isAboveTarget = (device: TemperatureDevice): boolean => {
  if (typeof device.currentTemperature !== 'number') return false;
  const target = device.plannedTarget ?? null;
  if (typeof target !== 'number') return false;
  return device.currentTemperature > target + 0.4;
};

const isAtTarget = (device: TemperatureDevice): boolean => {
  if (typeof device.currentTemperature !== 'number') return false;
  const target = device.plannedTarget ?? null;
  if (typeof target !== 'number') return false;
  return Math.abs(device.currentTemperature - target) <= 0.4;
};

const resolveConstrainedChip = (reasonCode: string, idleFallback: TemperatureChip): TemperatureChip => {
  if (isWaitingReason(reasonCode)) return { label: 'Waiting', tone: 'held' };
  if (isLimitedReason(reasonCode)) return { label: 'Limited', tone: 'held' };
  return idleFallback;
};

const resolveActiveChip = (device: TemperatureDevice): TemperatureChip => {
  if (isHeating(device)) return { label: 'Heating', tone: 'active' };
  if (isAboveTarget(device)) return { label: 'Above target', tone: 'idle' };
  if (isAtTarget(device)) return { label: 'At target', tone: 'idle' };
  return { label: 'Idle', tone: 'idle' };
};

export const resolveTemperatureChip = (device: TemperatureDevice): TemperatureChip => {
  const kind = resolvePlanStateKind(device);
  const reasonCode = (device.reason as { code?: string } | undefined)?.code ?? '';

  if (kind === 'held') return resolveConstrainedChip(reasonCode, { label: 'Paused', tone: 'held' });
  if (kind === 'idle') return resolveConstrainedChip(reasonCode, { label: 'Idle', tone: 'idle' });
  if (kind === 'resuming') return { label: 'Waiting', tone: 'resuming' };
  if (kind === 'manual') return { label: 'Manual', tone: 'neutral' };
  if (kind === 'unavailable') return { label: 'Unavailable', tone: 'warning' };
  if (kind === 'unknown') return { label: 'Unknown', tone: 'neutral' };
  return resolveActiveChip(device);
};

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
  delta: number,
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
  if (kind === 'active') return delta > 0.2 ? 'PELS allows heating' : 'no heating needed';
  return null;
};

export const resolveTemperatureReasonLine = (device: TemperatureDevice): string | null => {
  const { currentTemperature, plannedTarget } = device;
  if (typeof currentTemperature !== 'number' || typeof plannedTarget !== 'number') return null;

  const delta = plannedTarget - currentTemperature;
  const reasonCode = (device.reason as { code?: string } | undefined)?.code ?? '';
  const kind = resolvePlanStateKind(device);
  const deltaText = resolveDeltaText(delta);
  const suffix = resolveReasonSuffix(kind, reasonCode, delta);

  return suffix !== null ? `${deltaText} · ${suffix}` : deltaText;
};
