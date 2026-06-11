// Producers for the smart-task history-detail receipt-first interaction layer
// (chart-overhaul Phase 1B): the "Plan changed" marker, the per-hour pinned
// readout rows under the trajectory chart and the hourly strip, the skip-reason
// sentences, and the legend labels for both surfaces.
//
// Per `feedback_layering_resolution_in_producer.md` every conditional —
// which staircase is visible, which revision explains a skipped hour, what a
// tapped hour reads — is resolved here. The view layer maps flat rows onto
// DOM and never inspects the entry's optional fields. Per
// `feedback_ui_text_shared_with_logs.md` all visible strings are composed in
// shared-domain so runtime log breadcrumbs can echo identical wording.
import type {
  DeferredObjectivePlanHistoryRevisionLogEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
  ResolvedDeferredObjectivePlanHistoryEntry,
} from '../../contracts/src/deferredObjectivePlanHistory';
import {
  deadlineLabels,
  formatProgressValueForUnit,
  formatSmartTaskTargetLabel,
  APPROX_GLYPH,
  SMART_TASK_READOUT_NOT_SCHEDULED,
} from './deadlineLabels';
import { formatPlanHistoryRevisionEntry } from './deferredPlanHistory';
import {
  observedValueAt,
  type DeferredPlanHistoryChartData,
  type DeferredPlanHistoryChartPoint,
} from './deferredPlanHistoryChartData';
import type { DeferredPlanHistoryHourlyStripData, HourlyStripBucket } from './deferredPlanHistoryHourlyStrip';
import {
  formatCostFigure,
  resolveEntryCostDisplay,
  scaleRawCostToDisplay,
  RECEIPT_NBSP,
} from './deferredPlanHistoryReceiptStrings';
import { priceRateLabelToAmountUnit } from './price/priceUnitLabel';
import { formatTimeInTimeZone } from './utils/dateUtils';

const HOUR_MS = 60 * 60 * 1000;

const floorToHour = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS;
const ceilToHour = (ms: number): number => Math.ceil(ms / HOUR_MS) * HOUR_MS;

// `h23` keeps midnight as "00:00" (a bare `hour12: false` can pick `h24` →
// "24:00" in some locales) and matches PELS's 24h labels.
const formatClock = (atMs: number, timeZone: string): string => (
  formatTimeInTimeZone(
    new Date(atMs),
    { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    timeZone,
  )
);

// ─── Card titles + legend labels ─────────────────────────────────────────────

// Strip card title — the promise the per-hour readout pays ("what did it
// cost?" must surface a per-hour price + cost on tap).
export const SMART_TASK_HISTORY_STRIP_TITLE = 'When did each hour run, and what did it cost?';

// Compact trajectory legend labels. The target item carries the value
// ("Target 65.0 °C") via `formatSmartTaskTargetLabel` so the number can't
// drift from the hero / live-page labels; the y-axis deliberately never
// shows a target tick (the 67/65 label-collision fix).
export const HISTORY_TRAJECTORY_LEGEND_MEASURED = 'Measured';
export const HISTORY_TRAJECTORY_LEGEND_PLANNED = 'Planned';
export const formatHistoryTrajectoryLegendTarget = (params: {
  targetValue: number;
  targetUnit: '°C' | '%';
}): string => formatSmartTaskTargetLabel(params);

// Price-level legend chips under the hourly strip. "Price low/normal/high"
// names the price tier (the bar height is energy, the colour is price);
// the dashed sample explains the planned-but-skipped outline.
export const HISTORY_STRIP_LEGEND_PRICE_LOW = 'Price low';
export const HISTORY_STRIP_LEGEND_PRICE_NORMAL = 'Price normal';
export const HISTORY_STRIP_LEGEND_PRICE_HIGH = 'Price high';
// One phrasing + casing for the dashed "scheduled but nothing ran" grammar —
// the legend sample and the readout verdict are the SAME string so the two
// surfaces can't drift (review round 2 P2; canonical row in
// `notes/ui-terminology.md`).
export const HISTORY_STRIP_PLANNED_NOT_RUN = 'Planned, didn’t run';
export const HISTORY_STRIP_LEGEND_SKIPPED = HISTORY_STRIP_PLANNED_NOT_RUN;

// Toggle that reveals the dashed original staircase on revised runs. Lives
// inside the expanded details, ≥44 px target (`.md-switch-row`).
export const HISTORY_COMPARE_INITIAL_PLAN_LABEL = 'Compare with initial plan';

// ─── Plan-change marker ───────────────────────────────────────────────────────

export type HistoryPlanChangeMarker = {
  // Wall-clock instant of the first post-start revision (the replan the
  // marker pins). The chart draws a vertical hairline here.
  atMs: number;
  // "Plan changed 21:00" — the on-chart marker label.
  label: string;
  // "Plan changed here — tomorrow’s prices published (+3h −3h)" — the pinned
  // readout's second line when the tapped hour contains the marker. Falls
  // back to the bare "Plan changed here" when the revision reason is unknown
  // (mirrors the diff-chip suppression rule on fallback revision rows).
  readoutLine: string;
};

const PLAN_CHANGED_MARKER_WORD = 'Plan changed';
const PLAN_CHANGED_HERE = 'Plan changed here';

// Lowercase a revision-reason label for mid-sentence use after the em-dash
// ("Plan changed here — tomorrow’s prices published"). Labels that lead with
// a proper noun keep their capital.
const MID_SENTENCE_PRESERVED_PREFIXES = ['Flow', 'PELS', 'Nordpool'];

const lowercaseLabelMidSentence = (label: string): string => {
  if (MID_SENTENCE_PRESERVED_PREFIXES.some((prefix) => label.startsWith(prefix))) return label;
  return label.charAt(0).toLowerCase() + label.slice(1);
};

type MarkerEntry = Pick<
  ResolvedDeferredObjectivePlanHistoryEntry,
  'revisions' | 'objectiveKind' | 'startedAtMs' | 'finalPlan'
>;

// Bare `schedule_revised` resolves to the label "Schedule revised" — appended
// after "…plan change — " it reads as a tautology ("plan change — schedule
// revised"), so the skip sentence treats it like a fallback row and keeps the
// stem only (review round 2 P2).
const isBareScheduleRevised = (
  revision: Pick<DeferredObjectivePlanHistoryRevisionLogEntry, 'reasonId'>,
): boolean => revision.reasonId === 'schedule_revised';

const firstPostStartRevision = (
  entry: MarkerEntry,
): DeferredObjectivePlanHistoryRevisionLogEntry | null => {
  if (!Array.isArray(entry.revisions) || entry.revisions.length === 0) return null;
  const sorted = [...entry.revisions]
    .filter((revision) => Number.isFinite(revision.atMs) && revision.atMs > entry.startedAtMs)
    .sort((a, b) => a.atMs - b.atMs);
  return sorted[0] ?? null;
};

/**
 * Resolves the "Plan changed HH:MM" marker for the history trajectory chart.
 *
 * Returns `null` unless the chart is in trajectory mode AND the run actually
 * replanned (producer-resolved `replanned`, the same gate the compare toggle
 * and series selection read) — legacy v3 entries therefore always resolve
 * `null` and keep rendering untouched. The marker instant prefers the
 * first post-start `revisions[]` entry (schema v4); entries that replanned
 * before the revision log shipped fall back to the final snapshot's
 * `revisedAtMs` with the bare readout line (no reason to attribute).
 */
export const resolveHistoryPlanChangeMarker = (
  entry: MarkerEntry,
  chartData: Pick<DeferredPlanHistoryChartData, 'mode' | 'replanned'>,
  timeZone: string,
): HistoryPlanChangeMarker | null => {
  if (chartData.mode !== 'trajectory') return null;
  if (!chartData.replanned) return null;
  const revision = firstPostStartRevision(entry);
  if (revision !== null) {
    const row = formatPlanHistoryRevisionEntry(revision, timeZone, entry.objectiveKind);
    const reasonClause = row.isFallback
      ? null
      : `${lowercaseLabelMidSentence(row.reason)}${row.hourDiff !== null ? ` (${row.hourDiff})` : ''}`;
    return {
      atMs: revision.atMs,
      label: `${PLAN_CHANGED_MARKER_WORD} ${formatClock(revision.atMs, timeZone)}`,
      readoutLine: reasonClause === null ? PLAN_CHANGED_HERE : `${PLAN_CHANGED_HERE} — ${reasonClause}`,
    };
  }
  // No revision log (v4 entry from before `revisions[]` shipped) — the final
  // snapshot's own replan timestamp still pins the marker honestly, it just
  // can't explain why.
  const revisedAtMs = entry.finalPlan?.revisedAtMs;
  if (typeof revisedAtMs === 'number' && Number.isFinite(revisedAtMs) && revisedAtMs > entry.startedAtMs) {
    return {
      atMs: revisedAtMs,
      label: `${PLAN_CHANGED_MARKER_WORD} ${formatClock(revisedAtMs, timeZone)}`,
      readoutLine: PLAN_CHANGED_HERE,
    };
  }
  return null;
};

// ─── Run bands (scheduled-hour markAreas behind the trajectory) ──────────────

export type HistoryRunBand = { fromMs: number; toMs: number; label: string | null };

/**
 * Labelled run bands for the history trajectory chart. The band geometry is
 * the chart payload's own producer-resolved `runBands` (final-preferred plan,
 * merged + window-clamped in `deferredPlanHistoryChartData.ts`) — this helper
 * only decorates the first band with the kind verb ("Heating" / "Charging"),
 * same grammar as the live trajectory card. One semantic source: re-deriving
 * the spans from `finalPlan ?? originalPlan` here would let the labelled
 * bands drift from the widget/chart bands (review round 2 P2 #8).
 */
export const resolveHistoryRunBands = (
  entry: Pick<ResolvedDeferredObjectivePlanHistoryEntry, 'objectiveKind'>,
  chartData: Pick<DeferredPlanHistoryChartData, 'runBands'>,
): HistoryRunBand[] => chartData.runBands.map((band, index) => ({
  fromMs: band.fromMs,
  toMs: band.toMs,
  label: index === 0 ? deadlineLabels(entry.objectiveKind).deviceSeriesName : null,
}));

// ─── Trajectory pinned readout ────────────────────────────────────────────────

export type HistoryHourReadoutRow = {
  // Hour-aligned start of the row's hour bucket.
  atMs: number;
  // "21:00 · Measured 56.1 °C · Planned 56.5 °C" — segments suppress
  // individually when no measured / planned value covers the hour.
  primary: string;
  // Plan-change sentence when this hour contains the marker; null otherwise
  // (the view falls back to the scrub hint so the row keeps two lines).
  secondary: string | null;
};

export type HistoryHourReadout = {
  rows: HistoryHourReadoutRow[];
  // Never-empty default selection: the plan-change hour when the run
  // replanned, else the hour the target was met, else the last hour with a
  // measured value, else the first row.
  defaultIndex: number;
};

// Step-function value at `atMs` for an ECharts `step: 'end'` staircase: the
// value of the last point at or before `atMs`; null before the first point.
const stepValueAt = (
  points: readonly DeferredPlanHistoryChartPoint[],
  atMs: number,
): number | null => {
  let value: number | null = null;
  for (const point of points) {
    if (point.atMs > atMs) break;
    value = point.value;
  }
  return value;
};

const clampToWindow = (atMs: number, windowStartMs: number, windowEndMs: number): number => (
  Math.min(Math.max(atMs, windowStartMs), windowEndMs)
);

// Composes one readout row's primary line. Segments suppress individually.
const formatTrajectoryReadoutPrimary = (
  clockLabel: string,
  measured: number | null,
  planned: number | null,
  unit: '°C' | '%',
): string => {
  const parts = [clockLabel];
  if (measured !== null) {
    parts.push(`${HISTORY_TRAJECTORY_LEGEND_MEASURED} ${formatProgressValueForUnit(measured, unit)}`);
  }
  if (planned !== null) {
    parts.push(`${HISTORY_TRAJECTORY_LEGEND_PLANNED} ${formatProgressValueForUnit(planned, unit)}`);
  }
  return parts.join(' · ');
};

// Default selection precedence: plan-change hour → met hour → last measured
// hour → first row. Never empty (matches the live page's "readout is never
// blank" contract).
const resolveTrajectoryDefaultIndex = (
  indices: { markerIndex: number | null; metIndex: number | null; lastMeasuredIndex: number | null },
): number => (
  indices.markerIndex ?? indices.metIndex ?? indices.lastMeasuredIndex ?? 0
);

/**
 * Per-hour pinned-readout rows for the trajectory chart. One row per hour
 * bucket across the chart window (same grid as the hourly strip). Measured
 * values interpolate the observed samples at the hour start; planned values
 * read the VISIBLE staircase (final-preferred, falling back to the original
 * for hours the re-anchored final doesn't cover yet).
 */
export const resolveHistoryTrajectoryReadout = (
  chartData: DeferredPlanHistoryChartData,
  marker: HistoryPlanChangeMarker | null,
  timeZone: string,
): HistoryHourReadout => {
  const unit = chartData.unit ?? '°C';
  // The producer-resolved visible staircase — the same series the chart
  // draws by default — so the readout's Planned values can never disagree
  // with the line on screen (review round 2 P2 #8).
  const visiblePlanned = chartData.plannedVisible;
  // Never read a "Measured" value off fewer than two observed points: a
  // single point is just the echoed start reading (no real samples landed),
  // and `observedValueAt` would happily report it for every later hour —
  // fabricating measurements the run never took (review round 2 P0). The
  // chart-data producer already guarantees 0-or-≥2 points; this guard keeps
  // the readout honest even if a caller hands it a raw payload.
  const measuredReadable = chartData.observed.length >= 2;
  const { windowStartMs, windowEndMs } = chartData;
  const gridStartMs = floorToHour(windowStartMs);
  const gridEndMs = Math.max(ceilToHour(windowEndMs), gridStartMs + HOUR_MS);
  const markerHourMs = marker === null ? null : floorToHour(marker.atMs);
  const metHourMs = chartData.metAtMs === null ? null : floorToHour(chartData.metAtMs);
  const rows: HistoryHourReadoutRow[] = [];
  let lastMeasuredIndex: number | null = null;
  let metIndex: number | null = null;
  let markerIndex: number | null = null;
  for (let atMs = gridStartMs; atMs < gridEndMs; atMs += HOUR_MS) {
    const probeMs = clampToWindow(atMs, windowStartMs, windowEndMs);
    const measured = measuredReadable ? observedValueAt(chartData.observed, probeMs) : null;
    // Hours before the re-anchored final staircase begins read the original
    // staircase — that's what was planned for those hours at the time.
    const planned = stepValueAt(visiblePlanned, probeMs)
      ?? stepValueAt(chartData.plannedOriginal, probeMs);
    const index = rows.length;
    if (measured !== null) lastMeasuredIndex = index;
    if (metHourMs === atMs) metIndex = index;
    if (markerHourMs === atMs) markerIndex = index;
    rows.push({
      atMs,
      primary: formatTrajectoryReadoutPrimary(formatClock(atMs, timeZone), measured, planned, unit),
      secondary: markerHourMs === atMs ? marker!.readoutLine : null,
    });
  }
  return {
    rows,
    defaultIndex: resolveTrajectoryDefaultIndex({ markerIndex, metIndex, lastMeasuredIndex }),
  };
};

// ─── Hourly-strip pinned readout ──────────────────────────────────────────────

export type HistoryStripReadoutRow = {
  atMs: number;
  // "23:00 · 1.1 kWh · 0.48 kr/kWh ≈ 0.53 kr" (delivered) /
  // "22:00 · 0.8 kWh planned" (skipped) / "20:00" (gap).
  primary: string;
  // "Ran as planned" / "Skipped at the 21:00 plan change — tomorrow’s prices
  // published" / "Planned, didn’t run" / "Not scheduled". Null when the
  // bucket has nothing honest to add (delivered outside the schedule).
  secondary: string | null;
  // Short hour label rendered under the bucket on the strip's time axis
  // ("19" … "00", mock-style). `null` on buckets the cadence thins out —
  // wide windows keep first / last / every-2nd so the labels stay readable
  // when the buckets get narrow (the width-aware cadence idiom the charts
  // use). Producer-resolved per `feedback_layering_resolution_in_producer`.
  axisLabel: string | null;
};

export type HistoryStripReadout = {
  rows: HistoryStripReadoutRow[];
  // Default selection: the tallest delivered bar (the strip's most
  // informative bucket), else the first skipped bucket, else the first row.
  defaultIndex: number;
};

export const HISTORY_STRIP_RAN_AS_PLANNED = 'Ran as planned';

// Whole-integer minor units / two-decimal major units per the PELS money
// convention — shared with the cost-narrative chip so the strip readout and
// the hero round identically. NBSP between figure and unit so the readout's
// cost fragment ("≈ 0.78 kr") can't wrap mid-figure at 320 px (matches the
// receipt-chip NBSP convention in `deferredPlanHistoryReceiptStrings.ts`).
const formatMoney = (value: number, unit: string): string => (
  `${formatCostFigure(value, unit)}${RECEIPT_NBSP}${unit}`
);

type StripReadoutEntry = Pick<
  ResolvedDeferredObjectivePlanHistoryEntry,
  'revisions' | 'objectiveKind' | 'originalPlan' | 'finalPlan' | 'startedAtMs' | 'costDisplay'
>;

const snapshotHasHour = (
  snapshot: DeferredObjectivePlanHistoryRevisionSnapshot | null,
  atMs: number,
): boolean => (
  snapshot !== null && snapshot.hours.some((hour) => (
    floorToHour(hour.startsAtMs) === atMs
    && Number.isFinite(hour.plannedKWh)
    && hour.plannedKWh > 0
  ))
);

// Skip reason for a planned-but-not-delivered bucket. Attributable only when
// the hour was dropped at a replan we can name: the run genuinely replanned
// (the chart payload's producer-resolved `replanned` — the same gate the
// marker and compare toggle read), the hour is present in the original plan,
// absent from the final one, and exactly ONE revision was recorded (more than
// one makes "which replan dropped it" a guess — fall through to the neutral
// line rather than misattribute). Bare `schedule_revised` reasons keep the
// stem only, like fallback rows — "plan change — schedule revised" is a
// tautology.
const resolveSkipReason = (
  entry: StripReadoutEntry,
  replanned: boolean,
  atMs: number,
  timeZone: string,
): string => {
  const droppedFromFinal = replanned
    && snapshotHasHour(entry.originalPlan, atMs)
    && !snapshotHasHour(entry.finalPlan, atMs);
  const revisions = Array.isArray(entry.revisions) ? entry.revisions : [];
  if (droppedFromFinal && revisions.length === 1 && Number.isFinite(revisions[0]!.atMs)) {
    const row = formatPlanHistoryRevisionEntry(revisions[0]!, timeZone, entry.objectiveKind);
    const stem = `Skipped at the ${row.timeLabel} plan change`;
    return row.isFallback || isBareScheduleRevised(revisions[0]!)
      ? stem
      : `${stem} — ${lowercaseLabelMidSentence(row.reason)}`;
  }
  return HISTORY_STRIP_PLANNED_NOT_RUN;
};

const formatStripPrimary = (
  bucket: HourlyStripBucket,
  entry: StripReadoutEntry,
  timeZone: string,
): string => {
  const parts = [formatClock(bucket.atMs, timeZone)];
  if (bucket.outlinePresent) {
    if (bucket.kwh > 0) parts.push(`${bucket.kwh.toFixed(1)} kWh planned`);
    return parts.join(' · ');
  }
  if (bucket.delivered) {
    // Invariant: `delivered` implies `kwh > 0` — the strip producer only sets
    // `delivered` for contributions with `deliveredKWh > 0` and then copies
    // that value into `kwh` (see `deferredPlanHistoryHourlyStrip.ts:155`), so
    // this branch can never print a "0.0 kWh" delivered line.
    parts.push(`${bucket.kwh.toFixed(1)} kWh`);
    if (bucket.priceValue !== null && Number.isFinite(bucket.priceValue)) {
      // `priceValue` is recorded in the same raw scheme unit `totalCost`
      // accumulates in (øre for the default Norwegian scheme) — scale by the
      // ENTRY's recorded display divisor before labelling, per
      // `feedback_money_rendering_needs_divisor`.
      const display = resolveEntryCostDisplay(entry);
      const unit = priceRateLabelToAmountUnit(display.unit.trim());
      if (unit.length > 0) {
        const rate = scaleRawCostToDisplay(bucket.priceValue, display.divisor);
        const cost = rate * bucket.kwh;
        // NBSP between the approx glyph and the cost figure so "≈ 0.53 kr"
        // reads as one unbreakable token at 320 px (the breaking space stays
        // before the glyph so the rate and cost halves may wrap apart).
        parts.push(`${formatMoney(rate, unit)}/kWh ${APPROX_GLYPH}${RECEIPT_NBSP}${formatMoney(cost, unit)}`);
      }
    }
  }
  return parts.join(' · ');
};

// Bucket-count ceiling at which every bucket still gets an hour label.
// Above it the buckets are too narrow for per-bucket labels at 320 px, so
// the cadence thins to first / last / every-2nd (the same idiom the legacy
// kWh chart's `axisLabel.interval` uses).
const STRIP_AXIS_DENSE_MAX_BUCKETS = 12;

const resolveStripAxisLabel = (
  atMs: number,
  index: number,
  bucketCount: number,
  timeZone: string,
): string | null => {
  const labelled = bucketCount <= STRIP_AXIS_DENSE_MAX_BUCKETS
    || index === 0
    || index === bucketCount - 1
    || index % 2 === 0;
  if (!labelled) return null;
  // Bare zero-padded hour ("19" … "00") — the mock's per-bucket axis form;
  // the full HH:MM stays on the readout's primary line. `h23` keeps midnight
  // as "00" (a bare `hour12: false` can pick `h24` → "24" in some locales).
  return formatTimeInTimeZone(
    new Date(atMs),
    { hour: '2-digit', hourCycle: 'h23' },
    timeZone,
  );
};

/**
 * Per-bucket pinned-readout rows for the hourly strip — pays the card title's
 * "what did it cost?" promise with a per-hour `kWh · rate ≈ cost` line plus a
 * one-line verdict (ran / skipped-and-why / not scheduled), and carries the
 * per-bucket hour label for the strip's time axis.
 *
 * `chart` is the trajectory payload for the same entry — its producer-resolved
 * `replanned` is the single replan gate shared with the marker and compare
 * toggle, so the skip attribution can't disagree with the chart above.
 */
export const resolveHistoryStripReadout = (
  strip: Extract<DeferredPlanHistoryHourlyStripData, { mode: 'present' }>,
  entry: StripReadoutEntry,
  chart: Pick<DeferredPlanHistoryChartData, 'replanned'>,
  timeZone: string,
): HistoryStripReadout => {
  const rows: HistoryStripReadoutRow[] = [];
  let defaultIndex: number | null = null;
  let tallestDeliveredKwh = 0;
  let firstOutlineIndex: number | null = null;
  for (const [index, bucket] of strip.buckets.entries()) {
    let secondary: string | null;
    if (bucket.outlinePresent) {
      secondary = resolveSkipReason(entry, chart.replanned, bucket.atMs, timeZone);
      if (firstOutlineIndex === null) firstOutlineIndex = index;
    } else if (bucket.delivered) {
      secondary = bucket.planned ? HISTORY_STRIP_RAN_AS_PLANNED : null;
      if (bucket.kwh > tallestDeliveredKwh) {
        tallestDeliveredKwh = bucket.kwh;
        defaultIndex = index;
      }
    } else {
      secondary = SMART_TASK_READOUT_NOT_SCHEDULED;
    }
    rows.push({
      atMs: bucket.atMs,
      primary: formatStripPrimary(bucket, entry, timeZone),
      secondary,
      axisLabel: resolveStripAxisLabel(bucket.atMs, index, strip.buckets.length, timeZone),
    });
  }
  return { rows, defaultIndex: defaultIndex ?? firstOutlineIndex ?? 0 };
};
