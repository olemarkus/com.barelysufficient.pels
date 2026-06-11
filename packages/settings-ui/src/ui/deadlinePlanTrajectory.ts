// Producer for the smart-task live page's trajectory card ("Will it reach
// 65 °C in time?") plus the contiguous-range helper shared with the schedule
// chart's planned markArea bands. Split out of `deadlinePlan.ts` so the
// payload assembly file stays under the max-lines ceiling; this module owns
// every trajectory-side resolution (series points, axis bounds, stateline,
// shortfall) so the view renders flat data only.
import type {
  ResolvedDeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlanRevisionV1,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import type { ObservedDeviceState } from '../../../contracts/src/types.ts';
import {
  DEADLINE_MARKER_WORD,
  formatProgressValueForUnit,
  formatSmartTaskTargetLabel,
  formatSmartTaskTrajectoryCardTitle,
  formatSmartTaskTrajectoryShortAmountLabel,
  formatSmartTaskTrajectoryStatelineReady,
  formatSmartTaskTrajectoryStatelineShort,
  SMART_TASK_STATELINE_AT_RISK_WORD,
  SMART_TASK_STATELINE_ON_TRACK_WORD,
} from '../../../shared-domain/src/deadlineLabels.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { formatDeadlineFull, formatHourLabel } from './deadlinePlanFormatters.ts';
import { ONE_HOUR_MS, type HorizonHour } from './deadlinePlanData.ts';
import type { DeadlineTrajectoryPayload } from './views/DeadlinePlan.tsx';

// Contiguous true-ranges over an hour grid. The schedule chart uses it for
// the planned markArea bands (index coordinates); the trajectory chart uses
// it for the scheduled-run bands (ms coordinates, mapped by the caller).
// Only the first range carries the label — repeating it on every band reads
// as clutter at 320 px.
export const collectPlannedRanges = (
  planned: readonly boolean[],
  label: string,
): Array<{ from: number; to: number; label: string | null }> => {
  const ranges: Array<{ from: number; to: number; label: string | null }> = [];
  let start: number | null = null;
  for (let i = 0; i <= planned.length; i += 1) {
    if (i < planned.length && planned[i]) {
      start = start ?? i;
      continue;
    }
    if (start !== null) {
      ranges.push({ from: start, to: i - 1, label: ranges.length === 0 ? label : null });
      start = null;
    }
  }
  return ranges;
};

// Measured-so-far series: the run's start anchor (when known), the recorder's
// observed samples, then the live "now" reading. Sorted + deduped so a sample
// recorded at exactly `nowMs` doesn't draw a zero-length segment. The dedupe
// keeps the LAST point per timestamp: the live reading is pushed last and
// `Array.prototype.sort` is stable, so on a timestamp collision the live
// `currentValue` wins over a stored sample — the measured line then ends at
// the same value the now-dot and stateline display.
const collectMeasuredPoints = (params: {
  activePlan: ResolvedDeferredObjectiveActivePlanV1;
  nowMs: number;
  currentValue: number;
}): Array<[number, number]> => {
  const points: Array<[number, number]> = [];
  const start = params.activePlan.startProgressValue;
  if (typeof start === 'number' && Number.isFinite(start)) {
    points.push([params.activePlan.startedAtMs, start]);
  }
  for (const sample of params.activePlan.progressSamples ?? []) {
    if (sample.value !== null && Number.isFinite(sample.value) && sample.atMs <= params.nowMs) {
      points.push([sample.atMs, sample.value]);
    }
  }
  points.push([params.nowMs, params.currentValue]);
  points.sort((left, right) => left[0] - right[0]);
  return points.filter((point, index) => (
    index === points.length - 1 || point[0] < points[index + 1][0]
  ));
};

// Display rounding floor for the danger branch: a shortfall smaller than the
// unit's display precision would render "0 °C short", so it stays on the
// ready branch instead. The staircase builder reuses it as the
// reached-the-target tolerance — `progressPerKWh` is a quotient
// (remainingUnits / energyNeededKWh) whose accumulated sum can land a few
// ulps below the target, and an exact `>=` would misclassify a fully-booked
// plan as "0 °C short". The values must stay at or above the rounding
// half-step of `formatSmartTaskTrajectoryShortAmountLabel` (0.05 for
// one-decimal °C, 0.5 for whole %) — that is what guarantees a flagged
// shortfall never rounds to a zero amount.
const SHORTFALL_DISPLAY_EPSILON: Record<'°C' | '%', number> = { '°C': 0.05, '%': 0.5 };

// Planned staircase ahead: flat between runs, a vertical riser at each
// planned hour's start (the same idiom the signed-off mock uses). Risers cap
// at the target; `readyAtMs` is the end of the hour that tops out (within
// display tolerance — see the epsilon note above).
const buildPlannedStaircase = (params: {
  hours: HorizonHour[];
  currentChargeByStartMs: Map<number, number>;
  currentCoverStartByStartMs: Map<number, number>;
  currentValue: number;
  targetValue: number;
  progressPerKWh: number;
  unit: '°C' | '%';
  deadlineAtMs: number;
  nowMs: number;
}): { points: Array<[number, number]>; projected: number; readyAtMs: number | null } => {
  const points: Array<[number, number]> = [[params.nowMs, params.currentValue]];
  let projected = params.currentValue;
  let readyAtMs: number | null = null;
  for (const hour of params.hours) {
    if (hour.endMs <= params.nowMs) continue;
    const plannedKwh = params.currentChargeByStartMs.get(hour.startsAtMs) ?? 0;
    if (plannedKwh <= 0) continue;
    // The staircase anchors at `currentValue`, which already includes the
    // progress made so far in the current hour — adding the in-progress
    // hour's whole `plannedKWh` on top would double-count the elapsed part
    // and could flip the shortfall verdict optimistic. Credit only the
    // fraction of the booked energy that is still ahead of `nowMs`,
    // prorated over the span the energy actually covers (the same
    // `postAnchorFraction` semantics as the history chart in
    // `deferredPlanHistoryChartData.ts`):
    //   • full-hour bucket (no `coversFromMs`, e.g. a committed full-hour
    //     floor) straddling now → remaining fraction of the hour;
    //   • bucket already trimmed at a mid-hour revision (`coversFromMs` =
    //     the revision's nowMs) → fraction over `[coversFromMs, hourEnd]`,
    //     so a just-revised bucket is added whole (prorating it against the
    //     full hour would double-trim and understate);
    //   • hour fully ahead → fraction 1; hour fully elapsed → skipped above.
    // The span end clamps to the deadline, mirroring how the planner only
    // books energy up to `deadlineAtMs` within the final hour.
    const coverStartMs = params.currentCoverStartByStartMs.get(hour.startsAtMs) ?? hour.startsAtMs;
    const coverEndMs = Math.min(hour.endMs, params.deadlineAtMs);
    const coveredSpanMs = coverEndMs - coverStartMs;
    const remainingFraction = coveredSpanMs > 0
      ? Math.max(0, Math.min(1, (coverEndMs - Math.max(params.nowMs, coverStartMs)) / coveredSpanMs))
      : 0;
    const remainingKwh = plannedKwh * remainingFraction;
    if (remainingKwh <= 0) continue;
    const next = Math.min(params.targetValue, projected + remainingKwh * params.progressPerKWh);
    if (next <= projected) continue;
    const riserX = Math.max(hour.startsAtMs, params.nowMs);
    points.push([riserX, projected], [riserX, next]);
    projected = next;
    if (readyAtMs === null && params.targetValue - projected < SHORTFALL_DISPLAY_EPSILON[params.unit]) {
      readyAtMs = Math.min(hour.endMs, params.deadlineAtMs);
    }
  }
  return { points, projected, readyAtMs };
};

export const buildTrajectory = (params: {
  device: ObservedDeviceState;
  activePlan: ResolvedDeferredObjectiveActivePlanV1;
  planStatus: DeferredObjectiveActivePlanRevisionV1['planStatus'];
  hours: HorizonHour[];
  currentChargeByStartMs: Map<number, number>;
  // Actual coverage start (`coversFromMs`) per booked hour, present only for
  // buckets the planner already trimmed at a mid-hour revision. Drives the
  // staircase's current-hour proration — see `buildPlannedStaircase`.
  currentCoverStartByStartMs: Map<number, number>;
  currentValue: number;
  targetValue: number;
  progressPerKWh: number;
  unit: '°C' | '%';
  deadlineAtMs: number;
  nowMs: number;
  // Scheduled-run band label — the kind verb ("Heating" / "Charging") shared
  // with the schedule chart's planned band via `labels.deviceSeriesName`, so
  // the two cards' bands speak one word.
  runBandLabel: string;
}): DeadlineTrajectoryPayload => {
  const { nowMs, targetValue, unit } = params;
  const measuredPoints = collectMeasuredPoints({
    activePlan: params.activePlan,
    nowMs,
    currentValue: params.currentValue,
  });
  const staircase = buildPlannedStaircase(params);
  const { projected, readyAtMs } = staircase;
  const xMaxMs = params.deadlineAtMs + 30 * 60 * 1000;
  const xMinMs = Math.min(measuredPoints[0][0], nowMs - 30 * 60 * 1000);
  const plannedPoints = [...staircase.points, [xMaxMs, projected] as [number, number]];
  const runBands = collectPlannedRanges(
    params.hours.map((hour) => (
      hour.endMs > xMinMs && (params.currentChargeByStartMs.get(hour.startsAtMs) ?? 0) > 0
    )),
    params.runBandLabel,
  ).map((range) => ({
    fromMs: Math.max(params.hours[range.from].startsAtMs, xMinMs),
    toMs: Math.min(params.hours[range.to].endMs, xMaxMs),
    label: range.label,
  }));
  const observedValues = measuredPoints.map((point) => point[1]);
  const minValue = Math.min(...observedValues, params.currentValue);
  const pad = unit === '%' ? 5 : 2;
  const yMin = unit === '%' ? Math.max(0, Math.floor(minValue - pad)) : Math.floor(minValue - pad);
  const yMax = Math.ceil(Math.max(targetValue, ...observedValues) + pad);
  const shortBy = targetValue - projected;
  // A trajectory already at/within display tolerance of the target (e.g.
  // 64.96 °C now vs target 65.0) leaves `readyAtMs` null — no future riser
  // ever crosses the target, and with nothing booked the staircase never
  // rises at all — yet it is ready NOW, not short. Resolve the ready time to
  // `nowMs` in that case so the stateline reads as ready instead of a phantom
  // zero-amount "short" danger line.
  const effectiveReadyAtMs = readyAtMs
    ?? (shortBy < SHORTFALL_DISPLAY_EPSILON[unit] ? nowMs : null);
  // Data-driven verdict: the danger branch keys off the staircase itself
  // (booked energy can't reach the target), not off `planStatus`, so the
  // chart and its stateline can never disagree. A `cannot_meet` plan books
  // too little energy by construction, so the branch fires naturally; a
  // sub-epsilon gap stays on the ready branch (its amount would round to a
  // zero "0 °C short" label otherwise).
  const isShort = shortBy >= SHORTFALL_DISPLAY_EPSILON[unit] && effectiveReadyAtMs === null;
  // `invalid` maps to null (status-word-free sentence): the planner couldn't
  // produce a valid plan, which is neither "on track" nor "at risk" — claiming
  // either would fabricate a verdict. The formatter already supports a null
  // status word.
  const STATELINE_STATUS_WORD: Record<typeof params.planStatus, string | null> = {
    on_track: SMART_TASK_STATELINE_ON_TRACK_WORD,
    satisfied: SMART_TASK_STATELINE_ON_TRACK_WORD,
    at_risk: SMART_TASK_STATELINE_AT_RISK_WORD,
    cannot_meet: SMART_TASK_STATELINE_AT_RISK_WORD,
    invalid: null,
  };
  const statusWord = STATELINE_STATUS_WORD[params.planStatus];
  const stateline = isShort
    ? formatSmartTaskTrajectoryStatelineShort({
      projectedValueLabel: formatProgressValueForUnit(projected, unit),
      shortAmountLabel: formatSmartTaskTrajectoryShortAmountLabel(Math.max(0, shortBy), unit),
    })
    : formatSmartTaskTrajectoryStatelineReady({
      nowValueLabel: formatProgressValueForUnit(params.currentValue, unit),
      statusWord,
      readyTimeLabel: formatDeadlineFull(effectiveReadyAtMs!),
      hoursBeforeDeadline: (params.deadlineAtMs - effectiveReadyAtMs!) / ONE_HOUR_MS,
    });
  return {
    cardTitle: formatSmartTaskTrajectoryCardTitle({ targetValue, targetUnit: unit }),
    ariaLabel: `Smart task progress trajectory for ${formatDisplayDeviceName(params.device.name)}`,
    measuredPoints,
    nowPoint: [nowMs, params.currentValue],
    plannedPoints,
    runBands,
    targetValue,
    targetLabel: formatSmartTaskTargetLabel({ targetValue, targetUnit: unit }),
    deadlineAtMs: params.deadlineAtMs,
    deadlineMarkLabel: isShort
      ? `${DEADLINE_MARKER_WORD} ${formatHourLabel(params.deadlineAtMs)}`
      : DEADLINE_MARKER_WORD,
    deadlineDanger: isShort,
    xMinMs,
    xMaxMs,
    yMin,
    yMax,
    yFloorLabel: formatProgressValueForUnit(yMin, unit),
    stateline,
    // `isShort` already implies `shortBy >= SHORTFALL_DISPLAY_EPSILON[unit]`,
    // so the annotation's amount can never round to zero.
    shortfall: isShort
      ? {
        fromValue: projected,
        toValue: targetValue,
        label: formatSmartTaskTrajectoryShortAmountLabel(shortBy, unit),
      }
      : null,
  };
};
