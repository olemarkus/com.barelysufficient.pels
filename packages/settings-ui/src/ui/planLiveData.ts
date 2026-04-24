import { PLAN_REASON_CODES, type DeviceReason } from '../../../shared-domain/src/planReasonSemantics.ts';

export type TimedPlanDevice = {
  reason: DeviceReason;
};

export type TimedPlanSnapshot = {
  generatedAtMs?: number;
  meta?: {
    lastPowerUpdateMs?: number;
  };
  devices?: TimedPlanDevice[];
};

type TimedDeviceReason = Extract<DeviceReason, { remainingSec: number }>;

export const hasTimedReason = (reason: DeviceReason): reason is TimedDeviceReason => (
  typeof (reason as { remainingSec?: unknown }).remainingSec === 'number'
);

export const getDisplayReason = (
  reason: DeviceReason,
  snapshotGeneratedAtMs: number,
  nowMs: number,
): DeviceReason => {
  if (!hasTimedReason(reason)) return reason;
  const remainingSec = reason.remainingSec - Math.floor((nowMs - snapshotGeneratedAtMs) / 1000);
  if (reason.code === PLAN_REASON_CODES.meterSettling && remainingSec <= 0) {
    return { code: PLAN_REASON_CODES.keep, detail: null };
  }
  return {
    ...reason,
    remainingSec: Math.max(0, remainingSec),
  };
};

export const resolveSnapshotGeneratedAtMs = (plan: TimedPlanSnapshot | null, renderedAtMs: number): number => {
  if (typeof plan?.generatedAtMs === 'number' && Number.isFinite(plan.generatedAtMs)) {
    return plan.generatedAtMs;
  }
  return renderedAtMs;
};

const hasLiveCountdowns = (plan: TimedPlanSnapshot | null, renderedAtMs: number): boolean => {
  if (!plan || !Array.isArray(plan.devices)) return false;
  const snapshotGeneratedAtMs = resolveSnapshotGeneratedAtMs(plan, renderedAtMs);
  return plan.devices.some((device) => {
    if (!hasTimedReason(device.reason)) return false;
    const displayReason = getDisplayReason(device.reason, snapshotGeneratedAtMs, Date.now());
    return hasTimedReason(displayReason) && displayReason.remainingSec > 0;
  });
};

export const planNeedsLiveUpdates = (plan: TimedPlanSnapshot | null, renderedAtMs: number): boolean => (
  typeof plan?.meta?.lastPowerUpdateMs === 'number' || hasLiveCountdowns(plan, renderedAtMs)
);
