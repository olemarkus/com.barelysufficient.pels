import type { AppContext } from '../../lib/app/appContext';
import type { DeferredObjectivePlanHistoryRecorder } from '../../lib/objectives/deferredObjectives/planHistory';
import { WeatherCollector } from '../../lib/weather/weatherCollector';
import { buildWeatherAdvisorSettings } from '../../lib/weather/weatherSettings';
import { resolveDailyKwh } from '../../lib/weather/dailyKwhResolve';
import { computeEnergySignatureUpdate } from '../../lib/weather/energySignatureService';
import { fetchMetForecast, type MetForecastFetchResult } from '../../lib/weather/metForecast';
import { getRawDevice, getRawFromHomeyApi } from '../../lib/device/transport/managerHomeyApi';
import { getDateKeyInTimeZone } from '../../lib/utils/dateUtils';
import { normalizeError } from '../../lib/utils/errorUtils';
import { getLogger } from '../../lib/logging/logger';
import { createWeatherHistoryStore } from '../weatherHistoryStateAdapter';

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

/**
 * Reads the hub's coordinates from the Homey geolocation manager, defensively:
 * the manager (or its getters) may be absent if the SDK has not initialized it
 * or the app lacks the permission edge-case, so probe method existence before
 * calling — a raw `getLatitude()` on an undefined manager would throw a
 * TypeError out of the collector's refresh loop. Returns undefined when the
 * manager/methods are missing or the coords aren't finite; the caller then maps
 * that to `no_location` (skipping the fetch) instead of crashing.
 */
export function readHubCoordinates(geolocation: unknown): { latitude: number; longitude: number } | undefined {
  if (typeof geolocation !== 'object' || geolocation === null) return undefined;
  const manager = geolocation as { getLatitude?: unknown; getLongitude?: unknown };
  if (typeof manager.getLatitude !== 'function' || typeof manager.getLongitude !== 'function') return undefined;
  const latitude = (manager.getLatitude as () => unknown)();
  const longitude = (manager.getLongitude as () => unknown)();
  if (typeof latitude !== 'number' || !Number.isFinite(latitude)) return undefined;
  if (typeof longitude !== 'number' || !Number.isFinite(longitude)) return undefined;
  return { latitude, longitude };
}

/**
 * Did a deadline-bound smart task miss on this local day BECAUSE the daily
 * budget ran out? This is the unambiguous censoring signal the fit excludes:
 * the device demonstrably wanted energy it could not get. Attributed to the
 * deadline's local day (a rare event; the day before is left to the
 * comfort/capacity signal that drives only the upward lean).
 *
 * The FINAL revision is the causal snapshot — take its whole plan, not a
 * per-field fallback: `dailyBudgetExhaustedBucketCount` is omitted when zero,
 * so a `finalPlan ? .count ?? originalPlan.count` mix would resurrect a stale
 * positive count from a richer original plan even when the final run hit no
 * budget exhaustion. originalPlan is used only when finalPlan is wholly absent.
 *
 * Best-effort by design: on a boot that slept past midnight, the weather
 * catch-up rollup can read the history before the deferred-objective clock has
 * finalized a just-missed deadline, so that one slept-through day may roll up
 * without this flag. Accepted for v1 — the impact is a bounded one-day
 * UNDER-exclusion (the censored day stays in the fit, the conservative
 * direction), the comfort/capacity covariate from diagnostics still records on
 * that day, and forcing a synchronous miss-finalization ahead of the weather
 * catch-up is disproportionate boot-order risk for a hidden advisory signal.
 */
export function deadlineMissedToBudgetOnDay(
  recorder: DeferredObjectivePlanHistoryRecorder | undefined,
  dateKey: string,
  timeZone: string,
): boolean {
  if (!recorder) return false;
  return recorder.getHistorySnapshot().entries.some((entry) => {
    if (entry.outcome !== 'missed') return false;
    const causalPlan = entry.finalPlan ?? entry.originalPlan;
    if ((causalPlan?.dailyBudgetExhaustedBucketCount ?? 0) <= 0) return false;
    return getDateKeyInTimeZone(new Date(entry.deadlineAtMs), timeZone) === dateKey;
  });
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
    | 'dailyBudgetService'
  >,
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
    // PELS-managed = the controlled set the historical split is summed from.
    isManagedDevice: (deviceId) => ctx.resolveManagedState(deviceId),
    // Composed from two planner-orthogonal sources so lib/weather sees only
    // primitives: diagnostics (comfort/capacity deficit durations) and the
    // smart-task history (deadline-miss-to-budget). Absent services → {}.
    getDaySuppression: (dateKey) => {
      const totals = ctx.deviceDiagnosticsService?.getDaySuppressionTotals(dateKey);
      const deadlineMissedToBudget = deadlineMissedToBudgetOnDay(
        ctx.deferredObjectivePlanHistoryRecorder, dateKey, ctx.getTimeZone(),
      );
      return {
        ...(totals !== undefined ? totals : {}),
        ...(deadlineMissedToBudget ? { deadlineMissedToBudget: true } : {}),
      };
    },
    // The tracker also records sub-hour gaps that merely cross an hour
    // boundary (routine in flow mode); only genuinely long outages should
    // taint a weather day as unreliable, per the WeatherDailyQuality contract.
    getUnreliablePeriods: () => (ctx.powerTracker.unreliablePeriods ?? [])
      .filter((period) => period.end - period.start > LONG_GAP_THRESHOLD_MS),
    getSettings: () => buildWeatherAdvisorSettings({ settings: ctx.homey.settings }),
    getNowMs: () => ctx.getNow().getTime(),
    getTimeZone: () => ctx.getTimeZone(),
    // Direct MET Norway fetch for the forecast (replaces the +24h device).
    // Coordinates come from the Homey SDK geolocation manager — guarded so a
    // missing manager/getter or non-finite coords maps to `no_location` (skip the
    // fetch) rather than throwing out of the refresh loop. The User-Agent is built
    // from the app manifest; the collector hands back its cached Last-Modified as
    // ifModifiedSince so MET can answer 304.
    fetchForecast: ({ ifModifiedSince }): Promise<MetForecastFetchResult> => {
      const coords = readHubCoordinates(ctx.homey.geolocation);
      if (!coords) return Promise.resolve({ outcome: 'no_location' });
      return fetchMetForecast({
        latitude: coords.latitude,
        longitude: coords.longitude,
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
