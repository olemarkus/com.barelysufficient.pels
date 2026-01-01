import type Homey from 'homey';
import type { CapacitySettingsSnapshot } from './appInit';
import { buildCapacitySettingsSnapshot } from './appInit';

export function loadCapacitySettingsFromHomey(params: {
  settings: Homey.App['homey']['settings'];
  current: CapacitySettingsSnapshot;
}): CapacitySettingsSnapshot {
  const { settings, current } = params;
  return buildCapacitySettingsSnapshot({ settings, current });
}
