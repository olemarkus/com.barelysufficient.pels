import type { AppContext } from '../../lib/app/appContext';
import type { WeatherAdvisorReadout } from '../../packages/contracts/src/weatherAdvisorTypes';
import type { WeatherCollector } from '../../lib/weather/weatherCollector';
import { buildWeatherAdvisorReadout } from '../../lib/weather/weatherAdvisorReadout';
import { buildWeatherAdvisorSettings } from '../../lib/weather/weatherSettings';
import { getRawDevice } from '../../lib/device/transport/managerHomeyApi';
import { readDeviceTemperature } from '../../lib/weather/weatherDeviceRead';

type DailyBudgetService = NonNullable<AppContext['dailyBudgetService']>;

/**
 * Wires the pure readout builder (`lib/weather/weatherAdvisorReadout`) to the
 * app: resolves each device's name AND its live temperature over the transport's
 * REST client, reads the active daily budget from its owner and the power-limit
 * settings from app configuration, and hands the collector's live state in. The
 * ON-DEMAND temperature read is what
 * lets the Settings picker validity line confirm a just-picked device
 * immediately — the collector's cached sample is cleared on the restart a
 * selection change triggers, so it can't be trusted right after a pick.
 * Answers `inactive` when the flag is off or the collector is not wired — the
 * settings UI renders no weather surface for that member.
 */
export async function assembleWeatherAdvisorReadout(
  ctx: Pick<AppContext, 'homey' | 'getNow' | 'getTimeZone' | 'capacitySettings'>,
  collector: WeatherCollector,
  dailyBudget: DailyBudgetService,
): Promise<WeatherAdvisorReadout> {
  const settings = buildWeatherAdvisorSettings({ settings: ctx.homey.settings });
  if (!settings.enabled) return { kind: 'inactive' };
  // The forecast comes from a direct MET Norway fetch, not a device — only the
  // outdoor (historical) device is read here, for its name + live validity line.
  const outdoor = await readDevice(settings.outdoorDeviceId);
  const currentDailyBudgetKwh = dailyBudget.getAppliedBudgetKwh();
  // Validity uses ONLY the on-demand read (which reads the currently-selected
  // device id), never the collector's device-unstamped cache: right after a
  // selection change the cache may still hold the PREVIOUS device's sample, and
  // spreading that under the new device's id would falsely confirm a device that
  // is actually unreadable. A transient on-demand miss honestly shows
  // "unreadable" for that one fetch and self-heals — strictly safer than a
  // wrong-device "Reading … now".
  return buildWeatherAdvisorReadout({
    settings,
    state: collector.getHistoryStateSnapshot(),
    backfillRunning: collector.isBackfillRunning(),
    ...(outdoor.name !== undefined ? { outdoorDeviceName: outdoor.name } : {}),
    ...(outdoor.temperatureC !== undefined ? { currentOutdoorTempC: outdoor.temperatureC } : {}),
    ...(currentDailyBudgetKwh !== undefined ? { currentDailyBudgetKwh } : {}),
    dailyBudgetEnabled: dailyBudget.isEnabled(),
    powerLimitSettings: ctx.capacitySettings,
    nowMs: ctx.getNow().getTime(),
    timeZone: ctx.getTimeZone(),
  });
}

/**
 * One on-demand read per device: its name (decoration) and its current bare
 * `measure_temperature` (the picker validity line). A transient read failure
 * must not fail the readout — both fields fall back to undefined.
 */
async function readDevice(
  deviceId: string | undefined,
): Promise<{ name?: string; temperatureC?: number }> {
  if (!deviceId) return {};
  try {
    const device = await getRawDevice(deviceId);
    return {
      name: typeof device.name === 'string' ? device.name : undefined,
      temperatureC: readDeviceTemperature(device),
    };
  } catch {
    return {};
  }
}
