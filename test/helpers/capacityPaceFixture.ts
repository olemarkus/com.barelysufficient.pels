import { computeDynamicSoftLimit } from '../../lib/plan/planBudget';
import { CapacityDrainStart } from '../../lib/plan/capacityDrainStart';
import { resolveUsableCapacityKWh } from '../../lib/power/capacityModel';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { getHourBucketKey } from '../../lib/utils/hourBuckets';
import type { PowerLimitSettings } from '../../packages/contracts/src/capacitySettings';

/**
 * A power tracker whose current hour leaves exactly `paceKw` of capacity pace
 * under `settings` at `nowMs`, so a spec gets the pace it is about from the real
 * computation (`computeDynamicSoftLimit`) instead of forcing it past it.
 *
 * The pace is the hour's remaining kWh over its remaining hours, so the fixture
 * books the hour's used kWh that leaves that much: `used = budget - pace × hours`.
 * A pace the clock cannot reach (above what an empty hour allows at `nowMs`, or a
 * 15-minute period, which this fixture does not model) throws instead of
 * silently giving a different one; move the spec's clock or its limit.
 */
export const withCapacityPace = (
  tracker: PowerTrackerState,
  settings: PowerLimitSettings,
  paceKw: number,
  nowMs: number = Date.now(),
): PowerTrackerState => {
  if (settings.periodMinutes !== 60) {
    throw new Error('withCapacityPace models the 60-minute capacity period only');
  }
  const bucketKey = getHourBucketKey(nowMs);
  const emptyHour = { ...tracker, buckets: { ...tracker.buckets, [bucketKey]: 0 } };
  const budgetKWh = resolveUsableCapacityKWh(settings);
  // As a fresh build resolves it: from the tracker's latched draw.
  const drainStart = new CapacityDrainStart().startFor(settings, tracker, nowMs);
  const emptyPaceKw = computeDynamicSoftLimit(settings, emptyHour, nowMs, drainStart).allowedKw;
  if (paceKw > emptyPaceKw + 1e-9) {
    throw new Error(`A ${paceKw} kW pace is out of reach at this clock (an empty hour allows ${emptyPaceKw} kW)`);
  }
  const remainingHours = paceHours(settings, tracker, nowMs);
  const usedKWh = landOnPace(
    Math.max(0, budgetKWh - paceKw * remainingHours),
    paceKw,
    (used) => computeDynamicSoftLimit(
      settings, { ...tracker, buckets: { ...tracker.buckets, [bucketKey]: used } }, nowMs, drainStart,
    ).allowedKw,
  );
  return { ...tracker, buckets: { ...tracker.buckets, [bucketKey]: usedKWh } };
};

/**
 * The hours the computation spreads the hour's remaining kWh over at `nowMs`, as
 * it floors them, read off the real pace: a nearly spent hour keeps the pace far
 * under the period-end drain ceiling, so there it is plain kWh over hours.
 */
const paceHours = (settings: PowerLimitSettings, tracker: PowerTrackerState, nowMs: number): number => {
  const budgetKWh = resolveUsableCapacityKWh(settings);
  const usedKWh = budgetKWh * (1 - 1e-3);
  const nearlySpent = { ...tracker, buckets: { ...tracker.buckets, [getHourBucketKey(nowMs)]: usedKWh } };
  const drainStart = new CapacityDrainStart().startFor(settings, tracker, nowMs);
  return (budgetKWh - usedKWh) / computeDynamicSoftLimit(settings, nearlySpent, nowMs, drainStart).allowedKw;
};

/**
 * The input near `estimate` whose pace is exactly `paceKw`, or else the nearest
 * one whose pace is just under it, never over. The division the computation does
 * rounds, and planner thresholds compare exactly, so a spec sitting on one (a
 * 0.2 kW need against a 0.2 kW deadband) must not get a pace a hair ABOVE the one
 * it named. Nudges by single float steps; throws if nothing within 1e-9 kW below.
 */
const landOnPace = (estimate: number, paceKw: number, paceFor: (input: number) => number): number => {
  const step = Number.EPSILON * Math.max(1, Math.abs(estimate));
  let below: { input: number; paceKw: number } | null = null;
  for (let offset = 0; offset <= 64; offset += 1) {
    for (const candidate of [estimate + offset * step, estimate - offset * step]) {
      if (candidate < 0) continue;
      const reached = paceFor(candidate);
      if (reached === paceKw) return candidate;
      if (reached < paceKw && (below === null || reached > below.paceKw)) below = { input: candidate, paceKw: reached };
    }
  }
  if (below !== null && paceKw - below.paceKw <= 1e-9) return below.input;
  throw new Error(`The real capacity pace does not land on ${paceKw} kW near this input (${paceFor(estimate)} kW)`);
};

/**
 * The settings whose hard cap leaves exactly `paceKw` of capacity pace given what
 * the tracker's current hour has already used at `nowMs`. The hour's energy stays
 * as the spec booked it and the allowance moves instead
 * (`limit = used + pace × hours + margin`), for a spec whose hour bucket is itself
 * under test. Both shapes leave the same remaining kWh: that is what a pace is.
 */
export const capacitySettingsForPace = (
  tracker: PowerTrackerState,
  base: PowerLimitSettings,
  paceKw: number,
  nowMs: number = Date.now(),
): PowerLimitSettings => {
  if (base.periodMinutes !== 60) {
    throw new Error('capacitySettingsForPace models the 60-minute capacity period only');
  }
  const usedKWh = Math.max(0, tracker.buckets?.[getHourBucketKey(nowMs)] ?? 0);
  const remainingHours = paceHours(base, tracker, nowMs);
  const limitKw = landOnPace(
    base.marginKw + usedKWh + paceKw * remainingHours,
    paceKw,
    (limit) => computeDynamicSoftLimit(
      { ...base, limitKw: limit }, tracker, nowMs,
      new CapacityDrainStart().startFor({ ...base, limitKw: limit }, tracker, nowMs),
    ).allowedKw,
  );
  return { ...base, limitKw };
};

/**
 * `withCapacityPace` on a running app: shapes its tracker so the next plan the
 * app builds runs on `paceKw`. Call it before the power sample that rebuilds; a
 * spec that later replaces the whole tracker replaces the shaping with it.
 */
export const steerCapacityPace = (
  app: { powerTracker: PowerTrackerState; readonly capacitySettings: PowerLimitSettings },
  paceKw: number,
): void => {
  // eslint-disable-next-line no-param-reassign -- the app's tracker is the input under test
  app.powerTracker = withCapacityPace(app.powerTracker, app.capacitySettings, paceKw);
};
