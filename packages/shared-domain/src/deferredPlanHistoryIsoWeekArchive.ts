// ISO-week archive grouping for the past-tasks surface (DeadlinesHistoryList).
//
// Sliced out of `deferredPlanHistoryReceipt.ts` so that file stays under the
// 500-LOC eslint cap (v2.14 decomposition pass). This module owns the ISO-week
// section headings ("This week · 3 succeeded · 1 missed · ≈ 41 kr") and the
// per-week cost roll-up. Grouping + heading copy live here so the view layer
// never inspects per-week aggregates. The lead label uses relative phrasing
// ("This week" / "Last week" / "Week of 12 May") rather than the engineer-
// facing "Week 22" ISO number. Outcome counts use the chip vocabulary
// (`succeeded` / `missed` / `abandoned`) and surface non-zero counts only, so
// misses and abandons don't vanish from the strip while still showing up in the
// per-row chips. See notes/ui-terminology.md "Chip adjectives vs divider verbs".
//
// `deferredPlanHistoryReceipt.ts` re-exports every public symbol below so its
// consumers (runtime + the smart_tasks widget) keep their existing import path.

import type { ResolvedDeferredObjectivePlanHistoryEntry } from '../../contracts/src/deferredObjectivePlanHistory';
import { APPROX_GLYPH } from './deadlineLabels';
import {
  formatReceiptOtherTasksHeading,
  formatReceiptOutcomeAbandoned,
  formatReceiptOutcomeMissed,
  formatReceiptOutcomeSucceeded,
  formatReceiptWeekCost,
  scaleRawCostToDisplay,
  DEFAULT_HISTORY_COST_DISPLAY,
  resolveEntryCostDisplay,
  formatReceiptWeekOf,
  formatReceiptWeekProvisionalHeading,
  RECEIPT_FRAGMENT_SEPARATOR,
  RECEIPT_WEEK_LAST,
  RECEIPT_WEEK_THIS,
} from './deferredPlanHistoryReceiptStrings';
import { priceRateLabelToAmountUnit } from './price/priceUnitLabel';
import {
  formatDateInTimeZone,
  getPreviousLocalDayStartUtcMs,
  getWeekStartInTimeZone,
  getZonedParts,
} from './utils/dateUtils';

const HOUR_MS = 60 * 60 * 1000;

export type PlanHistoryWeekGroup = {
  // Stable identity for the group — ISO `YYYY-Www` (zero-padded week). The
  // view uses this as the React key.
  weekKey: string;
  // Pre-formatted heading copy ("Week 20 · 4 deadlines met · ≈ 41 kr.").
  // Renders as a quiet section break above the grouped cards.
  heading: string;
  entries: ResolvedDeferredObjectivePlanHistoryEntry[];
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

// Sum a week's per-entry `totalCost` into display-currency units for the
// heading. Each entry's raw total is scaled by ITS OWN recorded divisor before
// summing (a week can mix divisors within one currency — e.g. an øre/÷100 run
// and a later Flow `kr`/÷1 run both labelled `kr` — so scaling once by a single
// divisor would mislabel the mixed total). Critically, only entries recorded in
// the heading's CURRENCY are summed: a mid-week currency switch (e.g. `kr`→`EUR`)
// must not add different currencies into one figure under a single label. The
// minority-currency entries are excluded from the heading total but still render
// their own correct per-row cost line beneath it. Keeps the roll-up honest and
// in agreement with the rows.
const sumEntryDisplayCost = (
  entries: ReadonlyArray<ResolvedDeferredObjectivePlanHistoryEntry>,
  headingUnit: string,
): number => {
  let total = 0;
  for (const entry of entries) {
    if (typeof entry.totalCost !== 'number' || !Number.isFinite(entry.totalCost)) continue;
    const display = resolveEntryCostDisplay(entry);
    if (display.unit !== headingUnit) continue;
    total += scaleRawCostToDisplay(entry.totalCost, display.divisor);
  }
  return total;
};

// Heading unit for a week group: the recorded unit of the first entry that
// carries a finite cost (else the recording-era default). Entries in a group
// share a scheme in practice; on the rare mixed-scheme week the per-row lines
// still each render their own unit correctly, and the heading picks a single
// representative label for the rolled-up amount.
const resolveWeekHeadingUnit = (
  entries: ReadonlyArray<ResolvedDeferredObjectivePlanHistoryEntry>,
): string => {
  for (const entry of entries) {
    if (typeof entry.totalCost === 'number' && Number.isFinite(entry.totalCost)) {
      return resolveEntryCostDisplay(entry).unit;
    }
  }
  return DEFAULT_HISTORY_COST_DISPLAY.unit;
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
  if (weekStartMs === currentWeekStartMs) return RECEIPT_WEEK_THIS;
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
  if (weekStartMs === previousWeekStartMs) return RECEIPT_WEEK_LAST;
  // Older weeks render as "Week of 12 May" — the Monday formatted day +
  // short month, in the user's time zone.
  const monthDay = formatDateInTimeZone(
    new Date(weekStartMs),
    { day: 'numeric', month: 'short' },
    timeZone,
  );
  return formatReceiptWeekOf(monthDay);
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
  entries: ReadonlyArray<ResolvedDeferredObjectivePlanHistoryEntry>,
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
  entries: ReadonlyArray<ResolvedDeferredObjectivePlanHistoryEntry>,
): string => {
  const lead = formatRelativeWeekLabel(weekStartMs, nowMs, timeZone);
  const counts = countOutcomes(entries);
  const outcomeFragments: string[] = [];
  // Chip vocabulary on the divider — see notes/ui-terminology.md
  // "Chip adjectives vs divider verbs". Non-zero counts only so a quiet
  // all-succeeded week doesn't carry a noisy "0 missed · 0 abandoned" tail,
  // and a zero-succeeded week still surfaces the misses/abandons that the
  // previous "N deadlines met" wording dropped on the floor.
  if (counts.succeeded > 0) outcomeFragments.push(formatReceiptOutcomeSucceeded(counts.succeeded));
  if (counts.missed > 0) outcomeFragments.push(formatReceiptOutcomeMissed(counts.missed));
  if (counts.abandoned > 0) outcomeFragments.push(formatReceiptOutcomeAbandoned(counts.abandoned));
  const parts = [lead, ...outcomeFragments];
  // Heading total is an amount: drop a `/kWh` rate suffix (Flow/Homey schemes
  // record `kr/kWh`). Unit comes from the entries' OWN recorded provenance.
  const headingRawUnit = resolveWeekHeadingUnit(entries);
  const unit = priceRateLabelToAmountUnit(headingRawUnit.trim());
  // Sum only entries recorded in the heading currency (scaled by each entry's
  // own divisor): a mid-week currency switch must not add different currencies
  // into one labelled figure. Legacy entries fall back to the øre/kr scheme.
  const cost = sumEntryDisplayCost(entries, headingRawUnit);
  // Nordpool prices can briefly go negative; preserve the sign so a credit
  // week reads as a credit week in the archive heading rather than disappearing.
  if (unit.length > 0 && Math.round(cost) !== 0) {
    parts.push(formatReceiptWeekCost(APPROX_GLYPH, Math.round(cost), unit));
  }
  // v2.7.3 P2 — drop trailing period on section headings; HTML headings
  // don't take terminal punctuation.
  return parts.join(RECEIPT_FRAGMENT_SEPARATOR);
};

/**
 * Groups past-task history entries into ISO-week sections for the past-tasks
 * archive surface. Iterates the input in its existing newest-first order so
 * the returned groups land newest-first too; entries within each group keep
 * their input order. Returns an empty array when `entries` is empty so the
 * view can render the existing zero-state.
 *
 * The rolled-up cost ("≈ 41 kr") reads in each entry's RECORDED display
 * currency — scheme + divisor + unit persisted on the entry at finalize time —
 * so the heading survives a later price-scheme/currency switch and agrees with
 * the per-row cost lines beneath it. Legacy entries with no recorded display
 * fall back to the recording-era øre/kr default. An empty unit drops the cost
 * half of the heading cleanly.
 *
 * `nowMs` anchors the relative-week phrasing ("This week" / "Last week" /
 * "Week of 12 May"). The view layer threads its real wall-clock time in so
 * the helper stays pure and snapshot-testable.
 */
export const groupPlanHistoryByIsoWeek = (
  entries: ReadonlyArray<ResolvedDeferredObjectivePlanHistoryEntry>,
  timeZone: string,
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
        heading: formatReceiptWeekProvisionalHeading(week),
        entries: [entry],
      });
    } else {
      groups[existingIndex]!.entries.push(entry);
    }
  }
  // Second pass — finalise the heading copy now that each group's entries
  // are populated. Keeps the helper O(n) and avoids the temptation to
  // recompute the heading on every push. The cost roll-up reads each entry's
  // own recorded display inside `formatWeekHeading`.
  return groups.map((group) => {
    const weekStartMs = computeWeekStart(group.entries[0]!.deadlineAtMs, timeZone);
    const heading = weekStartMs === null
      ? formatReceiptOtherTasksHeading(group.entries.length)
      : formatWeekHeading(weekStartMs, nowMs, timeZone, group.entries);
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
