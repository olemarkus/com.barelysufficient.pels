// Receipt-shape producers for the smart-task history-detail and past-tasks list
// (v2.7.3 "history loveable" pass — see notes/v2-7-2/postmortem-chart-policy.md
// for the three-outcome asymmetry this set of helpers encodes).
//
// Lives alongside `deferredPlanHistory.ts` rather than inside it so the
// formatter file stays under the 500-LOC eslint cap. The producer/view layering
// per `feedback_layering_resolution_in_producer.md` continues to hold — every
// visible string is composed here so the view layer only renders.
//
// Why these helpers exist (per outcome shape):
//
//   - Succeeded: a 3-row receipt timeline beneath the outcome line.
//     Started → largest planned hour → ready-time. Sourced from
//     `progressSamples`, the recorded plan's largest planned hour, and
//     `metAtMs`/`deadlineAtMs`. No fabrication: each row is suppressed
//     individually when its data is missing, and the timeline itself returns
//     `null` when fewer than two rows can be composed (one row alone is
//     receipt-shaped noise).
//
//   - Missed: a short shortfall-summary chip ("Delivered 17.0 of 24.0 kWh ·
//     short ≈ 23 min"). 1-decimal precision matches the abandoned-details
//     and receipt-row rounding; NBSP between the approx glyph and the time
//     value keeps the chip from wrapping mid-figure at 320 px. Sourced from
//     the final-plan total kWh, observed delivery, and the start→target
//     span the run was meant to cover (the heuristic suppresses itself
//     rather than defaulting a missing start reading to 0). No red — the
//     chip consumes the muted/info tone already in CSS.
//
//   - Cost narrative chip (Succeeded + Missed): "≈ 12 kr". Whole kroner.
//     Suppressed when `totalCost` is missing or the cost unit is empty.
//     The per-kWh average half ("1.20 kr/kWh on average") was dropped in
//     v2.7.3 — it read as an audit rather than a receipt. The "% under
//     peak" framing the spec sketched is still unavailable (history entries
//     don't carry per-hour spot prices); it will land when the per-hour
//     contributions wiring populates real prices.
//
//   - Abandoned: collapsed-by-default `<details>` payload with the last
//     delivered kWh and last device state — composed here so the view
//     stays a flat renderer. A "last price tier" line was considered but
//     dropped: history entries don't carry per-hour spot prices, so it
//     would be fabricated. See `formatPlanHistoryAbandonedDetails`.
//
//   - Weekly archive (DeadlinesHistoryList): ISO-week section headings
//     ("This week · 3 succeeded · 1 missed · ≈ 41 kr"). Sliced into the sibling
//     `deferredPlanHistoryIsoWeekArchive.ts` (re-exported below) so this file
//     stays under the 500-LOC cap; the grouping + heading copy still live in
//     the producer layer so the view never inspects per-week aggregates.
//
//   - 7-day hit-rate strip: the rolling "Last 7 days" summary pill above the
//     archive. Sliced into the sibling `deferredPlanHistory7DayStrip.ts`
//     (re-exported below) for the same reason.

import type {
  DeferredObjectivePlanHistoryRevisionSnapshot,
  ResolvedDeferredObjectivePlanHistoryEntry,
  ResolvedDeferredObjectivePlanHistoryProgressSample,
} from '../../contracts/src/deferredObjectivePlanHistory';
import { APPROX_GLYPH } from './deadlineLabels';
import {
  formatReceiptAbandonedDelivered,
  formatCostFigure,
  formatReceiptCostAmount,
  formatReceiptCostAverage,
  formatReceiptCostDelivered,
  formatReceiptCostNarrative,
  formatReceiptDeliveredBare,
  formatReceiptDeliveredOf,
  formatReceiptDurationHours,
  formatReceiptDurationHoursMinutes,
  formatReceiptDurationMinutes,
  formatReceiptPlannedKWh,
  formatReceiptReadyMargin,
  formatReceiptShortfall,
  formatReceiptStartFromPercent,
  formatReceiptStartFromTemperature,
  formatReceiptWeekCost,
  scaleRawCostToDisplay,
  resolveEntryCostDisplay,
  RECEIPT_DURATION_ZERO,
  RECEIPT_FRAGMENT_SEPARATOR,
  RECEIPT_LAST_STATE_BEHIND_NO_TIME_CHARGE,
  RECEIPT_LAST_STATE_BEHIND_NO_TIME_HEAT,
  RECEIPT_LAST_STATE_BEHIND_SCHEDULE,
  RECEIPT_LAST_STATE_CHARGING_ON_SCHEDULE,
  RECEIPT_LAST_STATE_HEATING_ON_SCHEDULE,
  RECEIPT_LAST_STATE_TARGET_REACHED,
  RECEIPT_ROW_LABEL_LARGEST_PLANNED_HOUR,
  RECEIPT_ROW_LABEL_READY,
  RECEIPT_ROW_LABEL_STARTED,
} from './deferredPlanHistoryReceiptStrings';
import { priceRateLabelToAmountUnit } from './price/priceUnitLabel';
import { formatTimeInTimeZone } from './utils/dateUtils';

const MINUTE_MS = 60 * 1000;

// The ISO-week archive grouping and the 7-day hit-rate strip were sliced into
// sibling modules so this file stays under the 500-LOC eslint cap. Re-export
// their public symbols here so every consumer (runtime + the smart_tasks
// widget) keeps importing from this single entry point.
export {
  groupPlanHistoryByIsoWeek,
  type PlanHistoryWeekGroup,
} from './deferredPlanHistoryIsoWeekArchive';
export {
  resolvePlanHistory7DayHitRateStrip,
  type PlanHistory7DayHitRateStrip,
} from './deferredPlanHistory7DayStrip';

// ─── Receipt timeline (Succeeded shape) ───────────────────────────────────────

export type PlanHistoryReceiptRow = {
  // Short label, sentence-cased, no trailing punctuation. The view renders
  // these as the leading text in each row. Examples: "Started",
  // "Largest planned hour", "Ready".
  label: string;
  // Pre-formatted local clock label (`HH:MM`), tabular-nums-safe at the view
  // layer. Held separate from `label` so the view can align the time column.
  time: string;
  // Optional detail tail — e.g. "0.18 kWh start", "18 min before 07:00".
  // Null when the row has nothing additional to say.
  detail: string | null;
};

const formatClock = (atMs: number, timeZone: string): string | null => {
  if (!Number.isFinite(atMs)) return null;
  const date = new Date(atMs);
  if (Number.isNaN(date.getTime())) return null;
  return formatTimeInTimeZone(
    date,
    { hour: '2-digit', minute: '2-digit', hour12: false },
    timeZone,
  );
};

const formatMargin = (ms: number): string => {
  if (ms <= 0) return RECEIPT_DURATION_ZERO;
  const totalMinutes = Math.floor(ms / MINUTE_MS);
  if (totalMinutes < 60) return formatReceiptDurationMinutes(totalMinutes);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return formatReceiptDurationHours(hours);
  return formatReceiptDurationHoursMinutes(hours, minutes);
};

const formatStartProgress = (
  entry: Pick<ResolvedDeferredObjectivePlanHistoryEntry,
    'objectiveKind' | 'startProgressValue'>,
): string | null => {
  // Value selection is unit-agnostic (resolved on the producer boundary); only
  // the formatter (°C vs %) stays kind-specific.
  const startValue = entry.startProgressValue;
  if (startValue === null) return null;
  return entry.objectiveKind === 'temperature'
    ? formatReceiptStartFromTemperature(startValue.toFixed(1))
    : formatReceiptStartFromPercent(startValue.toFixed(0));
};

// Threshold (in the resolved unit-agnostic value space) above which a progress
// sample counts as the device having moved off its start reading. A single
// 0.5 threshold serves both kinds now that samples are pre-resolved: temperature
// keeps its prior 0.5 °C sensitivity and EV SoC tightens from the previous 1 %
// to 0.5 (a sanctioned behaviour change — half a percentage point of charge is
// real motion).
const MOTION_THRESHOLD = 0.5;

// True when a progress sample's resolved `value` has shifted off the entry's
// start reading by at least `MOTION_THRESHOLD`.
const sampleShowsMotion = (
  sample: ResolvedDeferredObjectivePlanHistoryProgressSample,
  startValue: number | null,
): boolean => {
  if (startValue === null || sample.value === null) return false;
  return Math.abs(sample.value - startValue) >= MOTION_THRESHOLD;
};

// Anchor sample for the "Started" row: the sample immediately BEFORE the
// first sample whose value moved off the start reading (`samples[0]` is the
// at-start reading). The first moved sample is taken AFTER the device
// engaged — stamping its clock reads one sample late; the preceding sample
// is the last still-at-start moment, the honest lower bound for when it
// engaged. Null when no shift is detected (caller falls back to startedAtMs).
const startAnchorSample = (
  samples: ReadonlyArray<ResolvedDeferredObjectivePlanHistoryProgressSample> | undefined,
  startValue: number | null,
): ResolvedDeferredObjectivePlanHistoryProgressSample | null => {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const motionIndex = samples.findIndex((sample, index) => index > 0 && sampleShowsMotion(sample, startValue));
  if (motionIndex <= 0) return null;
  return samples[motionIndex - 1] ?? null;
};

const pickLargestHour = (
  snapshot: DeferredObjectivePlanHistoryRevisionSnapshot | null,
): { startsAtMs: number; plannedKWh: number } | null => {
  if (snapshot === null) return null;
  let best: { startsAtMs: number; plannedKWh: number } | null = null;
  for (const hour of snapshot.hours) {
    if (!Number.isFinite(hour.plannedKWh) || hour.plannedKWh <= 0) continue;
    if (best === null || hour.plannedKWh > best.plannedKWh) {
      best = { startsAtMs: hour.startsAtMs, plannedKWh: hour.plannedKWh };
    }
  }
  return best;
};

/**
 * Composes the three-row receipt timeline rendered on the Succeeded
 * history-detail hero. Returns `null` when fewer than two rows can be
 * composed honestly — a one-row timeline reads as a fragmentary log rather
 * than the receipt the surface is meant to be.
 *
 * Rows (in render order):
 *   1. "Started" — the sample immediately before the first progress sample
 *      with motion (the last still-at-start reading), with the start reading
 *      as the detail tail. Suppressed when `progressSamples` carries < 2
 *      entries or none of them landed in time.
 *   2. "Largest planned hour" — the largest planned kWh hour from the
 *      recorded plan (preferring `finalPlan`). Detail tail names the kWh.
 *      Suppressed when no plan was recorded or every hour was zero.
 *   3. "Ready" — `metAtMs` with the margin vs deadline. Suppressed when
 *      `metAtMs` is null or the entry didn't meet its target.
 *
 * Per `feedback_layering_resolution_in_producer.md` the view never branches
 * on which rows survived — it iterates the resolved array.
 */
export const formatPlanHistoryReceiptTimeline = (
  entry: Pick<
    ResolvedDeferredObjectivePlanHistoryEntry,
    'outcome'
    | 'objectiveKind'
    | 'startProgressValue'
    | 'startedAtMs'
    | 'metAtMs'
    | 'deadlineAtMs'
    | 'progressSamples'
    | 'finalPlan'
    | 'originalPlan'
  >,
  timeZone: string,
): PlanHistoryReceiptRow[] | null => {
  if (entry.outcome !== 'met') return null;
  const rows: PlanHistoryReceiptRow[] = [];

  // Row 1 — Started. Anchor on the last sample BEFORE the value moved away
  // from the start reading (the moment charging / heating actually engaged);
  // fall back to `entry.startedAtMs` when no motion was detected.
  const anchorSample = startAnchorSample(entry.progressSamples, entry.startProgressValue);
  const startTimeMs = anchorSample?.atMs ?? entry.startedAtMs;
  const startedClock = formatClock(startTimeMs, timeZone);
  if (startedClock !== null) {
    rows.push({
      label: RECEIPT_ROW_LABEL_STARTED,
      time: startedClock,
      detail: formatStartProgress(entry),
    });
  }

  // Row 2 — Largest planned hour.
  const largest = pickLargestHour(entry.finalPlan ?? entry.originalPlan);
  if (largest !== null) {
    const peakClock = formatClock(largest.startsAtMs, timeZone);
    if (peakClock !== null) {
      rows.push({
        label: RECEIPT_ROW_LABEL_LARGEST_PLANNED_HOUR,
        time: peakClock,
        detail: formatReceiptPlannedKWh(largest.plannedKWh.toFixed(1)),
      });
    }
  }

  // Row 3 — Ready.
  if (entry.metAtMs !== null && Number.isFinite(entry.metAtMs)) {
    const readyClock = formatClock(entry.metAtMs, timeZone);
    const deadlineClock = formatClock(entry.deadlineAtMs, timeZone);
    if (readyClock !== null) {
      const margin = entry.deadlineAtMs - entry.metAtMs;
      const detail = margin > 0 && deadlineClock !== null
        ? formatReceiptReadyMargin(formatMargin(margin), deadlineClock)
        : null;
      rows.push({ label: RECEIPT_ROW_LABEL_READY, time: readyClock, detail });
    }
  }

  // A single-row "timeline" is fragmentary noise — suppress it so the hero
  // falls through to the existing outcome headline alone.
  if (rows.length < 2) return null;
  return rows;
};

// ─── Missed shortfall chip ────────────────────────────────────────────────────

const sumPlannedKWh = (
  snapshot: DeferredObjectivePlanHistoryRevisionSnapshot | null,
): number => {
  if (snapshot === null) return 0;
  let total = 0;
  for (const hour of snapshot.hours) {
    if (Number.isFinite(hour.plannedKWh) && hour.plannedKWh > 0) total += hour.plannedKWh;
  }
  return total;
};

// Estimates the time shortfall as `windowMs × (remaining_gap / total_span)`
// where `total_span` is the start→target distance the run was meant to cover.
// Using the start→target span (rather than the bare target) keeps the
// heuristic honest when the start reading is well above zero (e.g. EV at 20%
// charging toward 80% — a 20%-point shortfall against a 60-point span is
// one-third of the window, not 25% of it).
const estimateTimeShortfall = (
  entry: Pick<
    ResolvedDeferredObjectivePlanHistoryEntry,
    'startProgressValue' | 'finalProgressValue' | 'targetValue'
    | 'startedAtMs' | 'deadlineAtMs'
  >,
): number | null => {
  const windowMs = entry.deadlineAtMs - entry.startedAtMs;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return null;
  // Value selection is unit-agnostic — the gap/span ratio math is identical for
  // °C and %, so read each resolved value once and run a single computation.
  const finalValue = entry.finalProgressValue;
  const targetValue = entry.targetValue;
  if (finalValue === null || targetValue === null) return null;
  // No defaulting: without a start reading we can't honestly compute the
  // start→target span the gap should be measured against. A defaulted-0
  // start would compress the span (and inflate the shortfall) whenever the
  // run started above zero — better to suppress the chip than fabricate.
  const startValue = entry.startProgressValue;
  if (startValue === null) return null;
  const gap = targetValue - finalValue;
  const totalSpan = targetValue - startValue;
  if (gap <= 0 || totalSpan <= 0) return null;
  return Math.round(windowMs * (gap / totalSpan));
};

/**
 * Composes the blameless shortfall summary chip for the Missed history-detail
 * hero. Returns `null` when no honest summary can be composed (no delivery
 * recorded, no plan total, no progress numbers — the chip would read as a
 * fabricated audit). The chip never carries red tone: the producer emits a
 * tone-neutral string and the view paints it as muted/info.
 *
 * Example: `Delivered 17 of 24 kWh · short ~23 min.`
 */
export const formatPlanHistoryShortfallChip = (
  entry: Pick<
    ResolvedDeferredObjectivePlanHistoryEntry,
    'outcome' | 'deliveredKWh' | 'finalPlan' | 'originalPlan'
    | 'startProgressValue' | 'finalProgressValue' | 'targetValue'
    | 'startedAtMs' | 'deadlineAtMs'
  >,
): string | null => {
  if (entry.outcome !== 'missed') return null;
  const parts: string[] = [];
  const plannedTotal = sumPlannedKWh(entry.finalPlan ?? entry.originalPlan);
  const hasDelivery = typeof entry.deliveredKWh === 'number'
    && Number.isFinite(entry.deliveredKWh);
  if (hasDelivery && plannedTotal > 0 && entry.deliveredKWh! < plannedTotal) {
    // v2.7.3 — 1-decimal precision so small deliveries (e.g. 0.4 kWh) don't
    // round to "0 kWh" and read as zero delivery, and so the chip matches the
    // toFixed(1) precision the abandoned-details + receipt rows already use.
    //
    // The "of {plannedTotal}" denominator is the energy the plan *scheduled*,
    // not the energy needed to reach the temperature/charge target. On a heat
    // run that lost heat faster than planned (or stayed on longer than the
    // schedule reserved), delivery can exceed the scheduled total while the
    // target is still missed — so "Delivered 14.2 of 9.9 kWh · short ≈ 49 min"
    // reads as a >100% contradiction. When delivery already meets/exceeds the
    // scheduled total, energy wasn't the limiting factor: drop the denominator
    // and show the bare delivered figure rather than a ratio over 100%.
    parts.push(formatReceiptDeliveredOf(entry.deliveredKWh!.toFixed(1), plannedTotal.toFixed(1)));
  } else if (hasDelivery) {
    parts.push(formatReceiptDeliveredBare(entry.deliveredKWh!.toFixed(1)));
  }
  const shortfallMs = estimateTimeShortfall(entry);
  if (shortfallMs !== null && shortfallMs >= MINUTE_MS) {
    // NBSP between glyph and value so the chip reads "short ≈ 23 min" rather
    // than "short ≈23 min" — matches the cost-narrative chip spacing.
    parts.push(formatReceiptShortfall(APPROX_GLYPH, formatMargin(shortfallMs)));
  }
  if (parts.length === 0) return null;
  // v2.7.3 P2 — drop trailing period; chips read as audit copy when stacked
  // with a terminal period. Sentence-tier strings still get one.
  return parts.join(RECEIPT_FRAGMENT_SEPARATOR);
};

// ─── Cost narrative chip (Succeeded + Missed) ────────────────────────────────

/**
 * Composes the cost narrative line rendered on the Succeeded and Missed
 * shapes. Returns `null` when `totalCost` is not recorded, when the cost
 * unit is empty, or on outcomes other than met / missed — any of these
 * leaves nothing honest to surface.
 *
 * Succeeded (chart-overhaul Phase 1B receipt-first redesign, signed-off
 * mock `history/v3.html`): the full receipt form
 * `≈ 3.10 kr · 0.52 kr/kWh on average · 6.0 kWh delivered` — the average
 * and delivered fragments suppress individually when `deliveredKWh` is
 * missing or zero, leaving the bare `≈ 3.10 kr`.
 *
 * Missed keeps the v2.7.3 whole-kroner `≈ 12 kr` chip: the shortfall chip
 * beside it already carries the delivered-kWh figure, so repeating it here
 * would double-surface the number ("per the existing resolvers").
 *
 * Abandoned entries pass through this helper too but get `null` back so
 * the view suppresses the chip on the quiet shape.
 *
 * The line omits its trailing period (v2.7.3 P2 fold-in) — bureaucratic
 * punctuation reads as audit prose when stacked with other chips.
 */
export const formatPlanHistoryCostNarrative = (
  entry: Pick<
    ResolvedDeferredObjectivePlanHistoryEntry,
    'outcome' | 'totalCost' | 'costDisplay' | 'deliveredKWh'
  >,
): string | null => {
  if (entry.outcome !== 'met' && entry.outcome !== 'missed') return null;
  // Format with the display the entry was RECORDED under, not a live one — a
  // later price-scheme switch must not relabel an archived figure. Legacy
  // entries fall back to the recording-era øre/kr default.
  const display = resolveEntryCostDisplay(entry);
  // Total is an amount: drop a `/kWh` rate suffix (Flow/Homey pass `kr/kWh`).
  const unit = priceRateLabelToAmountUnit(display.unit.trim());
  if (unit.length === 0) return null;
  const { totalCost } = entry;
  if (typeof totalCost !== 'number' || !Number.isFinite(totalCost)) return null;
  const displayCost = scaleRawCostToDisplay(totalCost, display.divisor);
  if (entry.outcome === 'missed') {
    return formatReceiptCostNarrative(APPROX_GLYPH, Math.round(displayCost), unit);
  }
  const parts = [formatReceiptCostAmount(APPROX_GLYPH, formatCostFigure(displayCost, unit), unit)];
  const delivered = entry.deliveredKWh;
  if (typeof delivered === 'number' && Number.isFinite(delivered) && delivered > 0) {
    parts.push(
      formatReceiptCostAverage(formatCostFigure(displayCost / delivered, unit), unit),
      formatReceiptCostDelivered(delivered.toFixed(1)),
    );
  }
  return parts.join(RECEIPT_FRAGMENT_SEPARATOR);
};

// Composes the past-task LIST row's cost meta line — `Cost ≈ N kr · M kWh
// delivered` — at WHOLE-kroner precision. Lives here, next to the whole-kr cost
// chip (`formatPlanHistoryCostNarrative`) and the divider roll-up
// (`formatWeekHeading` → `formatReceiptWeekCost`), so all three surfaces that
// show the same money on one screen round it identically; rendering the row at
// the 2-decimal precision of `formatPlanHistoryCostAndDelivered` would read as
// an audit against the whole-kr divider directly above it. That 2-decimal
// producer is deliberately left untouched for its Missed-hero fallback caller,
// which wants the finer figure when the whole-kr chips can't compose.
//
// Reuses the divider's `formatReceiptWeekCost` formatter for the cost half so
// the `≈ N kr` glyph/spacing read identically to the heading above (plain
// spaces, not the detail chip's NBSP). Unlike the cost chip this renders on
// every outcome and pairs the cost with the delivered-kWh half. Null when
// neither cost nor delivery was recorded (legacy entry) — never a 0 kr row.
export const formatPlanHistoryListCostAndDelivered = (
  entry: Pick<ResolvedDeferredObjectivePlanHistoryEntry, 'deliveredKWh' | 'totalCost' | 'costDisplay'>,
): string | null => {
  const { totalCost, deliveredKWh } = entry;
  // Scale + label with the entry's RECORDED display so a scheme switch can't
  // misrender the archived row (raw øre persisted under `divisor: 100` would
  // read ~100× too high if formatted with a live `divisor: 1`). Legacy entries
  // fall back to the recording-era øre/kr default.
  const display = resolveEntryCostDisplay(entry);
  // Total is an amount: drop a `/kWh` rate suffix so the row reads `Cost ≈ N kr`.
  const unit = priceRateLabelToAmountUnit(display.unit.trim());
  const parts: string[] = [];
  if (typeof totalCost === 'number' && Number.isFinite(totalCost) && unit.length > 0) {
    const roundedCost = Math.round(scaleRawCostToDisplay(totalCost, display.divisor));
    parts.push(`Cost ${formatReceiptWeekCost(APPROX_GLYPH, roundedCost, unit)}`);
  }
  if (typeof deliveredKWh === 'number' && Number.isFinite(deliveredKWh)) {
    parts.push(`${deliveredKWh.toFixed(1)} kWh delivered`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
};

// ─── Abandoned details (collapsed <details> body) ────────────────────────────

export type PlanHistoryAbandonedDetails = {
  // Pre-formatted clock for the finalized event ("at 04:12"). Null when the
  // entry persisted without a finalized timestamp.
  finalizedClock: string | null;
  // Sentence-shaped strings ("0.4 kWh delivered before it stopped.",
  // "Last device state: charging on schedule."). Order is the render order;
  // the view never reshuffles.
  lines: string[];
};

const formatLastDeviceState = (
  entry: Pick<ResolvedDeferredObjectivePlanHistoryEntry, 'objectiveKind' | 'finalPlan' | 'originalPlan'>,
): string | null => {
  const lastPlan = entry.finalPlan ?? entry.originalPlan;
  if (lastPlan === null) return null;
  // The recorded snapshot's status is the planner's last word for the run.
  // The status copy mirrors the active-plan vocabulary so the abandoned-detail
  // line reads consistently with how a live plan would describe itself.
  switch (lastPlan.planStatus) {
    case 'on_track':
      return entry.objectiveKind === 'ev_soc'
        ? RECEIPT_LAST_STATE_CHARGING_ON_SCHEDULE
        : RECEIPT_LAST_STATE_HEATING_ON_SCHEDULE;
    case 'at_risk':
      return RECEIPT_LAST_STATE_BEHIND_SCHEDULE;
    case 'cannot_meet':
      return entry.objectiveKind === 'ev_soc'
        ? RECEIPT_LAST_STATE_BEHIND_NO_TIME_CHARGE
        : RECEIPT_LAST_STATE_BEHIND_NO_TIME_HEAT;
    case 'satisfied':
      return RECEIPT_LAST_STATE_TARGET_REACHED;
    case 'invalid':
      return null;
    default: {
      // Exhaustiveness guard: a new DeferredObjectiveActivePlanStatusV1 member
      // must render explicit last-state copy above. Returns null for any
      // out-of-schema persisted status rather than throwing.
      const exhaustive: never = lastPlan.planStatus;
      void exhaustive;
      return null;
    }
  }
};

/**
 * Composes the body lines tucked inside the abandoned-shape `<details>`
 * disclosure. Returns `null` when nothing usable survives — the disclosure
 * is suppressed entirely in that case so the abandoned hero stays a single
 * sentence, which is honest about the lack of evidence.
 *
 * Lines surfaced (when each is present):
 *   - delivered kWh "by then"
 *   - last device-state read from the snapshot's `planStatus`
 *
 * Per `feedback_smart_task_token_design.md` the helper does not invent a
 * "last price tier" line: the recorded entry doesn't carry per-hour spot
 * prices, so any such line would be fabricated.
 */
export const formatPlanHistoryAbandonedDetails = (
  entry: Pick<
    ResolvedDeferredObjectivePlanHistoryEntry,
    'outcome' | 'finalizedAtMs' | 'deliveredKWh'
    | 'finalPlan' | 'originalPlan' | 'objectiveKind'
  >,
  timeZone: string,
): PlanHistoryAbandonedDetails | null => {
  if (entry.outcome !== 'abandoned' && entry.outcome !== 'replaced') return null;
  const lines: string[] = [];
  if (typeof entry.deliveredKWh === 'number' && Number.isFinite(entry.deliveredKWh)) {
    lines.push(formatReceiptAbandonedDelivered(entry.deliveredKWh.toFixed(1)));
  }
  const deviceState = formatLastDeviceState(entry);
  if (deviceState !== null) lines.push(deviceState);
  if (lines.length === 0) return null;
  return { finalizedClock: formatClock(entry.finalizedAtMs, timeZone), lines };
};
