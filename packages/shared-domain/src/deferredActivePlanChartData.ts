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
export const resolveActivePlanChartData = (
  plan: DeferredObjectiveActivePlanV1,
): DeferredPlanHistoryChartData => {
  const windowStartMs = plan.startedAtMs;
  const windowEndMs = plan.deadlineAtMs;
  const target = pickTarget(plan);
  const observed = pickObservedSamples(plan.progressSamples, plan.objectiveKind);
  const startProgress = pickStartProgress(plan);
  const rate = pickRate(plan);
  // Truthy guard covers both `null` and a defensively-omitted `undefined`
  // `latest`, and narrows it for the `.hours` read.
  const latest = plan.latest;
  const planned = latest && startProgress !== null && rate !== null
    ? integratePlannedStaircase(
      { hours: latest.hours, kwhPerUnitMean: rate },
      startProgress,
      windowStartMs,
      windowEndMs,
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
