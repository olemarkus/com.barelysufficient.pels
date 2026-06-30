// 7-day hit-rate strip for the past-tasks surface (PR-10).
//
// Sliced out of `deferredPlanHistoryReceipt.ts` so that file stays under the
// 500-LOC eslint cap (v2.14 decomposition pass). `deferredPlanHistoryReceipt.ts`
// re-exports the public symbols below so consumers (runtime + the smart_tasks
// widget) keep their existing import path.
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
// `countOutcomes` in the ISO-week archive module and the chip-vocabulary
// divider headings. Other outcomes (`unknown` — backfill / pre-schema entries)
// are not counted in any bucket; they don't represent a meaningful planner
// result.

import type { ResolvedDeferredObjectivePlanHistoryEntry } from '../../contracts/src/deferredObjectivePlanHistory';
import {
  formatSmartTaskHitRateFragment,
  SMART_TASK_LIST_7DAY_HIT_RATE_LABEL,
} from './deadlineLabels';
import {
  formatReceiptOutcomeAbandoned,
  formatReceiptOutcomeMissed,
  formatReceiptOutcomeSucceeded,
  RECEIPT_FRAGMENT_SEPARATOR,
} from './deferredPlanHistoryReceiptStrings';
import {
  getPreviousLocalDayStartUtcMs,
  getStartOfDayInTimeZone,
} from './utils/dateUtils';

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
  entry: Pick<ResolvedDeferredObjectivePlanHistoryEntry, 'finalizedAtMs' | 'deadlineAtMs'>,
): number => (
  Number.isFinite(entry.finalizedAtMs) ? entry.finalizedAtMs : entry.deadlineAtMs
);

// Tallies a single entry against the 7-day counts. Returns the counts
// unchanged when the entry falls outside the window or is unparseable;
// `unknown` outcomes are counted toward `inWindow` (so the strip still
// renders when only backfill rows survive) but not toward any bucket.
const tallySevenDayEntry = (
  counts: SevenDayCounts,
  entry: ResolvedDeferredObjectivePlanHistoryEntry,
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
  // `Last 7 days, all devices · 8 succeeded · 3 missed · 1 abandoned · 73% of 11 finished`.
  // The lead names the scope (rolling 7-day window across all devices) so it
  // doesn't read as a contradiction against the calendar-week dividers below;
  // the percent names its denominator (succeeded + missed = the finished runs)
  // so it reconciles with the counts beside it. Renders verbatim; the view
  // never branches on the counts. Retained as the canonical single-string form
  // for runtime log breadcrumbs and the strip's `aria-label`
  // (`feedback_ui_text_shared_with_logs.md`).
  text: string;
  // Per-fragment breakdown so the view can COLOUR each count to match the
  // history-row badges (PR2 spec §7) without re-parsing `text` or deciding
  // tones itself. Same fragments, same order, same vocabulary as `text`; the
  // producer owns which tone each fragment carries (layering: resolution in
  // the producer, `feedback_layering_resolution_in_producer.md`). The view
  // maps `tone` → a presentational colour class via a flat lookup. `neutral`
  // is the lead/scope label and the hit-rate fragment (they carry no outcome
  // colour); `positive` / `warning` / `muted` mirror the Succeeded / Missed /
  // Abandoned chip tones.
  segments: ReadonlyArray<{
    readonly text: string;
    readonly tone: 'neutral' | 'positive' | 'warning' | 'muted';
  }>;
  // Raw aggregate so callers (telemetry, future surfaces, tests) can read
  // the numbers without re-parsing the formatted string. The producer is
  // the only place that decides what counts; consumers stay flat.
  succeeded: number;
  missed: number;
  abandoned: number;
  // Hit rate as an integer percent rounded to the nearest whole number.
  // `null` when no Succeeded + Missed entries landed in the window — a
  // strip that rendered the shipped "0% of 0 finished" fragment off only
  // abandoned entries would misrepresent the user's experience.
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
  entries: ReadonlyArray<ResolvedDeferredObjectivePlanHistoryEntry>,
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
  // `decisive` is the hit-rate denominator: succeeded + missed (the runs that
  // reached a verdict). Abandoned/replaced runs are deliberately excluded —
  // see the file-block comment above. The strip names this denominator
  // ("N% of <decisive> finished") so the percent reconciles with the counts
  // beside it instead of leaving the user to guess what it's a percent *of*.
  const decisive = counts.succeeded + counts.missed;
  const hitRatePercent = decisive === 0
    ? null
    : Math.round((counts.succeeded / decisive) * 100);
  // Chip vocabulary, non-zero counts only — mirrors the week-divider headings
  // above so the two surfaces speak the same language. Each fragment carries
  // the tone the matching history-row badge uses (PR2 §7) so the view can
  // colour the counts; the lead label and hit-rate fragment stay neutral.
  const segments: { text: string; tone: 'neutral' | 'positive' | 'warning' | 'muted' }[] = [
    { text: SMART_TASK_LIST_7DAY_HIT_RATE_LABEL, tone: 'neutral' },
  ];
  if (counts.succeeded > 0) {
    segments.push({ text: formatReceiptOutcomeSucceeded(counts.succeeded), tone: 'positive' });
  }
  if (counts.missed > 0) segments.push({ text: formatReceiptOutcomeMissed(counts.missed), tone: 'warning' });
  if (counts.abandoned > 0) {
    segments.push({ text: formatReceiptOutcomeAbandoned(counts.abandoned), tone: 'muted' });
  }
  if (hitRatePercent !== null) {
    segments.push({ text: formatSmartTaskHitRateFragment(hitRatePercent, decisive), tone: 'neutral' });
  }
  return {
    text: segments.map((segment) => segment.text).join(RECEIPT_FRAGMENT_SEPARATOR),
    segments,
    succeeded: counts.succeeded,
    missed: counts.missed,
    abandoned: counts.abandoned,
    hitRatePercent,
  };
};
