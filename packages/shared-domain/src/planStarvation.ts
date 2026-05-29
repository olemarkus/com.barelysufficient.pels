import type {
  SettingsUiPlanDeviceSnapshot,
  SettingsUiPlanDeviceStarvation,
} from '../../contracts/src/settingsUiApi';

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

const resolveBadgeLabel = (cause: SettingsUiPlanDeviceStarvation['cause']): string => {
  if (cause === 'capacity') return 'Low power';
  if (cause === 'budget') return 'Budget limited';
  if (cause === 'manual') return 'Manual hold';
  return 'Waiting';
};

const resolveStarvationMessage = (
  cause: SettingsUiPlanDeviceStarvation['cause'],
  options: { manualSubject: 'the device' | 'this device' },
): string => {
  if (cause === 'capacity') {
    return 'Waiting for available power';
  }
  if (cause === 'budget') {
    return "Limited to stay within today's budget";
  }
  if (cause === 'manual') {
    return `Manual control is holding ${options.manualSubject}`;
  }
  return 'Waiting on external service';
};

export const formatStarvationBadge = (
  starvation: SettingsUiPlanDeviceStarvation | null | undefined,
): PlanStarvationBadgeView | null => {
  if (!starvation?.isStarved) return null;
  return {
    label: resolveBadgeLabel(starvation.cause),
    tone: resolveTone(starvation.cause),
    tooltip: resolveStarvationMessage(starvation.cause, { manualSubject: 'the device' }),
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
  return count === 1 ? '1 device limited' : `${count} devices limited`;
};
