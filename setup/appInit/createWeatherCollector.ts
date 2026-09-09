import type { AppContext } from '../../lib/app/appContext';
import { WeatherCollector } from '../../lib/weather/weatherCollector';
import { buildWeatherAdvisorSettings } from '../../lib/weather/weatherSettings';
import { resolveDailyKwh } from '../../lib/weather/dailyKwhResolve';
import { computeEnergySignatureUpdate } from '../../lib/weather/energySignatureService';
import { fetchMetForecast, type MetForecastFetchResult } from '../../lib/weather/metForecast';
import { getRawDevice, getRawFromHomeyApi } from '../../lib/device/transport/managerHomeyApi';
import { resolveDeadlineMissSuppression } from '../../lib/weather/deadlineMissBudgetDay';
import { normalizeError } from '../../lib/utils/errorUtils';
import { getLogger } from '../../lib/logging/logger';
import { readMainMeterSelection } from '../mainMeterSettings';
import { readConfiguredPowerSource } from '../powerSourceSettings';
import { readWholeHomeMeterScopeSignature } from '../weatherMeterScopeSignature';
import { readHubCoordinates } from '../homeyLocationAdapter';
import { createWeatherHistoryStoreForApp } from './weatherHistoryStore';

const LONG_GAP_THRESHOLD_MS = 60 * 60 * 1000;
/** Fallback contact for the MET User-Agent when the manifest has no homepage/support. */
const FALLBACK_CONTACT_URL = 'https://github.com/olemarkus/com.barelysufficient.pels';

/**
 * Builds the MET-mandatory User-Agent `"<app-id>/<version> (<contact>)"` from the
 * Homey app manifest (app.json), falling back to a stable id/version and the
 * GitHub repo when a field is missing. MET returns 403 without a real UA.
 */
export function buildMetUserAgent(manifest: unknown): string {
  const blob = (typeof manifest === 'object' && manifest !== null ? manifest : {}) as Record<string, unknown>;
  const id = typeof blob.id === 'string' && blob.id.length > 0 ? blob.id : 'com.barelysufficient.pels';
  const version = typeof blob.version === 'string' && blob.version.length > 0 ? blob.version : '0.0.0';
  const homepage = typeof blob.homepage === 'string' && blob.homepage.length > 0 ? blob.homepage : undefined;
  const support = typeof blob.support === 'string' && blob.support.length > 0 ? blob.support : undefined;
  return `${id}/${version} (${homepage ?? support ?? FALLBACK_CONTACT_URL})`;
}

/** Flow trigger fired when the weather insight auto-applies a daily budget. */
const DAILY_BUDGET_WEATHER_ADJUSTED_TRIGGER_ID = 'daily_budget_weather_adjusted';

/**
 * Shapes the auto-apply numbers into the trigger's token bag: budget to 0.1 kWh
 * (the setting's step), forecast temperature to whole °C (how the UI shows it).
 * Returns `null` when either value is non-finite — a number token cannot be null
 * and would coerce to a real-looking `0`, so we skip firing rather than report a
 * misleading 0 kWh / 0 °C.
 */
export function buildWeatherBudgetAdjustedTokens(
  info: { budgetKwh: number; forecastMeanTempC: number },
): { budget_kwh: number; forecast_temperature: number } | null {
  if (!Number.isFinite(info.budgetKwh) || !Number.isFinite(info.forecastMeanTempC)) return null;
  return {
    budget_kwh: Math.round(info.budgetKwh * 10) / 10,
    forecast_temperature: Math.round(info.forecastMeanTempC),
  };
}

/**
 * Wires the hidden weather-history collector. Device reads ride on the
 * transport's REST client (initialized during `initDeviceManager`, before this
 * factory runs); kWh totals are injected as flat getters so `lib/weather`
 * never imports `lib/power`.
 */
export function createWeatherCollector(
  ctx: Pick<
    AppContext,
    'homey' | 'powerTracker' | 'getNow' | 'getTimeZone' | 'capacitySettings'
    | 'deviceDiagnosticsService' | 'deferredObjectivePlanHistoryRecorder' | 'resolveManagedState'
    | 'dailyBudgetService' | 'getUserdataDatabase'
  >,
): WeatherCollector {
  const logger = getLogger('weather');
  return new WeatherCollector({
    store: createWeatherHistoryStoreForApp(ctx),
    readDevice: (deviceId) => getRawDevice(deviceId),
    fetchInsights: (path) => getRawFromHomeyApi(path),
    getDailyKwh: (dateKey) => resolveDailyKwh({
      dateKey,
      timeZone: ctx.getTimeZone(),
      source: ctx.powerTracker,
    }),
    // PELS-managed = the controlled set the historical split is summed from.
    isManagedDevice: (deviceId) => ctx.resolveManagedState(deviceId),
    // Composed from two planner-orthogonal sources so lib/weather sees only
    // primitives: diagnostics (device deficit durations and the day-close denial)
    // and the smart-task history (deadline misses the budget caused). Absent
    // services → {}. The two contribute disjoint keys by construction —
    // `DeviceDiagnosticsDaySuppressionTotals` declares neither deadline field —
    // so the spread order below cannot silently drop one producer's evidence,
    // and an overlap introduced later fails to typecheck rather than merging.
    getDaySuppression: (dateKey) => {
      const totals = ctx.deviceDiagnosticsService?.getDaySuppressionTotals(dateKey);
      const entries = ctx.deferredObjectivePlanHistoryRecorder?.getHistorySnapshot().entries ?? [];
      return {
        ...(totals !== undefined ? totals : {}),
        ...resolveDeadlineMissSuppression(entries, dateKey, ctx.getTimeZone()),
      };
    },
    // The tracker also records sub-hour gaps that merely cross an hour
    // boundary (routine in flow mode); only genuinely long outages should
    // taint a weather day as unreliable, per the WeatherDailyQuality contract.
    getUnreliablePeriods: () => (ctx.powerTracker.unreliablePeriods ?? [])
      .filter((period) => period.end - period.start > LONG_GAP_THRESHOLD_MS),
    // The daily budget in force right now. The collector only stamps it onto a
    // day that just closed, so the value it reads still describes that day (the
    // midnight rollup runs before auto-apply writes the new one).
    getAppliedDailyBudgetKwh: () => ctx.dailyBudgetService?.getAppliedBudgetKwh(),
    getSettings: () => buildWeatherAdvisorSettings({ settings: ctx.homey.settings }),
    // Meter-scope fingerprint for the start()-time invalidation reconcile —
    // composed here (setup) because lib/weather must not read the homes config.
    readMeterScopeSignature: () => readWholeHomeMeterScopeSignature(ctx.homey),
    // The same resolved selection the fingerprint's Main arm is built from,
    // read fresh at election time: it confines the historical-kWh election to
    // the explicitly selected meter so a re-armed backfill cannot re-elect the
    // previous meter against the retained tracker history.
    readMainMeterSelection: () => readMainMeterSelection(ctx.homey.settings),
    // The same resolved source the fingerprint's source arm is built from,
    // read fresh at election time: it gates the meter election off entirely
    // for the Flow producer (see `weatherCollectorDeps.ts`).
    readPowerSource: () => readConfiguredPowerSource(ctx.homey.settings),
    getNowMs: () => ctx.getNow().getTime(),
    getTimeZone: () => ctx.getTimeZone(),
    // Direct MET Norway fetch for the forecast (replaces the +24h device).
    // Coordinates come from the existing owner-authenticated Homey Web API
    // client. The adapter distinguishes an absent location from an API failure;
    // both preserve the prior MET cache through the collector's fallback chain.
    // The collector hands back its cached Last-Modified as ifModifiedSince so
    // MET can answer 304.
    fetchForecast: async ({ ifModifiedSince }): Promise<MetForecastFetchResult> => {
      const location = await readHubCoordinates();
      if (location.kind === 'unavailable') return { outcome: location.outcome };
      const { coordinates } = location;
      return fetchMetForecast({
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        timeZone: ctx.getTimeZone(),
        nowMs: ctx.getNow().getTime(),
        userAgent: buildMetUserAgent(ctx.homey.manifest),
        ...(ifModifiedSince !== undefined ? { ifModifiedSince } : {}),
        errorLog: (...args) => logger.warn({ event: 'weather_met_forecast_fetch', detail: args }),
      });
    },
    recomputeDerived: (state) => computeEnergySignatureUpdate(state, {
      getNowMs: () => ctx.getNow().getTime(),
      getTimeZone: () => ctx.getTimeZone(),
      getCapacityLimitKw: () => {
        const limitKw = ctx.capacitySettings.limitKw;
        return Number.isFinite(limitKw) && limitKw > 0 ? limitKw : undefined;
      },
      logger,
    }),
    // Auto-apply seam: lib/weather never imports lib/dailyBudget, so the apply
    // goes through this flat callback. Resolved lazily — dailyBudgetService is
    // constructed after the collector but before any midnight rollup fires.
    applySuggestedDailyBudget: (kwh) => ctx.dailyBudgetService?.applyAutoSuggestedBudget(kwh) ?? false,
    // Fire-and-forget the Flow trigger once the auto-apply lands. lib/weather
    // hands back the values that drove the change; we shape the tokens and fire.
    onDailyBudgetAutoApplied: (info) => {
      const tokens = buildWeatherBudgetAdjustedTokens(info);
      if (!tokens) return;
      const card = ctx.homey.flow?.getTriggerCard?.(DAILY_BUDGET_WEATHER_ADJUSTED_TRIGGER_ID);
      if (!card) return;
      card.trigger(tokens).catch((error: unknown) => {
        logger.warn({ event: 'daily_budget_weather_adjusted_fire_failed', err: normalizeError(error) });
      });
    },
    logger,
  });
}
