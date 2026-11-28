// Producer for the smart-task live page's trajectory card ("Will it reach
// 65 °C in time?") plus its contiguous-range helper for the scheduled-run
// bands. Split out of `deadlinePlan.ts` so the payload assembly file stays
// under the max-lines ceiling; this module owns every trajectory-side
// resolution (series points, axis bounds, stateline, shortfall) so the view
// renders flat data only.
import type {
  DeferredObjectiveReportedStatus,
  ResolvedDeferredObjectiveActivePlanV1,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import {
  DEADLINE_MARKER_WORD,
  SMART_TASK_ENERGY_DELIVERED_TITLE,
  formatSmartTaskTargetLabel,
  formatSmartTaskTrajectoryCardTitle,
  formatSmartTaskTrajectoryShortAmountLabel,
  formatSmartTaskCurrentValuePhrase,
  formatSmartTaskIdleTrajectoryStateline,
  formatSmartTaskTrajectoryStatelineReady,
  formatSmartTaskTrajectoryStatelineShort,
  SMART_TASK_STATELINE_AT_RISK_WORD,
  SMART_TASK_STATELINE_ON_TRACK_WORD,
} from '../../../shared-domain/src/smartTaskCopy/liveDetailCopy.ts';
import { formatProgressValueForUnit } from '../../../shared-domain/src/smartTaskCopy/valueFormat.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import {
  resolveRemainingPlannedKWh, scheduledTaskIntervals,
} from '../../../shared-domain/src/deferredPlanBookedHours.ts';
import { formatDeadlineFull, formatHourLabel } from './deadlinePlanFormatters.ts';
import {
  ONE_HOUR_MS,
  type DeadlinePlanSchedule,
  type ObjectivePayloadReady,
} from './deadlinePlanData.ts';
import { resolveRunBands } from '../../../shared-domain/src/deferredPlanHistoryChartData.ts';
import type { DeadlineTrajectoryPayload } from './views/DeadlinePlan.tsx';
import type { DeferredObjectiveUnit } from '../../../contracts/src/deferredObjectiveSettings.ts';

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
): { points: Array<[number, number]>; projected: number; readyAtMs: number | null } => {
  const { ctx, progress, energy } = input;
  const { nowMs, deadlineAtMs } = ctx;
  const { currentValue, targetValue, progressDirection, unit } = progress;
  const { latest } = ctx.activePlan;
  const fallbackWindows = latest.partialPriceSchedule?.fallbackWindows;
  const energyNeededKWh = energy?.energyNeededKWh ?? 0;
  const progressPerKWh = energyNeededKWh > 0 ? progress.remainingUnits / energyNeededKWh : 0;
  // Actual coverage start (`coversFromMs`) per booked hour, present only for
  // buckets the planner already trimmed at a mid-hour revision.
  const points: Array<[number, number]> = [[nowMs, currentValue]];
  let projected = currentValue;
  let readyAtMs: number | null = null;
  for (const hour of scheduledTaskIntervals(latest)) {
    // The staircase anchors at `currentValue`, which already includes the
    // progress so far. A trimmed booking covers only the span after coversFromMs.
    const remainingKwh = resolveRemainingPlannedKWh(hour, nowMs, deadlineAtMs);
    if (remainingKwh <= 0) continue;
    const step = remainingKwh * progressPerKWh;
    const next = applyDirectionalStep(progressDirection, projected, step, targetValue);
    if (!movedInDirection(progressDirection, projected, next)) continue;
    const startMs = Math.max(hour.coversFromMs ?? hour.startsAtMs, nowMs);
    // An unpriced window can span hours, so show its progress across the run.
    const endMs = fallbackWindows?.includes(hour) ? Math.min(hour.endsAtMs, deadlineAtMs) : startMs;
    points.push([startMs, projected], [endMs, next]);
    projected = next;
    if (readyAtMs === null
      && remainingTowardTarget(progressDirection, targetValue, projected)
        < SHORTFALL_DISPLAY_EPSILON[unit]) {
      readyAtMs = Math.min(hour.endsAtMs, deadlineAtMs);
    }
  }
  return { points, projected, readyAtMs };
};

const buildTrajectoryForecast = (
  input: ObjectivePayloadReady,
  planStatus: DeferredObjectiveReportedStatus,
  xMaxMs: number,
): Pick<DeadlineTrajectoryPayload, 'plannedPoints' | 'stateline' | 'shortfall' | 'deadlineDanger'> => {
  const { ctx: { nowMs, deadlineAtMs }, progress } = input;
  const { currentValue, targetValue, unit } = progress;
  if (planStatus === 'device_idle') {
    return {
      plannedPoints: [],
      stateline: formatSmartTaskIdleTrajectoryStateline(
        formatProgressValueForUnit(currentValue, unit), formatProgressValueForUnit(targetValue, unit),
      ),
      shortfall: null,
      deadlineDanger: false,
    };
  }
  const { points, projected, readyAtMs } = buildPlannedStaircase(input);
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
  const STATELINE_STATUS_WORD: Record<Exclude<DeferredObjectiveReportedStatus, 'device_idle'>, string | null> = {
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
    plannedPoints: [...points, [xMaxMs, projected]],
    stateline,
    deadlineDanger: isShort,
    shortfall: isShort
      ? {
        fromValue: projected,
        toValue: targetValue,
        label: formatSmartTaskTrajectoryShortAmountLabel(shortBy, unit),
      }
      : null,
  };
};

export const buildTrajectory = (
  input: ObjectivePayloadReady,
  schedule: DeadlinePlanSchedule,
): DeadlineTrajectoryPayload => {
  const { ctx, progress } = input;
  const { nowMs, deadlineAtMs } = ctx;
  const { currentValue, targetValue, unit } = progress;
  const { planStatus } = schedule;
  const measuredPoints = collectMeasuredPoints(ctx.activePlan, nowMs, currentValue);
  const deviceIdle = planStatus === 'device_idle';
  const xMaxMs = deadlineAtMs + 30 * 60 * 1000;
  // `collectMeasuredPoints` always ends with the now-point, so the first entry
  // exists; with none, `nowMs` is the earliest thing measured.
  const earliestMeasuredMs = measuredPoints[0]?.[0] ?? nowMs;
  const xMinMs = Math.min(earliestMeasuredMs, nowMs - 30 * 60 * 1000);
  const intervals = scheduledTaskIntervals(ctx.activePlan.latest);
  const bookings = deviceIdle ? intervals.filter((hour) => hour.endsAtMs <= nowMs) : intervals;
  const runBands = resolveRunBands(bookings, xMinMs, xMaxMs)
    .map((band, index) => ({ ...band, label: index === 0 ? schedule.labels.deviceSeriesName : null }));
  const observedValues = measuredPoints.map((point) => point[1]);
  const minValue = Math.min(targetValue, ...observedValues, currentValue);
  const pad = unit === '%' ? 5 : 2;
  // Only a temperature can sit below zero; a charge level or an amount of
  // energy delivered cannot.
  const yMin = unit === '°C' ? Math.floor(minValue - pad) : Math.max(0, Math.floor(minValue - pad));
  const yMax = Math.ceil(Math.max(targetValue, ...observedValues) + pad);
  const forecast = buildTrajectoryForecast(input, planStatus, xMaxMs);
  return {
    cardTitle: deviceIdle
      ? SMART_TASK_ENERGY_DELIVERED_TITLE : formatSmartTaskTrajectoryCardTitle({ targetValue, targetUnit: unit }),
    ariaLabel: `Smart task progress trajectory for ${formatDisplayDeviceName(ctx.device.name)}`,
    measuredPoints,
    nowPoint: [nowMs, currentValue],
    runBands,
    targetValue,
    targetLabel: formatSmartTaskTargetLabel({ targetValue, targetUnit: unit }),
    deadlineAtMs: deadlineAtMs,
    deadlineMarkLabel: forecast.deadlineDanger
      ? `${DEADLINE_MARKER_WORD} ${formatHourLabel(deadlineAtMs)}`
      : DEADLINE_MARKER_WORD,
    xMinMs,
    xMaxMs,
    yMin,
    yMax,
    yFloorLabel: formatProgressValueForUnit(yMin, unit),
    ...forecast,
  };
};
