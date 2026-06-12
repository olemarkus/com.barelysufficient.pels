import type { AppContext } from '../../lib/app/appContext';
import { WeatherCollector } from '../../lib/weather/weatherCollector';
import { buildWeatherAdvisorSettings } from '../../lib/weather/weatherSettings';
import { resolveDailyKwh } from '../../lib/weather/dailyKwhResolve';
import { computeEnergySignatureUpdate } from '../../lib/weather/energySignatureService';
import { getRawDevice, getRawFromHomeyApi } from '../../lib/device/transport/managerHomeyApi';
import { getLogger } from '../../lib/logging/logger';
import { createWeatherHistoryStore } from '../weatherHistoryStateAdapter';

const LONG_GAP_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * Wires the hidden weather-history collector. Device reads ride on the
 * transport's REST client (initialized during `initDeviceManager`, before this
 * factory runs); kWh totals are injected as flat getters so `lib/weather`
 * never imports `lib/power`.
 */
export function createWeatherCollector(
  ctx: Pick<AppContext, 'homey' | 'powerTracker' | 'getNow' | 'getTimeZone' | 'capacitySettings'>,
): WeatherCollector {
  const logger = getLogger('weather');
  return new WeatherCollector({
    store: createWeatherHistoryStore(ctx.homey),
    readDevice: (deviceId) => getRawDevice(deviceId),
    fetchInsights: (path) => getRawFromHomeyApi(path),
    getDailyKwh: (dateKey) => resolveDailyKwh({
      dateKey,
      timeZone: ctx.getTimeZone(),
      source: ctx.powerTracker,
    }),
    // The tracker also records sub-hour gaps that merely cross an hour
    // boundary (routine in flow mode); only genuinely long outages should
    // taint a weather day as unreliable, per the WeatherDailyQuality contract.
    getUnreliablePeriods: () => (ctx.powerTracker.unreliablePeriods ?? [])
      .filter((period) => period.end - period.start > LONG_GAP_THRESHOLD_MS),
    getSettings: () => buildWeatherAdvisorSettings({ settings: ctx.homey.settings }),
    getNowMs: () => ctx.getNow().getTime(),
    getTimeZone: () => ctx.getTimeZone(),
    recomputeDerived: (state) => computeEnergySignatureUpdate(state, {
      getNowMs: () => ctx.getNow().getTime(),
      getTimeZone: () => ctx.getTimeZone(),
      getCapacityLimitKw: () => {
        const limitKw = ctx.capacitySettings.limitKw;
        return Number.isFinite(limitKw) && limitKw > 0 ? limitKw : undefined;
      },
      logger,
    }),
    logger,
  });
}
