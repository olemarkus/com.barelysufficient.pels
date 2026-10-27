import type { ContinuousBatteryPlanConfigs } from '../../packages/contracts/src/continuousBatteryPlan';
import {
  CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY, parseContinuousBatteryPlanConfigs,
} from '../../packages/shared-domain/src/settings/continuousBatteryPlan';
import type { SettingsPort } from '../ports/homeyRuntime';
import { readSettingsKeyList } from '../utils/settingsKeyList';

/** Only this settings boundary distinguishes never written from an unavailable read. */
export function readContinuousBatteryPlanConfigs(settings: SettingsPort): ContinuousBatteryPlanConfigs | null {
  const keys = readSettingsKeyList(settings);
  if (keys.status !== 'resolved') return null;
  if (!keys.keys.includes(CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY)) return {};
  try {
    return parseContinuousBatteryPlanConfigs(settings.get(CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY));
  } catch { return null; }
}
