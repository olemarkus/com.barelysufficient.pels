import type {
  SettingsUiPlanDeviceSnapshot,
  SettingsUiPlanDeviceStarvation,
} from '../../contracts/src/settingsUiApi.js';

export type PlanStarvationTone = 'warn' | 'info' | 'muted';

export type PlanStarvationBadgeView = {
  label: string;
  tone: PlanStarvationTone;
  tooltip: string;
};

const resolveStarvationMinutes = (accumulatedMs: number): number => (
  Math.max(1, Math.floor(accumulatedMs / 60_000))
);

const resolveDurationLabel = (accumulatedMs: number): string => `${resolveStarvationMinutes(accumulatedMs)}m`;

const resolveTone = (cause: SettingsUiPlanDeviceStarvation['cause']): PlanStarvationTone => {
  if (cause === 'capacity') return 'warn';
  if (cause === 'budget') return 'info';
  return 'muted';
};

const resolveTooltip = (starvation: SettingsUiPlanDeviceStarvation): string => {
  const duration = resolveStarvationMinutes(starvation.accumulatedMs);
  if (starvation.cause === 'capacity') {
    return `Below target for ${duration} min while waiting for room to reopen`;
  }
  if (starvation.cause === 'budget') {
    return `Below target for ${duration} min while today's budget is limiting restores`;
  }
  if (starvation.cause === 'manual') {
    return `Below target for ${duration} min while manual control is holding the device`;
  }
  return `Below target for ${duration} min while waiting on external recovery`;
};

export const formatStarvationBadge = (
  starvation: SettingsUiPlanDeviceStarvation | null | undefined,
): PlanStarvationBadgeView | null => {
  if (!starvation?.isStarved) return null;
  return {
    label: `Starved ${resolveDurationLabel(starvation.accumulatedMs)}`,
    tone: resolveTone(starvation.cause),
    tooltip: resolveTooltip(starvation),
  };
};

export const formatStarvationReason = (
  starvation: SettingsUiPlanDeviceStarvation | null | undefined,
): string | null => {
  if (!starvation?.isStarved) return null;
  const duration = resolveStarvationMinutes(starvation.accumulatedMs);
  if (starvation.cause === 'capacity') {
    return `Waiting for room to reopen — ${duration} min below target`;
  }
  if (starvation.cause === 'budget') {
    return `Today's budget is still holding restores — ${duration} min below target`;
  }
  if (starvation.cause === 'manual') {
    return `Manual control is holding this device — ${duration} min below target`;
  }
  return `External recovery is still pending — ${duration} min below target`;
};

export const summarizeStarvation = (
  devices: Array<Pick<SettingsUiPlanDeviceSnapshot, 'starvation'>> | null | undefined,
): string | null => {
  if (!Array.isArray(devices) || devices.length === 0) return null;
  const count = devices
    .map((device) => device.starvation)
    .filter((starvation): starvation is SettingsUiPlanDeviceStarvation => (
      Boolean(starvation?.isStarved && starvation.cause === 'capacity')
    ))
    .length;
  if (count === 0) return null;
  return count === 1 ? '1 device below target' : `${count} devices below target`;
};
