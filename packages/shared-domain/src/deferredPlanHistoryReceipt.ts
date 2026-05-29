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
//     ("This week · 3 succeeded · 1 missed · ≈ 41 kr"). Grouping + heading
//     copy live here so the view layer never inspects per-week aggregates.
//     The lead label uses relative phrasing ("This week" / "Last week" /
//     "Week of 12 May") rather than the engineer-facing "Week 22" ISO number.
//     Outcome counts use the chip vocabulary (`succeeded` / `missed` /
//     `abandoned`) and surface non-zero counts only, so misses and abandons
//     don't vanish from the strip while still showing up in the per-row
//     chips. See notes/ui-terminology.md "Chip adjectives vs divider verbs".

import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryProgressSample,
  DeferredObjectivePlanHistoryRevisionSnapshot,
} from '../../contracts/src/deferredObjectivePlanHistory';
import {
  APPROX_GLYPH,
  SMART_TASK_LIST_7DAY_HIT_RATE_LABEL,
  SMART_TASK_LIST_HIT_RATE_NOUN,
} from './deadlineLabels';
import {
  formatDateInTimeZone,
  formatTimeInTimeZone,
  getPreviousLocalDayStartUtcMs,
  getStartOfDayInTimeZone,
  getWeekStartInTimeZone,
  getZonedParts,
} from './utils/dateUtils';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// Non-breaking space, used between the approx glyph + value + unit so the
// chip never wraps mid-figure ("12 / kr" breaking onto two lines at 320 px).
// v2.7.3 — `pels-m3-critic` + `pels-ux-fit` finding.
const NBSP = ' ';

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
  if (ms <= 0) return '0 min';
  const totalMinutes = Math.floor(ms / MINUTE_MS);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} min`;
};

const formatStartProgress = (
  entry: Pick<DeferredObjectivePlanHistoryEntry,
    'objectiveKind' | 'startProgressC' | 'startProgressPercent'>,
): string | null => {
  if (entry.objectiveKind === 'temperature') {
    return entry.startProgressC === null ? null : `from ${entry.startProgressC.toFixed(1)} °C`;
  }
  return entry.startProgressPercent === null ? null : `from ${entry.startProgressPercent.toFixed(0)} %`;
};

// Picks the first progress sample whose value differs from the entry's start
// reading — the moment the device actually began moving toward the target.
// `samples[0]` is the at-start reading; the first sample whose `valueC` /
// `valuePercent` has shifted is the "motion" sample. When no shift is
// detected, returns null so the caller falls back to `entry.startedAtMs`.
const sampleShowsMotion = (
  sample: DeferredObjectivePlanHistoryProgressSample,
  start: { valueC: number | null; valuePercent: number | null },
): boolean => {
  if (start.valueC !== null && sample.valueC !== null) {
    if (Math.abs(sample.valueC - start.valueC) >= 0.5) return true;
  }
  if (start.valuePercent !== null && sample.valuePercent !== null) {
    if (Math.abs(sample.valuePercent - start.valuePercent) >= 1) return true;
  }
  return false;
};

const firstSampleWithMotion = (
  samples: ReadonlyArray<DeferredObjectivePlanHistoryProgressSample> | undefined,
  start: { valueC: number | null; valuePercent: number | null },
): DeferredObjectivePlanHistoryProgressSample | null => {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  return samples.slice(1).find((sample) => sampleShowsMotion(sample, start)) ?? null;
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
 *   1. "Started" — first progress sample with motion, with the start reading
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
    DeferredObjectivePlanHistoryEntry,
    'outcome'
    | 'objectiveKind'
    | 'startProgressC'
    | 'startProgressPercent'
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

  // Row 1 — Started. Prefer the first progress sample whose value moved
  // away from the start reading (the moment charging / heating actually
  // engaged); fall back to `entry.startedAtMs` when no motion sample is
  // available.
  const motionSample = firstSampleWithMotion(entry.progressSamples, {
    valueC: entry.startProgressC,
    valuePercent: entry.startProgressPercent,
  });
  const startTimeMs = motionSample?.atMs ?? entry.startedAtMs;
  const startedClock = formatClock(startTimeMs, timeZone);
  if (startedClock !== null) {
    rows.push({
      label: 'Started',
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
        label: 'Largest planned hour',
        time: peakClock,
        detail: `${largest.plannedKWh.toFixed(1)} kWh planned`,
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
        ? `${formatMargin(margin)} before ${deadlineClock}`
        : null;
      rows.push({ label: 'Ready', time: readyClock, detail });
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
    DeferredObjectivePlanHistoryEntry,
    'objectiveKind' | 'startProgressC' | 'finalProgressC' | 'targetTemperatureC'
    | 'startProgressPercent' | 'finalProgressPercent' | 'targetPercent'
    | 'startedAtMs' | 'deadlineAtMs'
  >,
): number | null => {
  const windowMs = entry.deadlineAtMs - entry.startedAtMs;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return null;
  if (entry.objectiveKind === 'temperature') {
    if (entry.finalProgressC === null || entry.targetTemperatureC === null) return null;
    // No defaulting: without a start reading we can't honestly compute the
    // start→target span the gap should be measured against. A defaulted-0
    // start would compress the span (and inflate the shortfall) whenever the
    // run started above zero — better to suppress the chip than fabricate.
    if (entry.startProgressC === null) return null;
    const gap = entry.targetTemperatureC - entry.finalProgressC;
    const totalSpan = entry.targetTemperatureC - entry.startProgressC;
    if (gap <= 0 || totalSpan <= 0) return null;
    return Math.round(windowMs * (gap / totalSpan));
  }
  if (entry.finalProgressPercent === null || entry.targetPercent === null) return null;
  // Same honesty guard as the temperature branch — a missing start percent
  // can't be silently treated as 0 without skewing the heuristic for runs
  // that started above zero (e.g. EV at 20% charging toward 80%).
  if (entry.startProgressPercent === null) return null;
  const gap = entry.targetPercent - entry.finalProgressPercent;
  const totalSpan = entry.targetPercent - entry.startProgressPercent;
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
    DeferredObjectivePlanHistoryEntry,
    'outcome' | 'deliveredKWh' | 'finalPlan' | 'originalPlan'
    | 'objectiveKind' | 'startProgressC' | 'finalProgressC' | 'targetTemperatureC'
    | 'startProgressPercent' | 'finalProgressPercent' | 'targetPercent'
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
    parts.push(`Delivered ${entry.deliveredKWh!.toFixed(1)} of ${plannedTotal.toFixed(1)} kWh`);
  } else if (hasDelivery) {
    parts.push(`Delivered ${entry.deliveredKWh!.toFixed(1)} kWh`);
  }
  const shortfallMs = estimateTimeShortfall(entry);
  if (shortfallMs !== null && shortfallMs >= MINUTE_MS) {
    // NBSP between glyph and value so the chip reads "short ≈ 23 min" rather
    // than "short ≈23 min" — matches the cost-narrative chip spacing.
    parts.push(`short ${APPROX_GLYPH}${NBSP}${formatMargin(shortfallMs)}`);
  }
  if (parts.length === 0) return null;
  // v2.7.3 P2 — drop trailing period; chips read as audit copy when stacked
  // with a terminal period. Sentence-tier strings still get one.
  return parts.join(' · ');
};

// ─── Cost narrative chip (Succeeded + Missed) ────────────────────────────────

/**
 * Composes the cost narrative chip rendered on the Succeeded and Missed
 * shapes ("≈ 12 kr"). Returns `null` when `totalCost` is not recorded, when
 * the cost unit is empty, or on outcomes other than met / missed — any of
 * these leaves nothing honest to surface. (`deliveredKWh` is accepted on
 * the entry so a future per-kWh half can re-attach without a contract
 * change; it does not by itself gate the chip today.)
 *
 * Kroner are rendered as whole units per spec — sub-kr precision turns a
 * story into an audit.
 *
 * v2.7.3 — the "1.20 kr/kWh on average" half of the chip was dropped. The
 * original spec asked for "≈ N kr · M% under peak hours", which requires
 * per-hour spot prices the history entry doesn't carry today. The kr/kWh
 * average was a stand-in; it read as an audit rather than the receipt the
 * surface is meant to be. When per-hour spot prices land (PR12-hourly-
 * contributions wiring), this helper can compute the actual % framing.
 *
 * Abandoned entries pass through this helper too but get `null` back so
 * the view suppresses the chip on the quiet shape.
 *
 * The chip omits its trailing period (v2.7.3 P2 fold-in) — bureaucratic
 * punctuation reads as audit prose when stacked with other chips.
 */
export const formatPlanHistoryCostNarrative = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'outcome' | 'totalCost' | 'deliveredKWh'>,
  costUnit: string,
): string | null => {
  if (entry.outcome !== 'met' && entry.outcome !== 'missed') return null;
  const unit = costUnit.trim();
  if (unit.length === 0) return null;
  const hasCost = typeof entry.totalCost === 'number' && Number.isFinite(entry.totalCost);
  if (!hasCost) return null;
  return `${APPROX_GLYPH}${NBSP}${Math.round(entry.totalCost!)}${NBSP}${unit}`;
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
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'objectiveKind' | 'finalPlan' | 'originalPlan'>,
): string | null => {
  const lastPlan = entry.finalPlan ?? entry.originalPlan;
  if (lastPlan === null) return null;
  // The recorded snapshot's status is the planner's last word for the run.
  // The status copy mirrors the active-plan vocabulary so the abandoned-detail
  // line reads consistently with how a live plan would describe itself.
  switch (lastPlan.planStatus) {
    case 'on_track':
      return entry.objectiveKind === 'ev_soc'
        ? 'Last device state: charging on schedule.'
        : 'Last device state: heating on schedule.';
    case 'at_risk':
      return 'Last device state: behind schedule.';
    case 'cannot_meet':
      return entry.objectiveKind === 'ev_soc'
        ? 'Last device state: behind schedule with not enough time to finish.'
        : 'Last device state: behind schedule with not enough time to reach the target.';
    case 'satisfied':
      return 'Last device state: target already reached.';
    case 'invalid':
      return null;
    default:
      return null;
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
    DeferredObjectivePlanHistoryEntry,
    'outcome' | 'finalizedAtMs' | 'deliveredKWh'
    | 'finalPlan' | 'originalPlan' | 'objectiveKind'
  >,
  timeZone: string,
): PlanHistoryAbandonedDetails | null => {
  if (entry.outcome !== 'abandoned' && entry.outcome !== 'replaced') return null;
  const lines: string[] = [];
  if (typeof entry.deliveredKWh === 'number' && Number.isFinite(entry.deliveredKWh)) {
    lines.push(`${entry.deliveredKWh.toFixed(1)} kWh delivered before it stopped.`);
  }
  const deviceState = formatLastDeviceState(entry);
  if (deviceState !== null) lines.push(deviceState);
  if (lines.length === 0) return null;
  return { finalizedClock: formatClock(entry.finalizedAtMs, timeZone), lines };
};

// ─── ISO-week archive grouping (DeadlinesHistoryList) ────────────────────────

export type PlanHistoryWeekGroup = {
  // Stable identity for the group — ISO `YYYY-Www` (zero-padded week). The
  // view uses this as the React key.
  weekKey: string;
  // Pre-formatted heading copy ("Week 20 · 4 deadlines met · ≈ 41 kr.").
  // Renders as a quiet section break above the grouped cards.
  heading: string;
  entries: DeferredObjectivePlanHistoryEntry[];
};

// ISO week number per ISO-8601: weeks start on Monday; week 1 is the week
// containing the first Thursday of the year. Computes against the entry's
// local time zone so a Sunday-night deadline in Europe doesn't shift to the
// previous ISO week the UTC date would imply.
const computeIsoWeekKey = (ms: number, timeZone: string): { year: number; week: number } | null => {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  // Anchor the week to its Monday in the target time zone, then resolve the
  // year/week from that anchor in UTC math — `getZonedParts` returns the local
  // calendar fields, which is what ISO-8601 wants.
  const mondayMs = getWeekStartInTimeZone(date, timeZone);
  const monday = new Date(mondayMs);
  const localMonday = getZonedParts(monday, timeZone);
  // ISO-8601: the Thursday of the week determines its ISO year.
  const thursday = new Date(Date.UTC(
    localMonday.year,
    localMonday.month - 1,
    localMonday.day + 3,
  ));
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Weekday = (jan4.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  const isoWeek1Monday = new Date(Date.UTC(isoYear, 0, 4 - jan4Weekday));
  const week = Math.floor((thursday.getTime() - isoWeek1Monday.getTime()) / (7 * 24 * HOUR_MS)) + 1;
  return { year: isoYear, week };
};

const formatWeekKey = (year: number, week: number): string => (
  `${year}-W${week.toString().padStart(2, '0')}`
);

const sumEntryCost = (entries: ReadonlyArray<DeferredObjectivePlanHistoryEntry>): number => {
  let total = 0;
  for (const entry of entries) {
    if (typeof entry.totalCost === 'number' && Number.isFinite(entry.totalCost)) {
      total += entry.totalCost;
    }
  }
  return total;
};

// Resolves the relative lead label for a week's section heading. The
// past-tasks archive is a consumer surface — ISO week numbers ("Week 22")
// read as engineer-speak. Anchor on the user's current week instead.
//   - Current week → "This week"
//   - Previous week → "Last week"
//   - Older         → "Week of 12 May" (the week's Monday formatted)
//
// `weekStartMs` and `nowMs` are anchored to the supplied time zone so the
// comparison is purely calendar-bucket (which Monday does each fall on?),
// not wall-clock arithmetic — this side-steps DST cliffs where a 23h or 25h
// week would otherwise flip a boundary unexpectedly.
const formatRelativeWeekLabel = (
  weekStartMs: number,
  nowMs: number,
  timeZone: string,
): string => {
  const currentWeekStartMs = getWeekStartInTimeZone(new Date(nowMs), timeZone);
  if (weekStartMs === currentWeekStartMs) return 'This week';
  // Step one calendar week back via local-day arithmetic, never a fixed
  // 7×24h millisecond offset. `currentWeekStartMs` is local Monday 00:00;
  // stepping one local day earlier lands on the previous Sunday 00:00,
  // which is unambiguously inside the prior calendar week regardless of any
  // DST transition that week (a spring-forward 23h week or a fall-back 25h
  // week). Re-bucketing that instant through `getWeekStartInTimeZone`
  // resolves it to the previous week's Monday anchor — the same week-start
  // an entry's deadline in that week would land on. A 7×24h subtraction
  // would miss this: on a 23h week it stays inside the current week, and on
  // a 25h week it overshoots two weeks back, skipping "Last week" entirely.
  const previousWeekStartMs = getWeekStartInTimeZone(
    new Date(getPreviousLocalDayStartUtcMs(currentWeekStartMs, timeZone)),
    timeZone,
  );
  if (weekStartMs === previousWeekStartMs) return 'Last week';
  // Older weeks render as "Week of 12 May" — the Monday formatted day +
  // short month, in the user's time zone.
  const monthDay = formatDateInTimeZone(
    new Date(weekStartMs),
    { day: 'numeric', month: 'short' },
    timeZone,
  );
  return `Week of ${monthDay}`;
};

type OutcomeCounts = {
  succeeded: number;
  missed: number;
  abandoned: number;
};

// `replaced` collapses into `abandoned` for the chip strip per
// notes/ui-terminology.md — both render the same `Abandoned` chip on each
// row, and the divider summary speaks the chip language.
const countOutcomes = (
  entries: ReadonlyArray<DeferredObjectivePlanHistoryEntry>,
): OutcomeCounts => {
  const counts: OutcomeCounts = { succeeded: 0, missed: 0, abandoned: 0 };
  for (const entry of entries) {
    if (entry.outcome === 'met') counts.succeeded += 1;
    else if (entry.outcome === 'missed') counts.missed += 1;
    else if (entry.outcome === 'abandoned' || entry.outcome === 'replaced') {
      counts.abandoned += 1;
    }
  }
  return counts;
};

const formatWeekHeading = (
  weekStartMs: number,
  nowMs: number,
  timeZone: string,
  entries: ReadonlyArray<DeferredObjectivePlanHistoryEntry>,
  costUnit: string,
): string => {
  const lead = formatRelativeWeekLabel(weekStartMs, nowMs, timeZone);
  const counts = countOutcomes(entries);
  const outcomeFragments: string[] = [];
  // Chip vocabulary on the divider — see notes/ui-terminology.md
  // "Chip adjectives vs divider verbs". Non-zero counts only so a quiet
  // all-succeeded week doesn't carry a noisy "0 missed · 0 abandoned" tail,
  // and a zero-succeeded week still surfaces the misses/abandons that the
  // previous "N deadlines met" wording dropped on the floor.
  if (counts.succeeded > 0) outcomeFragments.push(`${counts.succeeded} succeeded`);
  if (counts.missed > 0) outcomeFragments.push(`${counts.missed} missed`);
  if (counts.abandoned > 0) outcomeFragments.push(`${counts.abandoned} abandoned`);
  const parts = [lead, ...outcomeFragments];
  const unit = costUnit.trim();
  const cost = sumEntryCost(entries);
  // Nordpool prices can briefly go negative; preserve the sign so a credit
  // week reads as a credit week in the archive heading rather than disappearing.
  if (unit.length > 0 && cost !== 0) {
    parts.push(`${APPROX_GLYPH} ${Math.round(cost)} ${unit}`);
  }
  // v2.7.3 P2 — drop trailing period on section headings; HTML headings
  // don't take terminal punctuation.
  return parts.join(' · ');
};

/**
 * Groups past-task history entries into ISO-week sections for the past-tasks
 * archive surface. Iterates the input in its existing newest-first order so
 * the returned groups land newest-first too; entries within each group keep
 * their input order. Returns an empty array when `entries` is empty so the
 * view can render the existing zero-state.
 *
 * `costUnit` is threaded through to the per-group heading so the rolled-up
 * cost ("≈ 41 kr") reads in the user's display currency. Empty unit drops
 * the cost half of the heading cleanly.
 *
 * `nowMs` anchors the relative-week phrasing ("This week" / "Last week" /
 * "Week of 12 May"). The view layer threads its real wall-clock time in so
 * the helper stays pure and snapshot-testable.
 */
export const groupPlanHistoryByIsoWeek = (
  entries: ReadonlyArray<DeferredObjectivePlanHistoryEntry>,
  timeZone: string,
  costUnit: string,
  nowMs: number,
): PlanHistoryWeekGroup[] => {
  const groups: PlanHistoryWeekGroup[] = [];
  const indexByKey = new Map<string, number>();
  for (const entry of entries) {
    const iso = computeIsoWeekKey(entry.deadlineAtMs, timeZone);
    // Entries with an unparseable deadline land in a synthetic bucket so they
    // still render — losing them silently would hide history from the user.
    const key = iso === null ? 'unknown' : formatWeekKey(iso.year, iso.week);
    const week = iso?.week ?? 0;
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, groups.length);
      groups.push({
        weekKey: key,
        // Heading recomputed below once the group is fully populated.
        heading: `Week ${week}`,
        entries: [entry],
      });
    } else {
      groups[existingIndex]!.entries.push(entry);
    }
  }
  // Second pass — finalise the heading copy now that each group's entries
  // are populated. Keeps the helper O(n) and avoids the temptation to
  // recompute the heading on every push.
  return groups.map((group) => {
    const weekStartMs = computeWeekStart(group.entries[0]!.deadlineAtMs, timeZone);
    const heading = weekStartMs === null
      ? `Other tasks · ${group.entries.length} ${group.entries.length === 1 ? 'task' : 'tasks'}`
      : formatWeekHeading(weekStartMs, nowMs, timeZone, group.entries, costUnit);
    return { ...group, heading };
  });
};

// Local wrapper over `getWeekStartInTimeZone` that preserves the
// "unparseable deadline" branch the heading formatter relies on. Returning
// `null` keeps the synthetic "Other tasks" bucket from accidentally
// claiming a relative-week label.
const computeWeekStart = (ms: number, timeZone: string): number | null => {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return getWeekStartInTimeZone(date, timeZone);
};

// ─── 7-day hit-rate strip (PR-10) ────────────────────────────────────────────
//
// The past-tasks surface had no single "how have my deadlines been doing this
// week?" signal — the user had to scan miss-streak chips per device + week-
// divider headings to piece together a mental aggregate. The 7-day strip is
// the first-impression number the recovering-from-mistake persona needs at a
// glance, anchored at the top of the past-tasks list.
//
// Hit-rate definition: `succeeded ÷ (succeeded + missed)`. Abandoned/replaced
// entries are excluded from the denominator on purpose — the user clearing a
// run (or the diagnostic stream going stale) isn't a planner success or
// failure, and folding it into the rate would penalise blameless aborts. The
// abandoned count still surfaces in the strip so the run isn't invisible.
//
// `replaced` collapses into `abandoned` in the strip totals, mirroring
// `countOutcomes` above and the chip-vocabulary divider headings. Other
// outcomes (`unknown` — backfill / pre-schema entries) are not counted in any
// bucket; they don't represent a meaningful planner result.

const SEVEN_DAY_WINDOW_DAYS = 7;
// Today's local date is the 7th (most recent) bucket, so the cutoff steps back
// one fewer local midnight than the bucket count.
const SEVEN_DAY_WINDOW_STEPS_BACK = SEVEN_DAY_WINDOW_DAYS - 1;

// Resolves the inclusive lower bound of the "Last 7 days" window: the window
// covers exactly `SEVEN_DAY_WINDOW_DAYS` (7) local date buckets — today's local
// date plus the 6 preceding ones — so the cutoff is today's local day-start
// stepped back `SEVEN_DAY_WINDOW_STEPS_BACK` (6) local midnights, never a fixed
// `7×24h` millisecond offset.
//
// Stepping back 7 midnights (the bucket count) would over-include: anchoring at
// today's midnight and going back 7 days spans today's partial date PLUS 7
// earlier dates — up to ~8 date buckets, an extra day's early results bleeding
// into the rate. Stepping back 6 keeps the span to exactly 7 local dates.
//
// A fixed-ms subtraction would also drift by the DST hour at week boundaries (a
// 23h spring-forward week pulls the cutoff an hour later; a 25h fall-back week
// an hour earlier), silently flipping an entry near the edge in or out of the
// window. Stepping by local days — same approach PR #1259 used for the "Last
// week" boundary — keeps the cutoff anchored to local midnight regardless of
// any DST transition in the window.
const resolveSevenDayCutoffMs = (nowMs: number, timeZone: string): number => {
  let dayStartMs = getStartOfDayInTimeZone(new Date(nowMs), timeZone);
  for (let step = 0; step < SEVEN_DAY_WINDOW_STEPS_BACK; step += 1) {
    dayStartMs = getPreviousLocalDayStartUtcMs(dayStartMs, timeZone);
  }
  return dayStartMs;
};

type SevenDayCounts = {
  succeeded: number;
  missed: number;
  abandoned: number;
  inWindow: number;
};

// Anchors an entry against the 7-day window. Prefers `finalizedAtMs` (the
// moment the run wrapped up — the right anchor for "last 7 days") and falls
// back to `deadlineAtMs` for older schema rows that persisted without a
// finalisation timestamp, so the strip doesn't silently lose legacy entries.
const resolveWindowAnchorMs = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'finalizedAtMs' | 'deadlineAtMs'>,
): number => (
  Number.isFinite(entry.finalizedAtMs) ? entry.finalizedAtMs : entry.deadlineAtMs
);

// Tallies a single entry against the 7-day counts. Returns the counts
// unchanged when the entry falls outside the window or is unparseable;
// `unknown` outcomes are counted toward `inWindow` (so the strip still
// renders when only backfill rows survive) but not toward any bucket.
const tallySevenDayEntry = (
  counts: SevenDayCounts,
  entry: DeferredObjectivePlanHistoryEntry,
  cutoffMs: number,
  nowMs: number,
): SevenDayCounts => {
  const stampMs = resolveWindowAnchorMs(entry);
  if (!Number.isFinite(stampMs)) return counts;
  if (stampMs < cutoffMs || stampMs > nowMs) return counts;
  const next: SevenDayCounts = {
    succeeded: counts.succeeded,
    missed: counts.missed,
    abandoned: counts.abandoned,
    inWindow: counts.inWindow + 1,
  };
  if (entry.outcome === 'met') next.succeeded += 1;
  else if (entry.outcome === 'missed') next.missed += 1;
  else if (entry.outcome === 'abandoned' || entry.outcome === 'replaced') {
    next.abandoned += 1;
  }
  return next;
};

export type PlanHistory7DayHitRateStrip = {
  // Pre-formatted strip copy, joined with " · ". Example:
  // `Last 7 days · 8 succeeded · 3 missed · 1 abandoned · 67% hit rate`.
  // Renders verbatim; the view never branches on the counts.
  text: string;
  // Raw aggregate so callers (telemetry, future surfaces, tests) can read
  // the numbers without re-parsing the formatted string. The producer is
  // the only place that decides what counts; consumers stay flat.
  succeeded: number;
  missed: number;
  abandoned: number;
  // Hit rate as an integer percent rounded to the nearest whole number.
  // `null` when no Succeeded + Missed entries landed in the window — a
  // strip that read "0% hit rate" off only abandoned entries would
  // misrepresent the user's experience.
  hitRatePercent: number | null;
};

/**
 * Resolves the 7-day hit-rate strip rendered above the weekly archive on
 * the past-tasks surface. Returns `null` when no history entries fall in
 * the `[cutoff, nowMs]` window — the view hides the strip entirely in
 * that case so brand-new users (or week-long quiet patches) don't see an
 * empty-looking pill.
 *
 * Window selection uses `finalizedAtMs` when present (most entries) and
 * falls back to `deadlineAtMs` for entries that finalised before the
 * `finalizedAtMs` field was persisted (older schemas, malformed records) so
 * the strip doesn't silently lose legacy rows. Both timestamps are wall-
 * clock instants. The window covers exactly 7 local date buckets — today's
 * local date plus the 6 preceding ones — so its lower bound is 6 local
 * midnights before `nowMs`'s local day-start, stepped one local day at a time
 * (never a fixed `7×24h` millisecond offset) so a 23h spring-forward or 25h
 * fall-back week inside the window doesn't drift the cutoff by an hour — the
 * same local-day stepping PR #1259 applied to the "Last week" divider boundary.
 *
 * Hit rate: `succeeded ÷ (succeeded + missed) × 100`, rounded to the
 * nearest whole percent. Abandoned/replaced and `unknown` entries are
 * excluded from the denominator — see the file-block comment above for
 * the rationale. The abandoned count still appears in the strip so the
 * runs aren't hidden from the user.
 *
 * Per `feedback_layering_resolution_in_producer.md` the producer composes
 * the visible string; the view only renders. Per
 * `feedback_ui_text_shared_with_logs.md` the same helper feeds runtime
 * log breadcrumbs so structured logs and the UI never drift.
 */
export const resolvePlanHistory7DayHitRateStrip = (
  entries: ReadonlyArray<DeferredObjectivePlanHistoryEntry>,
  nowMs: number,
  // Anchors the 7-day window's lower bound: the cutoff is 6 local midnights
  // before `nowMs`'s local day-start (7 local date buckets total — today plus
  // the 6 preceding ones), stepped one local day at a time so a 23h/25h DST
  // week doesn't drift the boundary by an hour.
  timeZone: string,
): PlanHistory7DayHitRateStrip | null => {
  if (!Number.isFinite(nowMs)) return null;
  const cutoffMs = resolveSevenDayCutoffMs(nowMs, timeZone);
  const counts = entries.reduce<SevenDayCounts>(
    (acc, entry) => tallySevenDayEntry(acc, entry, cutoffMs, nowMs),
    { succeeded: 0, missed: 0, abandoned: 0, inWindow: 0 },
  );
  if (counts.inWindow === 0) return null;
  const decisive = counts.succeeded + counts.missed;
  const hitRatePercent = decisive === 0
    ? null
    : Math.round((counts.succeeded / decisive) * 100);
  const parts: string[] = [SMART_TASK_LIST_7DAY_HIT_RATE_LABEL];
  // Chip vocabulary, non-zero counts only — mirrors the week-divider headings
  // above so the two surfaces speak the same language.
  if (counts.succeeded > 0) parts.push(`${counts.succeeded} succeeded`);
  if (counts.missed > 0) parts.push(`${counts.missed} missed`);
  if (counts.abandoned > 0) parts.push(`${counts.abandoned} abandoned`);
  if (hitRatePercent !== null) {
    parts.push(`${hitRatePercent}% ${SMART_TASK_LIST_HIT_RATE_NOUN}`);
  }
  return {
    text: parts.join(' · '),
    succeeded: counts.succeeded,
    missed: counts.missed,
    abandoned: counts.abandoned,
    hitRatePercent,
  };
};
