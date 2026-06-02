// Producer for the smart-tasks widget's LIVE (still-running) trajectory chart.
//
// Sibling to `deferredPlanHistoryChartData.ts` (which serves FINISHED runs).
// Both emit the same flat `DeferredPlanHistoryChartData` shape so the widget's
// SVG renderer has a single code path regardless of whether the tapped task is
// on-going or recently ended. Per `feedback_layering_resolution_in_producer.md`
// the producer resolves the mode + flat point arrays here; the view never
// inspects revisions, rates, or sample internals.
//
// Lives in its own file (alongside the history producer) so each stays under
// the 500-LOC cap and the live/finished concerns don't entangle.
import type {
  DeferredObjectiveActivePlanProgressSampleV1,
  DeferredObjectiveActivePlanV1,
} from '../../contracts/src/deferredObjectiveActivePlans';
import {
  anchorObservedAtStart,
  type DeferredPlanHistoryChartData,
  type DeferredPlanHistoryChartPoint,
  integratePlannedStaircase,
} from './deferredPlanHistoryChartData';

const finiteOrNull = (raw: number | null | undefined): number | null => (
  raw === null || raw === undefined || !Number.isFinite(raw) ? null : raw
);

const pickTarget = (plan: DeferredObjectiveActivePlanV1): number | null => finiteOrNull(
  plan.objectiveKind === 'temperature' ? plan.targetTemperatureC : plan.targetPercent,
);

const pickStartProgress = (plan: DeferredObjectiveActivePlanV1): number | null => finiteOrNull(
  plan.objectiveKind === 'temperature' ? plan.startProgressC : plan.startProgressPercent,
);

// Effective kWh-per-unit rate the planner used: the latest revision's resolved
// display rate, falling back to the learned-profile mean on the provenance.
// Positive-only — a zero/absent rate yields a null so the caller drops the
// planned staircase rather than dividing by zero.
const pickRate = (plan: DeferredObjectiveActivePlanV1): number | null => {
  const rate = finiteOrNull(plan.latest?.rateMean ?? plan.kwhPerUnitProvenance?.kWhPerUnit ?? null);
  return rate !== null && rate > 0 ? rate : null;
};

const pickObservedSamples = (
  samples: DeferredObjectiveActivePlanProgressSampleV1[] | undefined,
  objectiveKind: DeferredObjectiveActivePlanV1['objectiveKind'],
): DeferredPlanHistoryChartPoint[] => {
  if (!Array.isArray(samples) || samples.length === 0) return [];
  const out: DeferredPlanHistoryChartPoint[] = [];
  for (const sample of samples) {
    if (!sample || !Number.isFinite(sample.atMs)) continue;
    const value = objectiveKind === 'temperature' ? sample.valueC : sample.valuePercent;
    if (value === null || !Number.isFinite(value)) continue;
    out.push({ atMs: sample.atMs, value });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
};

const emptyChart = (
  target: number | null,
  windowStartMs: number,
  windowEndMs: number,
): DeferredPlanHistoryChartData => ({
  mode: 'legacy_kwh',
  unit: null,
  windowStartMs,
  windowEndMs,
  plannedOriginal: [],
  plannedFinal: null,
  observed: [],
  target,
  metAtMs: null,
  metMarkerValue: null,
});

/**
 * Composes the trajectory chart payload for an on-going smart task.
 *
 * The planned staircase is integrated from the live `latest.hours × rate`,
 * anchored at the run's start progress and clamped to the deadline — the same
 * math the finished-run "Planned trajectory" line uses. The observed line is
 * the hourly progress series captured so far. There is no revised/second line
 * and no "reached target" marker: the run is still in flight.
 *
 * Falls back to a chartless (`legacy_kwh`, empty) payload when there is nothing
 * honest to draw — no usable rate to anchor the plan AND fewer than two observed
 * points (a single point renders as a lone dot, which reads worse than no chart).
 * The renderer hides the chart container in that case and shows the text lines.
 */
// The planned staircase's anchor: the run-start reading when known, else the
// live current reading at `now`. Returns null only when neither is available
// (then there's no value to integrate the plan from). Pulled out to keep
// `resolveActivePlanChartData` under the complexity bar.
const resolvePlannedAnchor = (
  startProgress: number | null,
  currentValue: number | null,
  windowStartMs: number,
  nowMs: number | undefined,
): { value: number; atMs: number } | null => {
  if (startProgress !== null) return { value: startProgress, atMs: windowStartMs };
  if (currentValue !== null) return { value: currentValue, atMs: nowMs ?? windowStartMs };
  return null;
};

export const resolveActivePlanChartData = (
  plan: DeferredObjectiveActivePlanV1,
  // `nowMs` + `currentValue` (the device's live reading from the widget's device
  // snapshot) extend the measured line to "now" and give an active task a
  // "you are here" anchor even before two hourly samples have been bucketed.
  options: { nowMs?: number; currentValue?: number | null } = {},
): DeferredPlanHistoryChartData => {
  const windowStartMs = plan.startedAtMs;
  const windowEndMs = plan.deadlineAtMs;
  const target = pickTarget(plan);
  const startProgress = pickStartProgress(plan);
  const samples = pickObservedSamples(plan.progressSamples, plan.objectiveKind);
  // Append the live "now" reading past the last bucketed sample, then anchor at
  // the run start so the line spans start → now instead of starting mid-chart.
  const nowMs = options.nowMs;
  const currentValue = finiteOrNull(options.currentValue ?? null);
  const withNow = nowMs !== undefined && currentValue !== null
    && (samples.length === 0 || samples[samples.length - 1]!.atMs < nowMs)
    ? [...samples, { atMs: nowMs, value: currentValue }]
    : samples;
  const observed = anchorObservedAtStart(withNow, windowStartMs, startProgress);
  const rate = pickRate(plan);
  // Truthy guard covers both `null` and a defensively-omitted `undefined`
  // `latest`, and narrows it for the `.hours` read.
  const latest = plan.latest;
  const anchor = resolvePlannedAnchor(startProgress, currentValue, windowStartMs, nowMs);
  const planned = latest && anchor !== null && rate !== null
    ? integratePlannedStaircase(
      { hours: latest.hours, kwhPerUnitMean: rate },
      anchor.value,
      anchor.atMs,
      windowEndMs,
      target,
    )
    : [];
  if (planned.length === 0 && observed.length < 2) {
    return emptyChart(target, windowStartMs, windowEndMs);
  }
  return {
    mode: 'trajectory',
    unit: plan.objectiveKind === 'temperature' ? '°C' : '%',
    windowStartMs,
    windowEndMs,
    plannedOriginal: planned,
    plannedFinal: null,
    observed,
    target,
    metAtMs: null,
    metMarkerValue: null,
  };
};
