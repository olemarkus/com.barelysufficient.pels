import { PLAN_REASON_CODES, type DeviceReason } from '../../../shared-domain/src/planReasonSemantics.ts';

export type TimedPlanDevice = {
  id?: string;
  plannedState?: string;
  reason: DeviceReason;
};

export type DisplayPlanDeviceSnapshot<Device extends TimedPlanDevice = TimedPlanDevice> = Device & {
  displayCountdownTotalSec?: number;
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

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const resolveCountdownTotalSec = (reason: TimedDeviceReason): number | undefined => {
  if (!isFiniteNumber(reason.countdownTotalSec) || reason.countdownTotalSec <= 0) return undefined;
  return Math.ceil(reason.countdownTotalSec);
};

const resolveCountdownRemainingSec = (
  reason: TimedDeviceReason,
  snapshotGeneratedAtMs: number,
  nowMs: number,
): number => {
  const countdownTotalSec = resolveCountdownTotalSec(reason);
  if (isFiniteNumber(reason.countdownStartedAtMs) && countdownTotalSec !== undefined) {
    const endsAtMs = reason.countdownStartedAtMs + (countdownTotalSec * 1000);
    const absoluteRemainingSec = Math.ceil(Math.max(0, endsAtMs - nowMs) / 1000);
    return Math.min(reason.remainingSec, absoluteRemainingSec);
  }
  const elapsedSec = Math.floor(Math.max(0, nowMs - snapshotGeneratedAtMs) / 1000);
  return reason.remainingSec - elapsedSec;
};

const resolveDisplayCountdownTotalSec = (
  reason: DeviceReason,
  displayReason: DeviceReason,
): number | undefined => {
  if (!hasTimedReason(reason) || !hasTimedReason(displayReason)) return undefined;
  const countdownTotalSec = resolveCountdownTotalSec(reason);
  if (countdownTotalSec === undefined) return undefined;
  return Math.max(countdownTotalSec, displayReason.remainingSec);
};

const getExpiredShedReason = (reason: TimedDeviceReason): DeviceReason => {
  switch (reason.code) {
    case PLAN_REASON_CODES.activationBackoff:
    case PLAN_REASON_CODES.cooldownRestore:
    case PLAN_REASON_CODES.restorePending:
      return { code: PLAN_REASON_CODES.restoreThrottled };
    case PLAN_REASON_CODES.headroomCooldown:
    case PLAN_REASON_CODES.meterSettling:
      return { code: PLAN_REASON_CODES.waitingForOtherDevices };
    case PLAN_REASON_CODES.cooldownShedding:
      return { code: PLAN_REASON_CODES.sheddingActive, detail: null };
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
};

const getExpiredDisplayReason = (reason: TimedDeviceReason, device: TimedPlanDevice): DeviceReason => {
  if (device.plannedState === 'shed') return getExpiredShedReason(reason);
  if (device.plannedState === 'inactive') return { code: PLAN_REASON_CODES.inactive, detail: null };
  return { code: PLAN_REASON_CODES.keep, detail: null };
};

export const getDisplayReason = (
  reason: DeviceReason,
  snapshotGeneratedAtMs: number,
  nowMs: number,
  device?: TimedPlanDevice,
): DeviceReason => {
  if (!hasTimedReason(reason)) return reason;
  const remainingSec = resolveCountdownRemainingSec(reason, snapshotGeneratedAtMs, nowMs);
  if (remainingSec <= 0) {
    return device ? getExpiredDisplayReason(reason, device) : { code: PLAN_REASON_CODES.keep, detail: null };
  }
  if (remainingSec === reason.remainingSec) return reason;
  return {
    ...reason,
    remainingSec,
  };
};

export const resolveSnapshotGeneratedAtMs = (plan: TimedPlanSnapshot | null, renderedAtMs: number): number => {
  if (typeof plan?.generatedAtMs === 'number' && Number.isFinite(plan.generatedAtMs)) {
    return plan.generatedAtMs;
  }
  return renderedAtMs;
};

export const resolveDisplayPlanDeviceSnapshot = <Device extends TimedPlanDevice>(
  plan: TimedPlanSnapshot | null,
  device: Device,
  renderedAtMs: number,
  nowMs: number,
): DisplayPlanDeviceSnapshot<Device> => {
  const snapshotGeneratedAtMs = resolveSnapshotGeneratedAtMs(plan, renderedAtMs);
  const displayReason = getDisplayReason(device.reason, snapshotGeneratedAtMs, nowMs, device);
  const displayCountdownTotalSec = resolveDisplayCountdownTotalSec(device.reason, displayReason);
  const currentDisplayCountdownTotalSec = (device as DisplayPlanDeviceSnapshot<Device>).displayCountdownTotalSec;
  if (displayReason === device.reason && displayCountdownTotalSec === currentDisplayCountdownTotalSec) {
    return device;
  }
  if (displayCountdownTotalSec === undefined) {
    const { displayCountdownTotalSec: _previousDisplayCountdownTotalSec, ...displayDevice } = (
      device as DisplayPlanDeviceSnapshot<Device>
    );
    return { ...displayDevice, reason: displayReason } as DisplayPlanDeviceSnapshot<Device>;
  }
  return {
    ...device,
    reason: displayReason,
    displayCountdownTotalSec,
  };
};

export const resolveDisplayPlanDevices = <Device extends TimedPlanDevice>(
  plan: TimedPlanSnapshot | null,
  devices: Device[],
  renderedAtMs: number,
  nowMs: number,
): Array<DisplayPlanDeviceSnapshot<Device>> => {
  let changed = false;
  const displayDevices = devices.map((device) => {
    const displayDevice = resolveDisplayPlanDeviceSnapshot(plan, device, renderedAtMs, nowMs);
    if (displayDevice !== device) changed = true;
    return displayDevice;
  });
  return changed ? displayDevices : devices;
};

const hasLiveCountdowns = (plan: TimedPlanSnapshot | null, renderedAtMs: number, nowMs: number): boolean => {
  if (!plan || !Array.isArray(plan.devices)) return false;
  const snapshotGeneratedAtMs = resolveSnapshotGeneratedAtMs(plan, renderedAtMs);
  return plan.devices.some((device) => {
    const displayReason = getDisplayReason(device.reason, snapshotGeneratedAtMs, nowMs, device);
    return hasTimedReason(displayReason) && displayReason.remainingSec > 0;
  });
};

export const planNeedsLiveUpdates = (
  plan: TimedPlanSnapshot | null,
  renderedAtMs: number,
  nowMs: number,
): boolean => (
  typeof plan?.meta?.lastPowerUpdateMs === 'number' || hasLiveCountdowns(plan, renderedAtMs, nowMs)
);
