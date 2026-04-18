import type { DeviceReason } from '../../../shared-domain/src/planReasonSemantics.ts';

export type TimedPlanDevice = {
  reason?: DeviceReason;
};

export type TimedPlanSnapshot = {
  meta?: {
    lastPowerUpdateMs?: number;
  };
  devices?: TimedPlanDevice[];
};

type TimedDeviceReason = Extract<DeviceReason, { remainingSec: number }>;

export const hasTimedReason = (reason: DeviceReason | undefined): reason is TimedDeviceReason => (
  Boolean(reason && typeof (reason as { remainingSec?: unknown }).remainingSec === 'number')
);

export const getDisplayReason = (
  reason: DeviceReason | undefined,
  renderedAtMs: number,
  nowMs: number,
): DeviceReason | undefined => {
  if (!hasTimedReason(reason)) return reason;
  return {
    ...reason,
    remainingSec: Math.max(0, reason.remainingSec - Math.floor((nowMs - renderedAtMs) / 1000)),
  };
};

export const getEarliestCountdownExpiryMs = (plan: TimedPlanSnapshot | null, renderedAtMs: number): number | null => {
  if (!plan || !Array.isArray(plan.devices)) return null;
  let earliestExpiryMs: number | null = null;
  plan.devices.forEach((device) => {
    if (!hasTimedReason(device.reason) || device.reason.remainingSec <= 0) return;
    const expiryMs = renderedAtMs + (device.reason.remainingSec * 1000);
    earliestExpiryMs = earliestExpiryMs === null ? expiryMs : Math.min(earliestExpiryMs, expiryMs);
  });
  return earliestExpiryMs;
};

export const planNeedsLiveUpdates = (plan: TimedPlanSnapshot | null, renderedAtMs: number): boolean => (
  typeof plan?.meta?.lastPowerUpdateMs === 'number' || getEarliestCountdownExpiryMs(plan, renderedAtMs) !== null
);
