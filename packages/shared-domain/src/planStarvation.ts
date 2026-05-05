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

const resolveTone = (cause: SettingsUiPlanDeviceStarvation['cause']): PlanStarvationTone => {
  if (cause === 'capacity') return 'warn';
  if (cause === 'budget') return 'info';
  return 'muted';
};

const resolveTooltip = (starvation: SettingsUiPlanDeviceStarvation): string => {
  return resolveStarvationMessage(starvation.cause, { manualSubject: 'the device' });
};

const resolveStarvationMessage = (
  cause: SettingsUiPlanDeviceStarvation['cause'],
  options: { manualSubject: 'the device' | 'this device' },
): string => {
  if (cause === 'capacity') {
    return 'Starved while waiting for available power';
  }
  if (cause === 'budget') {
    return "Starved while today's budget is limiting service";
  }
  if (cause === 'manual') {
    return `Starved while manual control is holding ${options.manualSubject}`;
  }
  return 'Starved while waiting on external service';
};

export const formatStarvationBadge = (
  starvation: SettingsUiPlanDeviceStarvation | null | undefined,
): PlanStarvationBadgeView | null => {
  if (!starvation?.isStarved) return null;
  return {
    label: 'Starved',
    tone: resolveTone(starvation.cause),
    tooltip: resolveTooltip(starvation),
  };
};

export const formatStarvationReason = (
  starvation: SettingsUiPlanDeviceStarvation | null | undefined,
): string | null => {
  if (!starvation?.isStarved) return null;
  return resolveStarvationMessage(starvation.cause, { manualSubject: 'this device' });
};

export const summarizeStarvation = (
  devices: Array<Pick<SettingsUiPlanDeviceSnapshot, 'starvation'>> | null | undefined,
): string | null => {
  if (!Array.isArray(devices) || devices.length === 0) return null;
  const count = devices
    .map((device) => device.starvation)
    .filter((starvation): starvation is SettingsUiPlanDeviceStarvation => (
      Boolean(starvation?.isStarved)
    ))
    .length;
  if (count === 0) return null;
  return count === 1 ? '1 device starved' : `${count} devices starved`;
};
