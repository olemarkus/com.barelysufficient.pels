import type { AppContext } from '../../lib/app/appContext';
import type { DeferredObjectivePlanHistoryRecorder } from '../../lib/objectives/deferredObjectives/planHistory';
import { WeatherCollector } from '../../lib/weather/weatherCollector';
import { buildWeatherAdvisorSettings } from '../../lib/weather/weatherSettings';
import { resolveDailyKwh } from '../../lib/weather/dailyKwhResolve';
import { computeEnergySignatureUpdate } from '../../lib/weather/energySignatureService';
import { getRawDevice, getRawFromHomeyApi } from '../../lib/device/transport/managerHomeyApi';
import { getDateKeyInTimeZone } from '../../lib/utils/dateUtils';
import { getLogger } from '../../lib/logging/logger';
import { createWeatherHistoryStore } from '../weatherHistoryStateAdapter';

const LONG_GAP_THRESHOLD_MS = 60 * 60 * 1000;

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
