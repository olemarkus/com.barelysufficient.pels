// Producer for the smart-task live page's trajectory card ("Will it reach
// 65 °C in time?") plus its contiguous-range helper for the scheduled-run
// bands. Split out of `deadlinePlan.ts` so the payload assembly file stays
// under the max-lines ceiling; this module owns every trajectory-side
// resolution (series points, axis bounds, stateline, shortfall) so the view
// renders flat data only.
import type {
  DeferredObjectiveActivePlanStatusV1,
  ResolvedDeferredObjectiveActivePlanV1,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import {
  DEADLINE_MARKER_WORD,
  formatProgressValueForUnit,
  formatSmartTaskTargetLabel,
  formatSmartTaskTrajectoryCardTitle,
  formatSmartTaskTrajectoryShortAmountLabel,
  formatSmartTaskCurrentValuePhrase,
  formatSmartTaskTrajectoryStatelineReady,
  formatSmartTaskTrajectoryStatelineShort,
  SMART_TASK_STATELINE_AT_RISK_WORD,
  SMART_TASK_STATELINE_ON_TRACK_WORD,
} from '../../../shared-domain/src/deadlineLabels.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { formatDeadlineFull, formatHourLabel } from './deadlinePlanFormatters.ts';
import {
  ONE_HOUR_MS,
  type DeadlinePlanSchedule,
  type ObjectivePayloadReady,
} from './deadlinePlanData.ts';
import { buildCoverStartByStartMs } from './deadlinePlanHourMaps.ts';
import type { DeadlineTrajectoryPayload } from './views/DeadlinePlan.tsx';
import type { DeferredObjectiveUnit } from '../../../contracts/src/deferredObjectiveSettings.ts';

// Contiguous true-ranges over an hour grid, feeding the trajectory chart's
// scheduled-run bands (ms coordinates, mapped by the caller). Only the first
// range carries the label — repeating it on every band reads as clutter at
// 320 px. (The schedule chart no longer draws a band: its filled bars carry
// chosen-ness.)
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
const collectMeasuredPoints = (
  activePlan: ResolvedDeferredObjectiveActivePlanV1,
  nowMs: number,
  currentValue: number,
): Array<[number, number]> => {
  const points: Array<[number, number]> = [];
  const start = activePlan.startProgressValue;
  if (typeof start === 'number' && Number.isFinite(start)) {
    points.push([activePlan.startedAtMs, start]);
  }
  for (const sample of activePlan.progressSamples ?? []) {
    if (sample.value !== null && Number.isFinite(sample.value) && sample.atMs <= nowMs) {
      points.push([sample.atMs, sample.value]);
    }
  }
  points.push([nowMs, currentValue]);
  points.sort((left, right) => left[0] - right[0]);
  return points.filter((point, index) => {
    const next = points[index + 1];
    return next === undefined || point[0] < next[0];
  });
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
const SHORTFALL_DISPLAY_EPSILON: Record<DeferredObjectiveUnit, number> = { '°C': 0.05, '%': 0.5, kWh: 0.05 };

// Planned staircase ahead: flat between runs, a vertical riser at each
// planned hour's start (the same idiom the signed-off mock uses). Risers cap
// at the target; `readyAtMs` is the end of the hour that tops out (within
// display tolerance — see the epsilon note above).
const applyDirectionalStep = (
  progressDirection: 'increasing' | 'decreasing',
  projected: number,
  step: number,
  targetValue: number,
): number => progressDirection === 'increasing'
  ? Math.min(targetValue, projected + step)
  : Math.max(targetValue, projected - step);

const movedInDirection = (
  progressDirection: 'increasing' | 'decreasing',
  currentValue: number,
  nextValue: number,
): boolean => progressDirection === 'increasing'
  ? nextValue > currentValue
  : nextValue < currentValue;

const remainingTowardTarget = (
  progressDirection: 'increasing' | 'decreasing',
  targetValue: number,
  currentValue: number,
): number => progressDirection === 'increasing'
  ? targetValue - currentValue
  : currentValue - targetValue;

const buildPlannedStaircase = (
  input: ObjectivePayloadReady,
  currentChargeByStartMs: Map<number, number>,
): { points: Array<[number, number]>; projected: number; readyAtMs: number | null } => {
  const { ctx, progress, energy } = input;
  const { nowMs, deadlineAtMs } = ctx;
  const { currentValue, targetValue, progressDirection, unit } = progress;
  const energyNeededKWh = energy?.energyNeededKWh ?? 0;
  const progressPerKWh = energyNeededKWh > 0 ? progress.remainingUnits / energyNeededKWh : 0;
  // Actual coverage start (`coversFromMs`) per booked hour, present only for
  // buckets the planner already trimmed at a mid-hour revision.
  const currentCoverStartByStartMs = buildCoverStartByStartMs(ctx.activePlan.latest);
  const points: Array<[number, number]> = [[nowMs, currentValue]];
  let projected = currentValue;
  let readyAtMs: number | null = null;
  for (const hour of input.hours) {
    if (hour.endMs <= nowMs) continue;
    const plannedKwh = currentChargeByStartMs.get(hour.startsAtMs) ?? 0;
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
    const coverStartMs = currentCoverStartByStartMs.get(hour.startsAtMs) ?? hour.startsAtMs;
    const coverEndMs = Math.min(hour.endMs, deadlineAtMs);
    const coveredSpanMs = coverEndMs - coverStartMs;
    const remainingFraction = coveredSpanMs > 0
      ? Math.max(0, Math.min(1, (coverEndMs - Math.max(nowMs, coverStartMs)) / coveredSpanMs))
      : 0;
    const remainingKwh = plannedKwh * remainingFraction;
    if (remainingKwh <= 0) continue;
    const step = remainingKwh * progressPerKWh;
    const next = applyDirectionalStep(progressDirection, projected, step, targetValue);
    if (!movedInDirection(progressDirection, projected, next)) continue;
    const riserX = Math.max(hour.startsAtMs, nowMs);
    points.push([riserX, projected], [riserX, next]);
    projected = next;
    if (readyAtMs === null
      && remainingTowardTarget(progressDirection, targetValue, projected)
        < SHORTFALL_DISPLAY_EPSILON[unit]) {
      readyAtMs = Math.min(hour.endMs, deadlineAtMs);
    }
  }
  return { points, projected, readyAtMs };
};

export const buildTrajectory = (
  input: ObjectivePayloadReady,
  schedule: DeadlinePlanSchedule,
): DeadlineTrajectoryPayload => {
  const { ctx, progress } = input;
  const { nowMs, deadlineAtMs } = ctx;
  const { currentValue, targetValue, unit } = progress;
  const { planStatus, currentChargeByStartMs } = schedule;
  const measuredPoints = collectMeasuredPoints(ctx.activePlan, nowMs, currentValue);
  const staircase = buildPlannedStaircase(input, currentChargeByStartMs);
  const { projected, readyAtMs } = staircase;
  const xMaxMs = deadlineAtMs + 30 * 60 * 1000;
  // `collectMeasuredPoints` always ends with the now-point, so the first entry
  // exists; with none, `nowMs` is the earliest thing measured.
  const earliestMeasuredMs = measuredPoints[0]?.[0] ?? nowMs;
  const xMinMs = Math.min(earliestMeasuredMs, nowMs - 30 * 60 * 1000);
  const plannedPoints = [...staircase.points, [xMaxMs, projected] as [number, number]];
  const runBands = collectPlannedRanges(
    input.hours.map((hour) => (
      hour.endMs > xMinMs && (currentChargeByStartMs.get(hour.startsAtMs) ?? 0) > 0
    )),
    // Same kind verb as the schedule chart's planned band — the two cards'
    // bands speak one word ("Heating" / "Charging").
    schedule.labels.deviceSeriesName,
  ).flatMap((range) => {
    const fromHour = input.hours[range.from];
    const toHour = input.hours[range.to];
    // Ranges are indexes into `input.hours`, so both ends resolve; a band with
    // no hour at either end has nothing to draw.
    if (fromHour === undefined || toHour === undefined) return [];
    return [{
      fromMs: Math.max(fromHour.startsAtMs, xMinMs),
      toMs: Math.min(toHour.endMs, xMaxMs),
      label: range.label,
    }];
  });
  const observedValues = measuredPoints.map((point) => point[1]);
  const minValue = Math.min(targetValue, ...observedValues, currentValue);
  const pad = unit === '%' ? 5 : 2;
  // Only a temperature can sit below zero; a charge level or an amount of
  // energy delivered cannot.
  const yMin = unit === '°C' ? Math.floor(minValue - pad) : Math.max(0, Math.floor(minValue - pad));
  const yMax = Math.ceil(Math.max(targetValue, ...observedValues) + pad);
  const shortBy = progress.progressDirection === 'increasing'
    ? targetValue - projected
    : projected - targetValue;
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
  const STATELINE_STATUS_WORD: Record<DeferredObjectiveActivePlanStatusV1, string | null> = {
    on_track: SMART_TASK_STATELINE_ON_TRACK_WORD,
    satisfied: SMART_TASK_STATELINE_ON_TRACK_WORD,
    at_risk: SMART_TASK_STATELINE_AT_RISK_WORD,
    cannot_meet: SMART_TASK_STATELINE_AT_RISK_WORD,
    invalid: null,
  };
  const statusWord = STATELINE_STATUS_WORD[planStatus];
  const stateline = isShort
    ? formatSmartTaskTrajectoryStatelineShort({
      projectedValueLabel: formatProgressValueForUnit(projected, unit),
      shortAmountLabel: formatSmartTaskTrajectoryShortAmountLabel(Math.max(0, shortBy), unit),
    })
    : formatSmartTaskTrajectoryStatelineReady(
      formatSmartTaskCurrentValuePhrase(
        formatProgressValueForUnit(currentValue, unit),
        unit,
      ),
      statusWord,
      formatDeadlineFull(effectiveReadyAtMs!),
      (deadlineAtMs - effectiveReadyAtMs!) / ONE_HOUR_MS,
    );
  return {
    cardTitle: formatSmartTaskTrajectoryCardTitle({ targetValue, targetUnit: unit }),
    ariaLabel: `Smart task progress trajectory for ${formatDisplayDeviceName(ctx.device.name)}`,
    measuredPoints,
    nowPoint: [nowMs, currentValue],
    plannedPoints,
    runBands,
    targetValue,
    targetLabel: formatSmartTaskTargetLabel({ targetValue, targetUnit: unit }),
    deadlineAtMs: deadlineAtMs,
    deadlineMarkLabel: isShort
      ? `${DEADLINE_MARKER_WORD} ${formatHourLabel(deadlineAtMs)}`
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
