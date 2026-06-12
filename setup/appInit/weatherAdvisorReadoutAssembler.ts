import type { AppContext } from '../../lib/app/appContext';
import type { WeatherAdvisorReadoutPayload } from '../../packages/contracts/src/weatherAdvisorTypes';
import type { WeatherCollector } from '../../lib/weather/weatherCollector';
import { buildWeatherAdvisorReadout } from '../../lib/weather/weatherAdvisorReadout';
import { buildWeatherAdvisorSettings } from '../../lib/weather/weatherSettings';
import { getRawDevice } from '../../lib/device/transport/managerHomeyApi';
import { DAILY_BUDGET_ENABLED, DAILY_BUDGET_KWH } from '../../lib/utils/settingsKeys';

/**
 * Wires the pure readout builder (`lib/weather/weatherAdvisorReadout`) to the
 * app: resolves device names over the transport's REST client, reads the
 * active daily budget + capacity cap from settings, and hands the collector's
 * live state in. Returns null when the flag is off or the collector is not
 * wired — the settings UI treats null as structural absence.
 */
export async function assembleWeatherAdvisorReadout(params: {
  ctx: Pick<AppContext, 'homey' | 'getNow' | 'getTimeZone' | 'capacitySettings'>;
  collector: WeatherCollector | undefined;
}): Promise<WeatherAdvisorReadoutPayload | null> {
  const { ctx, collector } = params;
  const settings = buildWeatherAdvisorSettings({ settings: ctx.homey.settings });
  if (!settings.enabled || !collector) return null;
  const [outdoorDeviceName, forecastDeviceName] = await Promise.all([
    readDeviceName(settings.outdoorDeviceId),
    readDeviceName(settings.forecastDeviceId),
  ]);
  const limitKw = ctx.capacitySettings.limitKw;
  const currentDailyBudgetKwh = resolveDailyBudgetKwh(ctx);
  return buildWeatherAdvisorReadout({
    settings,
    state: collector.getHistoryStateSnapshot(),
    backfillRunning: collector.isBackfillRunning(),
    ...(outdoorDeviceName !== undefined ? { outdoorDeviceName } : {}),
    ...(forecastDeviceName !== undefined ? { forecastDeviceName } : {}),
    ...(currentDailyBudgetKwh !== undefined ? { currentDailyBudgetKwh } : {}),
    ...(Number.isFinite(limitKw) && limitKw > 0 ? { capacityLimitKw: limitKw } : {}),
    nowMs: ctx.getNow().getTime(),
    timeZone: ctx.getTimeZone(),
  });
}

/** Device names are decoration — a transient read failure must not fail the readout. */
async function readDeviceName(deviceId: string | undefined): Promise<string | undefined> {
  if (!deviceId) return undefined;
  try {
    const device = await getRawDevice(deviceId);
    return typeof device.name === 'string' ? device.name : undefined;
  } catch {
    return undefined;
  }
}

function resolveDailyBudgetKwh(
  ctx: Pick<AppContext, 'homey'>,
): number | undefined {
  if (ctx.homey.settings.get(DAILY_BUDGET_ENABLED) !== true) return undefined;
  const kwh = ctx.homey.settings.get(DAILY_BUDGET_KWH) as unknown;
  return typeof kwh === 'number' && Number.isFinite(kwh) && kwh > 0 ? kwh : undefined;
}
