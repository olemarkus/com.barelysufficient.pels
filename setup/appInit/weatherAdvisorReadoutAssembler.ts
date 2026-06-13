import type { AppContext } from '../../lib/app/appContext';
import type { WeatherAdvisorReadoutPayload } from '../../packages/contracts/src/weatherAdvisorTypes';
import type { WeatherCollector } from '../../lib/weather/weatherCollector';
import { buildWeatherAdvisorReadout } from '../../lib/weather/weatherAdvisorReadout';
import { buildWeatherAdvisorSettings } from '../../lib/weather/weatherSettings';
import { getRawDevice } from '../../lib/device/transport/managerHomeyApi';
import { readDeviceTemperature } from '../../lib/weather/weatherDeviceRead';
import { DAILY_BUDGET_ENABLED, DAILY_BUDGET_KWH } from '../../lib/utils/settingsKeys';

/**
 * Wires the pure readout builder (`lib/weather/weatherAdvisorReadout`) to the
 * app: resolves each device's name AND its live temperature over the transport's
 * REST client, reads the active daily budget + capacity cap from settings, and
 * hands the collector's live state in. The ON-DEMAND temperature read is what
 * lets the Settings picker validity line confirm a just-picked device
 * immediately — the collector's cached sample is cleared on the restart a
 * selection change triggers, so it can't be trusted right after a pick.
 * Returns null when the flag is off or the collector is not wired — the
 * settings UI treats null as structural absence.
 */
export async function assembleWeatherAdvisorReadout(params: {
  ctx: Pick<AppContext, 'homey' | 'getNow' | 'getTimeZone' | 'capacitySettings'>;
  collector: WeatherCollector | undefined;
}): Promise<WeatherAdvisorReadoutPayload | null> {
  const { ctx, collector } = params;
  const settings = buildWeatherAdvisorSettings({ settings: ctx.homey.settings });
  if (!settings.enabled || !collector) return null;
  const [outdoor, forecast] = await Promise.all([
    readDevice(settings.outdoorDeviceId),
    readDevice(settings.forecastDeviceId),
  ]);
  const limitKw = ctx.capacitySettings.limitKw;
  const currentDailyBudgetKwh = resolveDailyBudgetKwh(ctx);
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
    ...(forecast.name !== undefined ? { forecastDeviceName: forecast.name } : {}),
    ...(outdoor.temperatureC !== undefined ? { currentOutdoorTempC: outdoor.temperatureC } : {}),
    ...(forecast.temperatureC !== undefined ? { currentForecastTempC: forecast.temperatureC } : {}),
    ...(currentDailyBudgetKwh !== undefined ? { currentDailyBudgetKwh } : {}),
    ...(Number.isFinite(limitKw) && limitKw > 0 ? { capacityLimitKw: limitKw } : {}),
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

function resolveDailyBudgetKwh(
  ctx: Pick<AppContext, 'homey'>,
): number | undefined {
  if (ctx.homey.settings.get(DAILY_BUDGET_ENABLED) !== true) return undefined;
  const kwh = ctx.homey.settings.get(DAILY_BUDGET_KWH) as unknown;
  return typeof kwh === 'number' && Number.isFinite(kwh) && kwh > 0 ? kwh : undefined;
}
