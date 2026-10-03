// Producer for the smart-task history-detail chart payload (v2.7.2 PR 4).
//
// Resolves the actual-vs-plan trajectory chart series the detail page renders:
// a stepped planned-staircase derived from each revision's
// `hours × kwhPerUnitMean`, an observed-progress line from `progressSamples[]`,
// a target reference line, and a marker at `metAtMs` for succeeded runs. The
// original staircase integrates from the recorded start progress; the revised
// staircase re-anchors at the measured progress when that revision was computed
// so a mid-run replan does not read as "still moving from the start
// temperature" (see `notes/deferred-load-objectives/execution-adaptation.md`).
//
// Lives in its own file (alongside `deferredPlanHistory.ts`) so the legacy
// hero-formatter helpers stay browse-able under the 500-LOC cap. Per
// `feedback_layering_resolution_in_producer.md`, the view layer never
// inspects the entry's optional fields — it consumes the flat payload this
// module produces.
import type {
  DeferredObjectivePlanHistoryRevisionSnapshot,
  ResolvedDeferredObjectivePlanHistoryEntry,
} from '../../contracts/src/deferredObjectivePlanHistory';
import { deadlineLabels } from './deadlineLabels';
import { pickScheduledHours, type ScheduledHistoryHour } from './deferredPlanHistoryShared';
import type { DeferredObjectiveUnit } from '../../contracts/src/deferredObjectiveSettings';

// Trajectory chart mode. `trajectory` is the v4 shape used when the entry has
// enough information to render the planned staircase + observed line in the
// target unit (°C / %). `legacy_kwh` is the v3 fallback — when neither the
// progress samples nor the per-unit rate was captured, the only honest chart
// is the original planned-kWh bar form. Producer resolves the mode once so
// the view never branches on the optional fields.
export type DeferredPlanHistoryChartMode = 'trajectory' | 'legacy_kwh';

// One point on the planned staircase or the observed line. `atMs` is the
// absolute timestamp so the view can render across DST transitions without
// re-deriving from category-axis indices.
export type DeferredPlanHistoryChartPoint = {
  atMs: number;
  value: number;
};

// One scheduled-run band: a contiguous span of booked hours, shaded behind the
// trajectory so "when PELS planned to run the device" reads at a glance. Same
// `{fromMs, toMs}` vocabulary as the settings-UI live trajectory's `runBands`
// (`deadlinePlanTrajectory.ts`) minus the label — the 96 px widget chart has no
// room for an in-band label, so the settings pages carry the labelled version.
export type DeferredPlanHistoryChartBand = {
  fromMs: number;
  toMs: number;
};

// Producer-resolved chart payload. The view renders straight from these flat
// fields; it never inspects `progressSamples`, `kwhPerUnitMean`, or any of
// the snapshot's internals. Per
// `feedback_layering_resolution_in_producer.md`.
export type DeferredPlanHistoryChartData = {
  mode: DeferredPlanHistoryChartMode;
  // Target unit for the y-axis. `null` only on `legacy_kwh` (the legacy chart
  // is kWh-axis); on `trajectory` it is the user-visible target unit.
  unit: DeferredObjectiveUnit | null;
  // Window the chart spans. Same [startedAtMs, deadlineAtMs] as the headline;
  // provided here so the view doesn't re-resolve from the entry.
  windowStartMs: number;
  windowEndMs: number;
  // Planned staircase derived from `originalPlan`'s hours × the recorded
  // `kwhPerUnitMean` integrated from `startProgress*`. Empty when the mode
  // is `legacy_kwh` or when the original plan was never recorded.
  plannedOriginal: DeferredPlanHistoryChartPoint[];
  // Planned staircase derived from `finalPlan`, re-anchored at the measured
  // progress when that revision was computed (`revisedAtMs`) — drawn forward
  // from there rather than from the task-start progress. Only populated when the
  // run replanned (different from `originalPlan`); the view overlays it as a
  // second stepped line. Null when the planner never wrote a second revision or
  // when the original and final staircases coincide.
  plannedFinal: DeferredPlanHistoryChartPoint[] | null;
  // Observed progress samples in unit space (°C / %). Empty on `legacy_kwh`.
  // The recorder caps the persisted samples at 48/run, so the line is
  // reasonably smooth even on long runs. Honest-rendering contract (review
  // round 2): either ≥ 2 points (a drawable measured line) or empty — a
  // sample-less entry never fabricates a pseudo-line from the echoed start
  // reading alone. When no real samples landed but the entry recorded BOTH a
  // start and a final reading, this carries the honest two-point start→final
  // segment; otherwise it is empty and the view shows the
  // absent-observations caption instead of a Measured series.
  observed: DeferredPlanHistoryChartPoint[];
  // The staircase the DEFAULT view draws: the re-anchored final plan when the
  // run replanned, else the single original staircase. The single semantic
  // source for "what was planned" — chart series selection, the pinned
  // readout's planned values, and the compare/marker gates all read this (or
  // `replanned` below) instead of re-deriving `plannedFinal ?? plannedOriginal`
  // at each call site. Producer-resolved per
  // `feedback_layering_resolution_in_producer`.
  plannedVisible: DeferredPlanHistoryChartPoint[];
  // True when the run genuinely replanned AND a drawable revised staircase
  // exists (`plannedFinal` populated). Gates the "Plan changed" marker and
  // the "Compare with initial plan" toggle. Always false on `legacy_kwh`.
  replanned: boolean;
  // Scheduled-run bands: merged spans of the booked hours (plannedKWh > 0),
  // clamped to the window — for a finished run, each hour as it was booked when
  // it began (`pickScheduledHours`, falling back to `finalPlan ?? originalPlan`
  // on older entries); for a live one, `latest`. Producer-
  // resolved per `feedback_layering_resolution_in_producer` so the view shades
  // flat ranges without re-deriving them from plan snapshots. Empty on
  // `legacy_kwh` or when no hour books any energy.
  runBands: DeferredPlanHistoryChartBand[];
  // Horizontal target reference line. `null` only when the entry recorded no
  // target for the kind (defensive — every shipped entry has a target).
  target: number | null;
  // Marker on the planned-staircase line at the time the actual progress
  // crossed the target. Null when the run missed / abandoned or no
  // `metAtMs` was recorded.
  metAtMs: number | null;
  // Y-coordinate to plot the met marker at. For target-reached runs this is
  // the target; for stalled runs (either `metReason === 'stalled'` or
  // `'stalled_device_capped'`) it's the frozen final progress (the plateau
  // the device settled at) so the marker lands on the observed line, not
  // above it. Null exactly when `metAtMs` is null. Producer-side resolution
  // per `feedback_layering_resolution_in_producer` — the chart view never
  // branches on outcome / metReason / kind to pick the coordinate.
  metMarkerValue: number | null;
};

const HOUR_MS = 60 * 60 * 1000;

// Resolves the scheduled-run bands from a plan snapshot's hours: each hour
// with booked energy spans `[coversFromMs ?? startsAtMs, startsAtMs + 1h]`
// (the same coverage semantics as the staircase integration below), clamped to
// the chart window; contiguous/overlapping spans merge into one band so a
// 3-hour block reads as one shaded run, not three abutting rects. Exported so
// the live-task producer (`deferredActivePlanChartData.ts`) resolves bands from
// `latest.hours` with identical semantics.
export const resolveRunBands = (
  hours: readonly ScheduledHistoryHour[],
  windowStartMs: number,
  windowEndMs: number,
): DeferredPlanHistoryChartBand[] => {
  const spans: DeferredPlanHistoryChartBand[] = [];
  for (const hour of hours) {
    const plannedKWh = Number.isFinite(hour.plannedKWh) ? hour.plannedKWh : 0;
    if (plannedKWh <= 0) continue;
    // Persisted snapshots are the input here — a non-finite `startsAtMs` /
    // `coversFromMs` would sail through the `toMs <= fromMs` skip below
    // (`NaN <= NaN` is false) and push a NaN band into the chart markArea,
    // so drop malformed hours outright.
    const coverFromMs = hour.coversFromMs ?? hour.startsAtMs;
    if (!Number.isFinite(hour.startsAtMs) || !Number.isFinite(coverFromMs)) continue;
    const fromMs = Math.max(windowStartMs, coverFromMs);
    const toMs = Math.min(windowEndMs, hour.startsAtMs + HOUR_MS);
    if (toMs <= fromMs) continue;
    spans.push({ fromMs, toMs });
  }
  spans.sort((a, b) => a.fromMs - b.fromMs);
  const merged: DeferredPlanHistoryChartBand[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.fromMs <= last.toMs) {
      last.toMs = Math.max(last.toMs, span.toMs);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
};

type DirectionalProgress = {
  direction: 'increasing' | 'decreasing';
  changePerKwh: number;
  limit: number | null;
};

const resolveDirectionalProgress = (
  snapshot: Pick<DeferredObjectivePlanHistoryRevisionSnapshot, 'kwhPerUnitMean' | 'progressDirection'>,
  capValue: number | null, anchorValue: number,
): DirectionalProgress | null => {
  const kwhPerUnitMean = snapshot.kwhPerUnitMean ?? 0;
  const direction = snapshot.progressDirection ?? 'increasing';
  if (kwhPerUnitMean <= 0 || direction === 'unknown') return null;
  let limit: number | null = null;
  if (capValue !== null) {
    limit = direction === 'increasing'
      ? Math.max(capValue, anchorValue)
      : Math.min(capValue, anchorValue);
  }
  return {
    direction,
    changePerKwh: direction === 'increasing' ? 1 / kwhPerUnitMean : -1 / kwhPerUnitMean,
    limit,
  };
};

const clampProgressToDirection = (
  progressValue: number, limit: number | null, direction: DirectionalProgress['direction'],
): number => {
  if (limit === null) return progressValue;
  return direction === 'increasing'
    ? Math.min(progressValue, limit)
    : Math.max(progressValue, limit);
};

// Exported so the live-task producer (`deferredActivePlanChartData.ts`) can
// reuse the exact planned-staircase math. History and active-plan revisions
// carry the same schedule/rate/direction shape under different names.
export const integratePlannedStaircase = (
  snapshot: Pick<DeferredObjectivePlanHistoryRevisionSnapshot,
    'hours' | 'kwhPerUnitMean' | 'progressDirection'>,
  anchorValue: number,
  anchorAtMs: number,
  windowEndMs: number,
  // The objective target. The planner books a buffered energy floor, so cap
  // the drawn trajectory at the target in the direction of travel. Null leaves
  // it uncapped for legacy callers.
  capValue: number | null = null,
): DeferredPlanHistoryChartPoint[] => {
  // Stepped line: one anchor at `anchorAtMs` (progress = `anchorValue`), plus a
  // pair of anchors per planned hour — one at the hour's *start* carrying the
  // previous cumulative value, one at the hour's *end* carrying the new value.
  // With ECharts' `step: 'end'`, that draws a horizontal segment from the
  // previous anchor to the hour's start, then a vertical riser across the hour
  // itself, landing on the new level by hour-end. This matters for
  // non-contiguous schedules: a plan with allocations at T0 + T+4h (idle hours
  // between) must read as flat from the anchor → T0, riser at T0, flat at the
  // new level until T+4h, second riser, then flat. Without the hour-start
  // anchor, the staircase would imply a smooth climb across the idle gap.
  //
  // The anchor is the window start + recorded start progress for the original
  // staircase, but the *revised* staircase re-anchors at the measured progress
  // when the revision was computed (`revisedAtMs`) so it reads as "from where
  // the device had actually reached at re-plan time" rather than re-climbing
  // from the task-start temperature. Hours that fully elapsed before the anchor
  // are dropped (they're already reflected in the observed line); for the
  // original staircase the anchor is the window start so nothing is dropped.
  //
  // `kwhPerUnitMean` is "kWh per unit" (kWh/°C or kWh/%) per
  // `notes/objective-profile-bands.md`. Guard against a zero or missing rate
  // and an unresolved direction rather than inventing a trajectory.
  const progressRate = resolveDirectionalProgress(snapshot, capValue, anchorValue);
  if (progressRate === null) return [];
  const sortedHours = [...snapshot.hours].sort((a, b) => a.startsAtMs - b.startsAtMs);
  const points: DeferredPlanHistoryChartPoint[] = [
    { atMs: anchorAtMs, value: anchorValue },
  ];
  let cumulativeProgress = anchorValue;
  let lastAnchorAtMs = anchorAtMs;
  for (const hour of sortedHours) {
    // Anchor end-of-hour at `startsAtMs + 1h` so the stepped line draws a
    // horizontal segment across the hour's full duration. Clamp to the
    // deadline so a plan that overshoots the window doesn't push the last
    // point past the chart's right edge.
    const endOfHour = Math.min(windowEndMs, hour.startsAtMs + HOUR_MS);
    // Drop hours that fully elapsed before the anchor (only possible on a
    // re-anchored revised staircase). The original staircase anchors at the
    // window start, so every hour ends after it and nothing is dropped.
    if (endOfHour <= anchorAtMs) continue;
    const plannedKWh = Number.isFinite(hour.plannedKWh) ? Math.max(0, hour.plannedKWh) : 0;
    // Credit only the portion of this hour's booked energy that falls after the
    // anchor — the pre-anchor portion is already on the observed line. The energy
    // covers `[coverStart, endOfHour]`, where `coverStart` is the trim point for
    // an already-trimmed current hour (`coversFromMs`) or the hour boundary for a
    // full-hour floor. Prorate by the post-anchor fraction of that covered span:
    //   • full-hour floor straddling the anchor → prorated by the post-anchor
    //     fraction of the hour;
    //   • trimmed hour whose trim point is at/after the anchor → fraction 1
    //     (added whole; prorating an already-trimmed value would double-trim);
    //   • trimmed hour carried forward with a trim point BEFORE the anchor (an
    //     earlier same-hour revision's floor) → prorated over its covered span,
    //     dropping the `[coverStart, anchor]` sliver that predates the anchor.
    // Hours fully after the anchor (`coverStart >= anchorAtMs`) keep fraction 1,
    // so the original staircase and the deadline-clamp behaviour are unchanged.
    const coverStartMs = hour.coversFromMs ?? hour.startsAtMs;
    const coveredSpanMs = endOfHour - coverStartMs;
    const postAnchorFraction = coveredSpanMs > 0
      ? Math.max(0, Math.min(1, (endOfHour - Math.max(anchorAtMs, coverStartMs)) / coveredSpanMs))
      : 1;
    // Insert an extra hour-start anchor (carrying the *previous* cumulative
    // value) only when the hour starts after the last anchor — i.e. when
    // there's a real idle gap before this hour. For contiguous schedules
    // (hour N+1 starts at hour N's end), the previous hour's end-anchor
    // already sits at this hour's start, so a second anchor at the same
    // timestamp would be redundant.
    if (hour.startsAtMs > lastAnchorAtMs) {
      points.push({ atMs: hour.startsAtMs, value: cumulativeProgress });
    }
    cumulativeProgress += plannedKWh * postAnchorFraction * progressRate.changePerKwh;
    // Clamp at the target in the direction of travel. The effective limit is
    // never beyond the starting anchor, so the cap cannot reverse the plan.
    cumulativeProgress = clampProgressToDirection(cumulativeProgress, progressRate.limit, progressRate.direction);
    points.push({ atMs: endOfHour, value: cumulativeProgress });
    lastAnchorAtMs = endOfHour;
  }
  return points;
};

// Observed progress value at `atMs`, linearly interpolated between the samples
// bracketing it. The recorder keeps only the latest progress sample per hour
// (`recordProgressSample` buckets by hour), so a mid-hour `revisedAtMs` usually
// has no sample exactly at it — interpolating between the nearest earlier and
// later samples recovers an accurate anchor instead of snapping to a stale
// prior-hour reading. Returns the last sample's value when `atMs` is at/after
// the final sample, and `null` when `atMs` precedes the first sample (no
// measured progress yet to anchor on → caller falls back to the start anchor).
// `observed` is sorted ascending by `atMs` (see `pickObservedSamples`).
// Exported for the pinned-readout producer
// (`deferredPlanHistoryDetailInteraction.ts`), which reads the measured value
// at each hour boundary with the same interpolation the staircase anchors use.
export const observedValueAt = (
  observed: readonly DeferredPlanHistoryChartPoint[],
  atMs: number,
): number | null => {
  let before: DeferredPlanHistoryChartPoint | null = null;
  for (const point of observed) {
    if (point.atMs <= atMs) {
      before = point;
      continue;
    }
    // First sample after `atMs`: interpolate from the bracketing `before`.
    if (before === null) return null;
    if (point.atMs === before.atMs) return before.value;
    const fraction = (atMs - before.atMs) / (point.atMs - before.atMs);
    return before.value + (point.value - before.value) * fraction;
  }
  return before === null ? null : before.value;
};

// Start of the first hour that actually books energy (`coversFromMs ?? startsAtMs`
// of the earliest hour with `plannedKWh > 0`), or `null` when no hour books any.
// This is where the staircase should anchor at observed reality — the device
// only departs from its current value once booked work begins, so anchoring here
// handles objectives where the device first drifts away from its target.
const firstBookedHourStartMs = (
  snapshot: Pick<DeferredObjectivePlanHistoryRevisionSnapshot, 'hours'>,
): number | null => {
  let earliest: number | null = null;
  for (const hour of snapshot.hours) {
    const plannedKWh = Number.isFinite(hour.plannedKWh) ? hour.plannedKWh : 0;
    if (plannedKWh <= 0) continue;
    const coverStartMs = hour.coversFromMs ?? hour.startsAtMs;
    if (earliest === null || coverStartMs < earliest) earliest = coverStartMs;
  }
  return earliest;
};

// Resolves where a planned staircase should START — the anchor `{ value, atMs }`
// integrated forward from. Anchors at the observed value at the first booked
// hour's start (interpolated from the samples, seeded with the recorded start
// progress so an early bracket exists). When that booked hour is still in the
// future (no booked hour has begun), `observedValueAt` returns the latest
// sample, i.e. the live "now" value — so an in-flight task anchors at the
// current reading. Falls back to `{ startProgress, windowStartMs }`
// when there is no booked hour, or when no observation covers the booked-hour
// start (e.g. samples begin after it). Producer-resolved per
// `feedback_layering_resolution_in_producer`; consumers read flat points only.
export const resolveStaircaseAnchor = (
  snapshot: Pick<DeferredObjectivePlanHistoryRevisionSnapshot, 'hours'>,
  observed: readonly DeferredPlanHistoryChartPoint[],
  startProgress: number,
  windowStartMs: number,
): { value: number; atMs: number } => {
  const firstBookedMs = firstBookedHourStartMs(snapshot);
  if (firstBookedMs === null) return { value: startProgress, atMs: windowStartMs };
  const bracketed = [{ atMs: windowStartMs, value: startProgress }, ...observed];
  const anchorValue = observedValueAt(bracketed, firstBookedMs);
  return anchorValue === null
    ? { value: startProgress, atMs: windowStartMs }
    : { value: anchorValue, atMs: firstBookedMs };
};

// Builds the revised (final-plan) staircase, re-anchored at the measured
// progress when that revision was computed (`revisedAtMs`) so a mid-run replan
// reads as "from where the device actually was" instead of re-climbing from the
// recorded task-start progress. The recorded start progress is seeded as the
// first interpolation bracket (`[windowStartMs, startProgress]`) so a replan in
// the task's first hour — whose seeded start sample the recorder may have
// overwritten with a later same-hour reading — still interpolates from start
// rather than losing the anchor. Falls back to the start-anchored plan only when
// the revision is at/before the window start (no real replan to re-anchor on).
// See `notes/deferred-load-objectives/execution-adaptation.md` work item 1.
const buildRevisedStaircase = (
  snapshot: DeferredObjectivePlanHistoryRevisionSnapshot,
  observed: readonly DeferredPlanHistoryChartPoint[],
  startProgress: number,
  window: { windowStartMs: number; windowEndMs: number; capValue: number | null },
): DeferredPlanHistoryChartPoint[] => {
  const { windowStartMs, windowEndMs, capValue } = window;
  const revisedAtMs = snapshot.revisedAtMs;
  if (Number.isFinite(revisedAtMs) && revisedAtMs > windowStartMs) {
    const bracketed = [{ atMs: windowStartMs, value: startProgress }, ...observed];
    const anchorValue = observedValueAt(bracketed, revisedAtMs);
    if (anchorValue !== null) {
      return integratePlannedStaircase(snapshot, anchorValue, revisedAtMs, windowEndMs, capValue);
    }
  }
  return integratePlannedStaircase(snapshot, startProgress, windowStartMs, windowEndMs, capValue);
};

// Primary staircase for a run with no usable original (no original plan, or a
// satisfied-then-drifted run whose original was empty/rate-less because target
// was already met at creation): the final plan is the only real schedule, so
// anchor it at the observed value where its booked work starts rather than
// start-anchored — see `composeTrajectoryData`. Empty when there is
// no final plan to fall back to.
const resolveFallbackPrimaryStaircase = (
  finalPlan: DeferredObjectivePlanHistoryRevisionSnapshot | null,
  observed: readonly DeferredPlanHistoryChartPoint[],
  startProgress: number,
  window: { windowStartMs: number; windowEndMs: number; capValue: number | null },
): DeferredPlanHistoryChartPoint[] => {
  if (finalPlan === null) return [];
  const anchor = resolveStaircaseAnchor(finalPlan, observed, startProgress, window.windowStartMs);
  return integratePlannedStaircase(finalPlan, anchor.value, anchor.atMs, window.windowEndMs, window.capValue);
};

const staircasesDiffer = (
  a: DeferredPlanHistoryChartPoint[],
  b: DeferredPlanHistoryChartPoint[],
): boolean => {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    // Equal lengths put both in range; a missing slot could only mean the two
    // staircases are not the same series, which is what this reports.
    if (left === undefined || right === undefined) return true;
    if (left.atMs !== right.atMs) return true;
    if (Math.abs(left.value - right.value) > 0.001) return true;
  }
  return false;
};

// Coerce a kind-tagged optional progress field to a finite number, or null
// when the recorder never captured it. Shared by start-progress and target
// pickers so both apply the same null/finite guard.
const finiteOrNull = (raw: number | null): number | null => (
  raw === null || !Number.isFinite(raw) ? null : raw
);

const pickStartProgress = (
  entry: Pick<
    ResolvedDeferredObjectivePlanHistoryEntry,
    'startProgressValue'
  >,
): number | null => finiteOrNull(entry.startProgressValue);

const pickTargetValue = (
  entry: Pick<
    ResolvedDeferredObjectivePlanHistoryEntry,
    'targetValue'
  >,
): number | null => finiteOrNull(entry.targetValue);

// Prepend the run's start reading at the window start when the first observed
// sample lands later (the recorder often misses the opening cycle, so the line
// would otherwise begin mid-chart and read as a data gap / glitch). No-op when
// there's no start value or a sample already covers the window start. Exported
// so the live-task producer applies the same anchoring.
export const anchorObservedAtStart = (
  observed: readonly DeferredPlanHistoryChartPoint[],
  windowStartMs: number,
  startProgress: number | null,
): DeferredPlanHistoryChartPoint[] => {
  if (startProgress === null) return [...observed];
  const firstObserved = observed[0];
  if (firstObserved !== undefined && firstObserved.atMs <= windowStartMs) return [...observed];
  return [{ atMs: windowStartMs, value: startProgress }, ...observed];
};

const pickObservedSamples = (
  entry: Pick<
    ResolvedDeferredObjectivePlanHistoryEntry,
    'progressSamples'
  >,
): DeferredPlanHistoryChartPoint[] => {
  if (!Array.isArray(entry.progressSamples) || entry.progressSamples.length === 0) {
    return [];
  }
  const out: DeferredPlanHistoryChartPoint[] = [];
  for (const sample of entry.progressSamples) {
    if (!Number.isFinite(sample.atMs)) continue;
    const { value } = sample;
    if (value === null || !Number.isFinite(value)) continue;
    out.push({ atMs: sample.atMs, value });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
};

const hasUsableTrajectory = (
  observed: readonly DeferredPlanHistoryChartPoint[],
  originalSnapshotMean: number | undefined,
  finalSnapshotMean: number | undefined,
): boolean => {
  // Trajectory mode is the right shape as soon as we have *either* enough
  // observation samples to draw the actual progress line OR a usable rate to
  // draw the planned staircase. Two observed points are the minimum to draw
  // a line (one point alone would only render a dot in unit space, which
  // reads worse than the legacy bar chart). A positive rate on either
  // snapshot is enough to draw the staircase even when no observation
  // samples landed (e.g. PELS restarted before any diagnostic cycle).
  if (observed.length >= 2) return true;
  if (typeof originalSnapshotMean === 'number' && originalSnapshotMean > 0) return true;
  if (typeof finalSnapshotMean === 'number' && finalSnapshotMean > 0) return true;
  return false;
};

const pickMetMarker = (
  entry: Pick<ResolvedDeferredObjectivePlanHistoryEntry, 'outcome' | 'metAtMs'>,
): number | null => {
  if (entry.outcome !== 'met') return null;
  if (entry.metAtMs === null || !Number.isFinite(entry.metAtMs)) return null;
  return entry.metAtMs;
};

// Y-coordinate for the met marker. Target-reached runs land on the target
// line (their natural reading); stalled runs (either `'stalled'` inside
// the hysteresis band or `'stalled_device_capped'` against the device's
// own setpoint cap) land on the captured plateau reading from
// `finalProgress*`, which is exactly where the observed line stopped.
// Falls back to `null` if either the marker timestamp is absent or the
// entry's frozen plateau reading is missing — the chart treats null the
// same as a no-marker run.
const pickMetMarkerValue = (
  entry: Pick<
    ResolvedDeferredObjectivePlanHistoryEntry,
    'outcome'
    | 'metReason'
    | 'metAtMs'
    | 'targetValue'
    | 'finalProgressValue'
  >,
): number | null => {
  if (pickMetMarker(entry) === null) return null;
  // A run met at its car's own charge limit stops below the target line too.
  if (
    entry.metReason === 'stalled'
    || entry.metReason === 'stalled_device_capped'
    || entry.metReason === 'observed_limit'
  ) {
    const finalProgress = entry.finalProgressValue;
    return finalProgress !== null && Number.isFinite(finalProgress) ? finalProgress : null;
  }
  return pickTargetValue(entry);
};

type ChartDataEntry = Pick<
  ResolvedDeferredObjectivePlanHistoryEntry,
  'objectiveKind'
  | 'progressDirection'
  | 'targetValue'
  | 'startProgressValue'
  | 'finalProgressValue'
  | 'startedAtMs'
  | 'deadlineAtMs'
  | 'originalPlan'
  | 'finalPlan'
  | 'hourStartBookings'
  | 'progressSamples'
  | 'finalizedAtMs'
  | 'metAtMs'
  | 'metReason'
  | 'outcome'
>;

// Window + resolved anchors/cap shared across the trajectory compose helpers,
// grouped so each helper stays within the parameter budget. `startProgress` /
// `target` are the kind-resolved values (null when the entry recorded neither).
type TrajectoryFrame = {
  windowStartMs: number;
  windowEndMs: number;
  startProgress: number | null;
  target: number | null;
};

// Displayed measured series for the trajectory chart. Start-anchored real
// samples when ≥ 2 points exist (a drawable line); otherwise NEVER a
// pseudo-line off the echoed start reading alone — a sample-less entry falls
// back to the honest two-point start→final segment when both readings were
// recorded on the entry, else to no measured series at all (the view then
// suppresses the Measured legend item and shows the absent-observations
// caption). Review round 2 P0: the previous behaviour let the single echoed
// start reading masquerade as measured data in the pinned readout.
const resolveDisplayedObserved = (
  entry: Pick<ChartDataEntry, 'finalProgressValue' | 'finalizedAtMs'>,
  observed: readonly DeferredPlanHistoryChartPoint[],
  frame: TrajectoryFrame,
): DeferredPlanHistoryChartPoint[] => {
  const anchored = anchorObservedAtStart(observed, frame.windowStartMs, frame.startProgress);
  if (anchored.length >= 2) return anchored;
  const finalValue = entry.finalProgressValue;
  // The synthetic segment ends at finalisation (clamped to the window), never
  // the deadline — an early-finalised run must not draw an implied post-stop
  // trajectory it never lived. No finite finalisation time → no honest
  // endpoint → no synthetic line.
  const endAtMs = Number.isFinite(entry.finalizedAtMs)
    ? Math.min(entry.finalizedAtMs, frame.windowEndMs)
    : null;
  if (
    frame.startProgress !== null && finalValue !== null && Number.isFinite(finalValue)
    && endAtMs !== null && endAtMs > frame.windowStartMs
  ) {
    return [
      { atMs: frame.windowStartMs, value: frame.startProgress },
      { atMs: endAtMs, value: finalValue },
    ];
  }
  return [];
};

// Assembles the flat trajectory payload from already-resolved staircases. The
// displayed measured line is anchored at the run start so it doesn't begin
// mid-chart (the raw `observed` still feeds the revised-staircase re-anchor,
// which does its own start bracketing). Shared by both compose branches.
const buildTrajectoryPayload = (
  entry: ChartDataEntry,
  plannedOriginal: DeferredPlanHistoryChartPoint[],
  plannedFinal: DeferredPlanHistoryChartPoint[] | null,
  observed: DeferredPlanHistoryChartPoint[],
  frame: TrajectoryFrame,
): DeferredPlanHistoryChartData => {
  // A non-null `plannedFinal` is guaranteed non-empty by the compose branches;
  // `replanned` and the visible staircase derive from that single fact so the
  // chart, readout, marker and compare-toggle can never disagree about
  // whether a replan happened.
  const replanned = plannedFinal !== null && plannedFinal.length > 0;
  return {
    mode: 'trajectory',
    unit: deadlineLabels(entry.objectiveKind).targetUnit,
    windowStartMs: frame.windowStartMs,
    windowEndMs: frame.windowEndMs,
    plannedOriginal,
    plannedFinal,
    plannedVisible: replanned ? plannedFinal : plannedOriginal,
    replanned,
    observed: resolveDisplayedObserved(entry, observed, frame),
    // Bands shade the hours that had work booked when they began. The final
    // plan alone would shade only what was still ahead at its last revision,
    // since every hourly re-plan drops the hours that have passed.
    runBands: resolveRunBands(
      pickScheduledHours(entry) ?? [],
      frame.windowStartMs,
      frame.windowEndMs,
    ),
    target: pickTargetValue(entry),
    metAtMs: pickMetMarker(entry),
    metMarkerValue: pickMetMarkerValue(entry),
  };
};

// Standard trajectory: the start-anchored original is the from-start intent
// reference, with a re-anchored "Revised trajectory" overlay on a real replan.
// Split out so the parent's branching complexity stays inside ESLint's threshold.
const composeDirectionalTrajectory = (
  entry: ChartDataEntry,
  observed: DeferredPlanHistoryChartPoint[],
  frame: TrajectoryFrame,
): DeferredPlanHistoryChartData => {
  const { windowStartMs, windowEndMs, startProgress, target } = frame;
  // Planned staircase requires the start-progress anchor — without it the first
  // segment has no y-value and the line would float arbitrarily. Drop the
  // staircase but keep the observed line; the view renders observed-only when
  // planned is empty.
  const plannedOriginal = entry.originalPlan !== null && startProgress !== null
    ? integratePlannedStaircase(entry.originalPlan, startProgress, windowStartMs, windowEndMs, target)
    : [];
  // Start-anchored final, the like-anchored replan-detection baseline: comparing
  // the original against a like-anchored final means a re-anchor alone never
  // reads as a replan — only a genuinely different schedule does.
  const plannedFinalStartAnchored = entry.finalPlan !== null && startProgress !== null
    ? integratePlannedStaircase(entry.finalPlan, startProgress, windowStartMs, windowEndMs, target)
    : [];
  // A real replan = the original and final plans differ when anchored the same
  // way. Only then overlay a "Revised trajectory", re-anchored at the measured
  // progress when the revision was computed; a single-revision task shows just
  // the original.
  const replanned = plannedOriginal.length > 0
    && plannedFinalStartAnchored.length > 0
    && staircasesDiffer(plannedOriginal, plannedFinalStartAnchored);
  const plannedFinalCandidate = replanned && entry.finalPlan !== null && startProgress !== null
    ? buildRevisedStaircase(entry.finalPlan, observed, startProgress, { windowStartMs, windowEndMs, capValue: target })
    : [];
  const plannedFinal = plannedFinalCandidate.length > 0 ? plannedFinalCandidate : null;
  // Legacy entry with no recorded original: the final plan is the only schedule,
  // so surface it as the primary line anchored at the observed value where its
  // booked work starts rather than floating. The satisfied-then-drift case is
  // handled by the caller's early return.
  const fallbackPrimary = startProgress !== null
    ? resolveFallbackPrimaryStaircase(
      entry.finalPlan, observed, startProgress, { windowStartMs, windowEndMs, capValue: target },
    )
    : [];
  const resolvedOriginal = plannedOriginal.length > 0 ? plannedOriginal : fallbackPrimary;
  return buildTrajectoryPayload(entry, resolvedOriginal, plannedFinal, observed, frame);
};

// Compose the trajectory-mode payload once the gate (`hasUsableTrajectory`)
// has passed. Handle a run that started on the satisfied side of its target
// separately; ordinary runs retain their start-anchored comparison.
const isProgressSatisfiedAtTarget = (
  progressValue: number | null,
  targetValue: number | null,
  direction: ResolvedDeferredObjectivePlanHistoryEntry['progressDirection'],
): boolean => {
  if (progressValue === null || targetValue === null) return false;
  if (direction === 'increasing') return progressValue >= targetValue;
  if (direction === 'decreasing') return progressValue <= targetValue;
  return false;
};

const composeTrajectoryData = (
  entry: ChartDataEntry,
  observed: DeferredPlanHistoryChartPoint[],
  windowStartMs: number,
  windowEndMs: number,
): DeferredPlanHistoryChartData => {
  const startProgress = pickStartProgress(entry);
  const target = pickTargetValue(entry);
  const frame: TrajectoryFrame = { windowStartMs, windowEndMs, startProgress, target };
  const alreadySatisfiedAtStart = isProgressSatisfiedAtTarget(
    startProgress,
    target,
    entry.progressDirection,
  );
  // If the run started satisfied and later drifted across its target, the
  // recorded plan begins at that later observed value. Draw one primary line
  // from where booked work starts instead of a flat start-anchored line.
  if (startProgress !== null && target !== null && alreadySatisfiedAtStart) {
    const richest = entry.originalPlan ?? entry.finalPlan;
    const primary = resolveFallbackPrimaryStaircase(
      richest, observed, startProgress, { windowStartMs, windowEndMs, capValue: target },
    );
    return buildTrajectoryPayload(entry, primary, null, observed, frame);
  }
  return composeDirectionalTrajectory(entry, observed, frame);
};

const composeLegacyData = (
  entry: ChartDataEntry,
  windowStartMs: number,
  windowEndMs: number,
): DeferredPlanHistoryChartData => ({
  mode: 'legacy_kwh',
  unit: null,
  windowStartMs,
  windowEndMs,
  plannedOriginal: [],
  plannedFinal: null,
  plannedVisible: [],
  replanned: false,
  observed: [],
  runBands: [],
  target: pickTargetValue(entry),
  metAtMs: pickMetMarker(entry),
  metMarkerValue: pickMetMarkerValue(entry),
});

/**
 * Composes the chart payload for the history-detail page. Two modes:
 *
 *  - `trajectory` — y-axis = target unit (°C / %), planned staircase derived
 *    from `originalPlan.hours × kwhPerUnitMean` integrated from
 *    `startProgress*`, overlaid on observed `progressSamples`. The shape
 *    PR 4 introduces; matches the postmortem sentence's "Reached 38 °C by
 *    16:00" framing.
 *  - `legacy_kwh` — y-axis = kWh, planned-hour bars. The v3 fallback for
 *    entries that predate PR 1's recorder, used when neither
 *    `progressSamples[]` (≥ 2 points) nor `kwhPerUnitMean` is available on
 *    either snapshot. The view continues to render the bar chart so legacy
 *    entries don't show an empty card.
 *
 * Per `feedback_layering_resolution_in_producer.md` the producer flattens
 * every conditional here so the view layer only consumes the resolved
 * `mode` + flat point arrays — no `progressSamples`/`kwhPerUnitMean` reach
 * the renderer.
 */
export const resolveHistoryDetailChartData = (
  entry: ChartDataEntry,
): DeferredPlanHistoryChartData => {
  const observed = pickObservedSamples(entry);
  const originalMean = entry.originalPlan?.kwhPerUnitMean;
  const finalMean = entry.finalPlan?.kwhPerUnitMean;
  const windowStartMs = entry.startedAtMs;
  const windowEndMs = entry.deadlineAtMs;
  if (!hasUsableTrajectory(observed, originalMean, finalMean)) {
    return composeLegacyData(entry, windowStartMs, windowEndMs);
  }
  const trajectory = composeTrajectoryData(entry, observed, windowStartMs, windowEndMs);
  // Defensive fall-through: if the trajectory payload is effectively empty
  // (no planned staircase because `startProgress` is null AND fewer than 2
  // observed samples), the view would render a blank chart with axes only.
  // Fall back to the legacy bar chart so the user sees the plan as it was
  // recorded rather than an empty card. Surfaced by Codex review on PR 4.
  if (trajectory.plannedOriginal.length === 0
      && trajectory.plannedFinal === null
      && trajectory.observed.length < 2) {
    return composeLegacyData(entry, windowStartMs, windowEndMs);
  }
  return trajectory;
};
