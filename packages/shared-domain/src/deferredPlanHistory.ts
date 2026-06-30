import type { DeferredObjectiveSettingsKind } from '../../contracts/src/deferredObjectiveSettings';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionLogEntry,
  DeferredObjectivePlanMetReason,
  DeferredObjectivePlanOutcome,
  ResolvedDeferredObjectivePlanHistoryEntry,
} from '../../contracts/src/deferredObjectivePlanHistory';
import { APPROX_GLYPH, resolveRevisionReason } from './deadlineLabels';
import { formatRefinedMissCause } from './deferredPlanHistoryAttribution';
import {
  resolveEntryCostDisplay,
  scaleRawCostToDisplay,
} from './deferredPlanHistoryReceiptStrings';
import {
  formatClockTime,
  HOUR_MS,
  OVERSHOOT_PERCENT_THRESHOLD_PUBLIC,
  OVERSHOOT_TEMPERATURE_THRESHOLD_C_PUBLIC,
  pickLastPlan,
  snapshotShowsBudgetExhausted,
} from './deferredPlanHistoryShared';
import { priceRateLabelToAmountUnit } from './price/priceUnitLabel';
import { formatTimeInTimeZone } from './utils/dateUtils';

export type DeferredPlanHistoryChipTone = 'ok' | 'warn' | 'muted';

// Canonical Smart-task list date+time format, e.g. `Sat 16 May 06:50`.
//
// Both the active Smart-tasks list (`DeadlinesList.tsx`) and the past-tasks
// list (`DeadlinesHistoryList.tsx` via `DeadlinePlanHistory.tsx`) route their
// timestamps through this helper so the two columns can't drift apart again.
// Pinned to `en-GB` so the day-of-month-then-month ordering ("16 May") is
// stable across CI (en-US default) and developer machines (en-GB/en-DK).
// `formatDateInTimeZone` would otherwise inherit the runtime's default locale
// and render `Sat, May 16` on en-US, breaking regression tests.
const SMART_TASK_DATE_LOCALE = 'en-GB';

export const formatSmartTaskListDateTime = (
  ms: number,
  timeZone = 'UTC',
): string => {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  const dateLabel = new Intl.DateTimeFormat(SMART_TASK_DATE_LOCALE, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(date);
  const timeLabel = formatTimeInTimeZone(date, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }, timeZone);
  return `${dateLabel} ${timeLabel}`;
};

export const formatPlanHistoryDeadlineLine = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'deadlineAtMs'>,
  timeZone = 'UTC',
): string => formatSmartTaskListDateTime(entry.deadlineAtMs, timeZone);

const formatTemperature = (value: number | null): string | null => (
  value === null ? null : `${value.toFixed(1)} °C`
);

const formatPercent = (value: number | null): string | null => (
  value === null ? null : `${value.toFixed(0)} %`
);

// `'abandoned'` and `'replaced'` runs are finalized before the device ever
// reached (or even attempted) the target — the persisted `finalProgressC` /
// `finalProgressPercent` is the reading at the moment the user cleared the
// smart task (or the diagnostic stream went stale), not the result of any
// PELS-driven heating/charging. Rendering `start → final` for those outcomes
// reads as "we moved the needle from X to Y", which is the opposite of what
// happened — the run was abandoned and no progress is attributable to PELS.
// Producer-resolves the suppression so the view layer never branches on
// outcome; mirrors the same rule used by `formatPlanHistoryReachedAtLine`
// (suppressed on every outcome except `'met'`).
// On a true target-reached `met` run the deadline was reached — often early —
// after which the reading can drift back below target before the window closes:
// a water tank that hit 65 °C at 03:42 then cooled to 39.2 °C by the 06:00
// deadline. Showing the raw end-of-window `finalProgressC` then renders
// `64.0 → 39.2 · target 65.0` next to a "Succeeded" chip — a drop that reads as
// a contradiction, even though the separate "reached at HH:MM" line already
// records when target was met. For those runs we floor the displayed end at the
// target: the run did reach it, so `start → target` is the honest summary.
//
// Stall-promoted mets (`metReason` set — `stalled` / `stalled_device_capped`)
// are the opposite case: the device plateaued *below* target and we accepted
// that as success, and the detail postmortem leads with that accepted plateau
// (e.g. "settled at 61.8 °C"). Flooring those to target would invent a reading
// the device never hit, so we leave their real final untouched — the floor
// applies only to the legacy (absent `metReason`) reached-the-target shape.
// Overshoot (`final > target`) is likewise preserved untouched — the dedicated
// overshoot line surfaces that magnitude. Resolved producer-side so the view
// never branches on outcome.
const resolveDisplayedEndValue = (
  outcome: DeferredObjectivePlanOutcome,
  metReason: DeferredObjectivePlanMetReason | undefined,
  finalValue: number | null,
  targetValue: number | null,
): number | null => (
  outcome === 'met' && metReason === undefined
    && finalValue !== null && targetValue !== null && finalValue < targetValue
    ? targetValue
    : finalValue);

export const formatPlanHistoryProgressLine = (
  entry: Pick<
    ResolvedDeferredObjectivePlanHistoryEntry,
    'objectiveKind'
    | 'outcome'
    | 'metReason'
    | 'targetValue'
    | 'startProgressValue'
    | 'finalProgressValue'
  >,
): string | null => {
  const suppressArrow = entry.outcome === 'abandoned' || entry.outcome === 'replaced';
  // Value selection is unit-agnostic (resolved on the producer boundary);
  // only the formatter (°C vs %) stays kind-specific.
  const formatValue = entry.objectiveKind === 'temperature' ? formatTemperature : formatPercent;
  const startValue = entry.startProgressValue;
  const targetValue = entry.targetValue;
  const start = formatValue(startValue);
  const target = formatValue(targetValue);
  if (!start || !target) return null;
  if (suppressArrow) return `${start}  ·  target ${target}`;
  const endValue = resolveDisplayedEndValue(
    entry.outcome, entry.metReason, entry.finalProgressValue, targetValue,
  );
  const end = formatValue(endValue);
  return `${start} → ${end ?? '—'}  ·  target ${target}`;
};

export const formatPlanHistoryReachedAtLine = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'metAtMs' | 'outcome'>,
  timeZone = 'UTC',
): string | null => {
  if (entry.outcome !== 'met' || entry.metAtMs === null) return null;
  const date = new Date(entry.metAtMs);
  if (Number.isNaN(date.getTime())) return null;
  // `h23` keeps midnight as "00:05" (a bare `hour12:false` can pick `h24` →
  // "24:05" in some locales) and matches PELS's 24h labels.
  const timeLabel = formatTimeInTimeZone(
    date, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, timeZone,
  );
  return `reached at ${timeLabel}`;
};

const OUTCOME_LABELS: Record<DeferredObjectivePlanOutcome, string> = {
  met: 'Succeeded',
  missed: 'Missed',
  abandoned: 'Abandoned',
  replaced: 'Abandoned',
  unknown: 'Unknown',
};

const OUTCOME_TONES: Record<DeferredObjectivePlanOutcome, DeferredPlanHistoryChipTone> = {
  met: 'ok',
  missed: 'warn',
  abandoned: 'muted',
  replaced: 'muted',
  unknown: 'muted',
};

export const getPlanHistoryOutcomeLabel = (outcome: DeferredObjectivePlanOutcome): string => OUTCOME_LABELS[outcome];

export const getPlanHistoryOutcomeTone = (
  outcome: DeferredObjectivePlanOutcome,
): DeferredPlanHistoryChipTone => OUTCOME_TONES[outcome];

// Card-surface tone for a finalized history row, in the canonical
// `.pels-surface-card[data-tone="…"]` vocabulary (`good | warn | muted`). PR2
// surface/colour system (spec §7): the outcome tone is applied to the whole
// row as an M3 tonal container, not just the corner badge — see the device-
// card tonal-container pattern in `notes/overview-hero-spec.md`. A near-mirror
// of the chip tone; the only divergence is `ok` → `good`, because the chip
// primitive treats `--ok`/`--good` identically but the card primitive only
// defines `[data-tone="good"]`. Derived from the chip tone so the two never
// drift; the producer resolves the term and the view never maps tones itself
// (layering: resolution in the producer). Succeeded → positive, Missed →
// warning, Abandoned/Replaced/Unknown → neutral (a log entry, not a result).
export const getPlanHistoryOutcomeCardTone = (
  outcome: DeferredObjectivePlanOutcome,
): 'good' | 'warn' | 'muted' => (OUTCOME_TONES[outcome] === 'ok' ? 'good' : OUTCOME_TONES[outcome]);

/**
 * Resolves a one-line "Overshoot {delta}" muted note for a Succeeded history entry whose
 * final reading exceeded the target by a meaningful margin. Threshold matches the
 * `notes/smart-task-ui/README.md` design spec — `finalProgressC − targetTemperatureC > 5 °C`
 * for temperature kinds, or `finalProgressPercent − targetPercent > 10 %` for EV kinds.
 *
 * Returns `null` when the entry didn't overshoot (or wasn't `met`, or lacks the readings to
 * compute a delta) so the caller can suppress the line cleanly. Lives in shared-domain so
 * the same string feeds runtime log breadcrumbs alongside the UI (per
 * `feedback_ui_text_shared_with_logs.md`).
 *
 * Canonical regression: the lived-state Connected 300 entry from
 * `notes/smart-task-ui/README.md` had `29.3 → 77.7 °C · target 65 °C`, overshooting by 12.7 °C
 * — the helper renders `Overshoot 12.7 °C` for that entry.
 */
export const formatPlanHistoryOvershootLine = (
  entry: Pick<
    ResolvedDeferredObjectivePlanHistoryEntry,
    'outcome'
    | 'objectiveKind'
    | 'targetValue'
    | 'finalProgressValue'
  >,
): string | null => {
  if (entry.outcome !== 'met') return null;
  // Value selection is unit-agnostic; the threshold + unit suffix stay kind-specific.
  const finalValue = entry.finalProgressValue;
  const targetValue = entry.targetValue;
  if (finalValue === null || targetValue === null) return null;
  const delta = finalValue - targetValue;
  if (entry.objectiveKind === 'temperature') {
    if (delta <= OVERSHOOT_TEMPERATURE_THRESHOLD_C_PUBLIC) return null;
    return `Overshoot ${delta.toFixed(1)} °C`;
  }
  if (delta <= OVERSHOOT_PERCENT_THRESHOLD_PUBLIC) return null;
  return `Overshoot ${delta.toFixed(0)} %`;
};

/**
 * Composes the muted "See household usage on {date} →" cross-link label rendered below the
 * history-detail hero. Per `notes/smart-task-ui/README.md` "Cross-surface: vs Usage /
 * Insights", the asymmetric link from a Smart-task history detail to the same-day Usage
 * chart helps the recovering-from-mistake user compare the task with the household
 * day context when investigating a miss.
 *
 * `dateLabel` is the localized day string supplied by the caller (UI layer) so
 * shared-domain stays free of locale/Date helpers — same rule as
 * `formatPlanHistoryDeadlineLine`. The trailing arrow is part of the label so the
 * link reads as a navigation affordance even without underline styling.
 */
export const formatPlanHistoryUsageDayLinkLabel = (
  _deviceName: string | null,
  dateLabel: string,
): string => `See household usage on ${dateLabel} →`;

// Window size for the "miss-streak" aggregate on the past-tasks landing surface.
// Mirrors the lived-state Connected 300 example from `notes/smart-task-ui/README.md`:
// 3 missed runs in the most recent 4 history entries triggered the recovering-from-mistake
// persona's need for an aggregate signal. The window stays small (4) so a single late-night
// miss in an otherwise-healthy device never trips the aggregate.
const MISS_STREAK_WINDOW = 4;
// Half the window is the threshold — keeps the resolver kind-agnostic and matches the
// notes' "3 of last 4 runs missed" framing (3/4 ≥ 0.5).
const MISS_STREAK_THRESHOLD = 0.5;

/**
 * Composes the "Past tasks (N of last M runs missed)" subhead string when a device's most-recent
 * history entries show a meaningful miss streak. Returns `null` when the streak is below the
 * threshold (or the window is too short to be meaningful) so the caller can render the plain
 * "Past tasks" heading instead.
 *
 * `entries` MUST already be sorted newest-first (matching `resolveDeadlinesHistoryEntries`).
 * The resolver looks only at the first `MISS_STREAK_WINDOW` entries for the device — older
 * history doesn't influence the aggregate.
 *
 * Per `notes/smart-task-ui/README.md`, the aggregate is the only signal a recovering-from-
 * mistake user gets without opening per-entry detail; keep the threshold loose enough that
 * the "Connected 300 misses 3 of last 4" pattern fires reliably, but tight enough that a
 * single late-night miss in an otherwise-healthy device doesn't trip it.
 *
 * Lives in shared-domain so runtime log breadcrumbs and the UI share the same wording.
 */
export const formatMissStreakAggregateLine = (
  entries: ReadonlyArray<Pick<DeferredObjectivePlanHistoryEntry, 'outcome' | 'deviceId'>>,
  deviceId: string,
): string | null => {
  if (entries.length < 2) return null;
  const recent: Array<Pick<DeferredObjectivePlanHistoryEntry, 'outcome'>> = [];
  for (const entry of entries) {
    if (entry.deviceId !== deviceId) continue;
    recent.push(entry);
    if (recent.length >= MISS_STREAK_WINDOW) break;
  }
  if (recent.length < 2) return null;
  const missed = recent.filter((entry) => entry.outcome === 'missed').length;
  if (missed / recent.length < MISS_STREAK_THRESHOLD) return null;
  return `${missed} of last ${recent.length} runs missed`;
};

/**
 * Composes a short human-readable explanation for *why* a finalized run was marked missed.
 * Resolves to flat copy from the recorded snapshots so the missed-history surface mirrors the
 * succeeded path's "explanation density": users opening a missed run need to see the cause
 * without inferring from chart bars alone.
 *
 * Branches resolve in priority order (most specific first):
 *  1. Daily budget exhausted on the last revision → "Daily budget filled before the
 *     deadline." (blameless; recourse copy lives on the recourse button per v2.7.3
 *     history-loveable rewrite — `pels-ux-fit` P1 #2 fold-in).
 *  2. Final plan status `cannot_meet` → "Couldn't reserve enough cheap hours in time."
 *  3. Final plan status `at_risk`     → "Fell behind and didn't catch up in time."
 *  4. Discovered from backfill        → "PELS restarted mid-task; outcome estimated."
 *  5. Otherwise                       → "Didn't reach the target before the deadline."
 *
 * Sentences are kept tight (≤ ~45 chars) so the list-card reason line fits on one
 * row at 320px; the consumer prefixes "Why:" to set it apart from the coverage line.
 *
 * Returns `null` only when the entry is not `outcome === 'missed'`; the missed-history page
 * always renders something so the user is never left with a chip and no explanation.
 *
 * Per `feedback_hard_cap_is_physical.md`, no branch recommends raising the capacity
 * hard cap or the daily budget — the recourse button (resolved by
 * `resolveMissedHistoryRecourse`) is the only surface that names the user-facing
 * "lower target / move deadline / lower daily budget" action.
 *
 * Lives in shared-domain so the same strings can feed runtime log breadcrumbs (per
 * `feedback_ui_text_shared_with_logs.md`).
 */
export const formatPlanHistoryMissedReason = (
  entry: Pick<
    ResolvedDeferredObjectivePlanHistoryEntry,
    'outcome' | 'originalPlan' | 'finalPlan' | 'discoveredFrom' | 'deliveredKWh' | 'objectiveKind'
    | 'startProgressValue' | 'finalProgressValue'
  >,
): string | null => {
  if (entry.outcome !== 'missed') return null;
  // v2.7.3 — blameless rewrite. Recourse copy lives on the recourse button
  // (resolved separately by `resolveMissedHistoryRecourse`), so the "Why"
  // sentence answers only "what happened" — never "what should you do".
  // Per `feedback_hard_cap_is_physical.md`, no branch ever suggests raising
  // the capacity hard cap or daily budget; the user-facing recommendation
  // (lower target / move deadline / lower daily budget) is the recourse
  // button's job.
  const lastPlan = pickLastPlan(entry);
  if (snapshotShowsBudgetExhausted(lastPlan)) {
    return 'Daily budget filled before the deadline.';
  }
  // v2.7.4 — plan-time miss attribution (Session A). Inserted ahead of the
  // `planStatus` branches so a `cannot_meet` that rested on a low-confidence
  // learned rate reads "still learning" rather than "couldn't reserve cheap
  // hours", and a run that delivered the planned power yet missed names the
  // energy-needed underestimate instead of a generic shortfall. Returns null
  // for every cause the shipped copy below already handles honestly.
  const refinedCause = formatRefinedMissCause(entry);
  if (refinedCause !== null) return refinedCause;
  if (lastPlan?.planStatus === 'cannot_meet') {
    return "Couldn't reserve enough cheap hours in time.";
  }
  if (lastPlan?.planStatus === 'at_risk') {
    return "Fell behind and didn't catch up in time.";
  }
  if (entry.discoveredFrom === 'backfill') {
    return 'PELS restarted mid-task; outcome estimated.';
  }
  return "Didn't reach the target before the deadline.";
};

// ─── Finalized-run postmortem sentence (extracted to a sibling) ─────────────
//
// Re-exported from `deferredPlanHistoryPostmortem.ts` so consumers can keep
// importing the postmortem resolver + variant types from this module. Living in
// its own file keeps the formatters here inside the 500-LOC ESLint cap.
export {
  formatPlanHistoryPostmortem,
  type DeferredPlanHistoryPostmortem,
  type DeferredPlanHistoryPostmortemVariant,
} from './deferredPlanHistoryPostmortem';

// Composes the secondary line shared by the Succeeded receipt and the Missed
// diagnosis shapes — `Cost ≈ X kr [partial] · Y kWh delivered`. The
// `costSuffix` lets the Missed branch surface `" partial"` so the user reads
// the cost as the partial-delivery cost, not the planned total. Null when
// neither delivery nor cost was captured (legacy entry, no hourly feed) —
// better than fabricating "0 kWh delivered" for entries with no record. The
// approximation glyph matches the live hero so cost reads identically.
export const formatPlanHistoryCostAndDelivered = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'deliveredKWh' | 'totalCost' | 'costDisplay'>,
  costSuffix: string,
): string | null => {
  const hasDelivery = typeof entry.deliveredKWh === 'number'
    && Number.isFinite(entry.deliveredKWh);
  const hasCost = typeof entry.totalCost === 'number'
    && Number.isFinite(entry.totalCost);
  if (!hasDelivery && !hasCost) return null;
  // Scale + label with the entry's RECORDED display (legacy entries fall back to
  // the recording-era øre/kr default) so a later price-scheme switch can't
  // misrender the figure — raw øre @ divisor 100 divides to `12.30 kr`. A total
  // is an amount: strip any `/kWh` suffix so it reads `kr`, not `kr/kWh`.
  const display = resolveEntryCostDisplay(entry);
  const trimmedUnit = priceRateLabelToAmountUnit(display.unit.trim());
  const parts: string[] = [];
  if (hasCost && trimmedUnit.length > 0) {
    const scaledCost = scaleRawCostToDisplay(entry.totalCost!, display.divisor);
    parts.push(`Cost ${APPROX_GLYPH} ${scaledCost.toFixed(2)} ${trimmedUnit}${costSuffix}`);
  }
  if (hasDelivery) {
    parts.push(`${entry.deliveredKWh!.toFixed(1)} kWh delivered`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
};

// "N of M planned kWh delivered by then." — used on the Abandoned muted
// secondary line. Sums the final-plan hours for the planned total; falls
// through to null when neither delivery nor a plan total is known.
export const formatPlanHistoryAbandonedSecondary = (
  entry: Pick<
    DeferredObjectivePlanHistoryEntry,
    'deliveredKWh' | 'finalPlan' | 'originalPlan'
  >,
): string | null => {
  const hasDelivery = typeof entry.deliveredKWh === 'number'
    && Number.isFinite(entry.deliveredKWh);
  const lastPlan = entry.finalPlan ?? entry.originalPlan;
  const plannedTotalKWh = lastPlan
    ? lastPlan.hours.reduce(
      (acc, hour) => acc + (Number.isFinite(hour.plannedKWh) ? hour.plannedKWh : 0),
      0,
    )
    : 0;
  // Only the "X of Y planned kWh" form needs *both* delivery and a plan
  // total to read honestly — without delivery we'd fabricate "0.0 of X
  // delivered" for legacy entries where the hourly feed was never captured.
  // Drop to plan-only or delivery-only forms in that case rather than
  // implying a zero delivery that isn't backed by data.
  if (hasDelivery && plannedTotalKWh > 0) {
    return `${entry.deliveredKWh!.toFixed(1)} of ${plannedTotalKWh.toFixed(1)} planned kWh delivered by then.`;
  }
  if (hasDelivery) {
    return `${entry.deliveredKWh!.toFixed(1)} kWh delivered by then.`;
  }
  if (plannedTotalKWh > 0) {
    return `${plannedTotalKWh.toFixed(1)} planned kWh; delivery unknown.`;
  }
  return null;
};

// ─── Per-revision log entries on history detail (v2.7.2 PR 5) ────────────────

// Resolved shape of a single revision-log row on the smart-task history-detail
// page. The producer formats every visible field — the view layer only renders
// strings and never branches on `reasonId` / hour-diff signs.
//
// Pre-resolved row for the smart-task history-detail revision log. Every
// visible field is producer-formatted so the view never branches on reason
// ID or hour-diff signs. `hourDiffAriaLabel` is the long-form pronouncing
// of `hourDiff` for screen readers (e.g. `1 hour added` for `+1h`), bound
// to the chip's `title` + `aria-label`. `null` when `hourDiff === null`.
export type PlanHistoryRevisionLogRow = {
  timeLabel: string;
  reason: string;
  // True when the recorder emitted a reason code the resolver hasn't learned
  // about and the row fell back to the producer label `Plan refreshed`. The
  // view layer reads this to swap in the longer `Plan refreshed (details
  // unavailable)` row copy and to suppress the hour-diff chip (otherwise the
  // chip would misattribute the diff to a vague reason). Mirrors the same
  // field on `ActivePlanRevisionLogRow` so both surfaces handle fallback
  // rows identically.
  isFallback: boolean;
  hourDiff: string | null;
  hourDiffAriaLabel: string | null;
};

// Normalize raw bucket-count signals (can be Infinity / NaN on corrupt
// persistence) into clean non-negative integers. Shared by the glyph + aria
// formatters so both surfaces agree on the "zero" threshold.
const normalizeHourCounts = (hoursAdded: number, hoursRemoved: number): { added: number; removed: number } => ({
  added: Number.isFinite(hoursAdded) && hoursAdded > 0 ? Math.floor(hoursAdded) : 0,
  removed: Number.isFinite(hoursRemoved) && hoursRemoved > 0 ? Math.floor(hoursRemoved) : 0,
});

const formatHourDiff = (hoursAdded: number, hoursRemoved: number): string | null => {
  const { added, removed } = normalizeHourCounts(hoursAdded, hoursRemoved);
  if (added === 0 && removed === 0) return null;
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}h`);
  // U+2212 MINUS SIGN matches the typographic minus elsewhere in the
  // smart-task UI; ASCII hyphen would read as a range separator.
  if (removed > 0) parts.push(`−${removed}h`);
  return parts.join(' ');
};

const pluralHour = (n: number): string => (n === 1 ? 'hour' : 'hours');

const formatHourDiffAriaLabel = (hoursAdded: number, hoursRemoved: number): string | null => {
  const { added, removed } = normalizeHourCounts(hoursAdded, hoursRemoved);
  if (added === 0 && removed === 0) return null;
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} ${pluralHour(added)} added`);
  if (removed > 0) parts.push(`${removed} ${pluralHour(removed)} dropped`);
  return parts.join(', ');
};

/**
 * Resolves a single revision-log row from a recorded `revisions[]` entry for
 * the smart-task history-detail page. Every visible string is formatted here so
 * the view layer never branches on `reasonId`, hour-diff sign, or `kind`.
 *
 * `timeZone` is supplied by the caller (UI layer); shared-domain stays free
 * of locale defaults.
 *
 * Per `feedback_ui_text_shared_with_logs.md`, the same `revisionReason`
 * resolver feeds runtime log breadcrumbs so the two surfaces stay in sync.
 */
export const formatPlanHistoryRevisionEntry = (
  entry: DeferredObjectivePlanHistoryRevisionLogEntry,
  timeZone: string,
  kind: DeferredObjectiveSettingsKind,
): PlanHistoryRevisionLogRow => {
  const timeLabel = formatClockTime(entry.atMs, timeZone) ?? '—';
  // Use the structural resolver so the row carries `isFallback`. History-detail
  // entries never pass disambiguation signals — the recorder-summarised entry
  // shape doesn't carry them — so `schedule_revised` rows stay on the bare
  // label, matching the live panel's behaviour when the disambiguation signals
  // are absent.
  const { label: reason, isFallback } = resolveRevisionReason(entry.reasonId, kind);
  const hourDiff = formatHourDiff(entry.hoursAdded, entry.hoursRemoved);
  const hourDiffAriaLabel = formatHourDiffAriaLabel(entry.hoursAdded, entry.hoursRemoved);
  return { timeLabel, reason, isFallback, hourDiff, hourDiffAriaLabel };
};

/**
 * Returns a short human-readable note about how many of the planner's allocated hours we
 * actually observed the device drawing power during. Resolves to `"Observed N of M scheduled
 * hours"` whenever the recorded plan carries at least one active hour (`plannedKWh > 0`) so
 * the N=0-of-M>0 case — the planner thought the device was active but it never drew power —
 * surfaces as a visible, actionable signal rather than silently disappearing. User-facing
 * copy says "scheduled" (not "planned") to keep planner-layer vocabulary out of UI/log strings
 * per `feedback_terminology_plan_vs_deadline.md`; the internal field stays `plannedKWh`
 * because that's the schema name.
 *
 * Returns `"No observations recorded — smart task reconstructed from settings"` for backfill
 * entries (no live observation stream to count against) and `null` when no active plan hours
 * were ever recorded (legacy entries without snapshots, unobserved zero-plan runs) so the
 * surface stays quiet on entries where there's nothing meaningful to report.
 *
 * Counts hour buckets, not seconds: M is the number of planned buckets with `plannedKWh > 0`
 * across the final plan (preferred — planner's last word) or original plan (fallback). N is
 * the number of those buckets whose `[startsAtMs, startsAtMs + 1h)` window overlaps any
 * `observedIntervals` slice — matches the same hour-overlap rule used by the chart's
 * `observed` axis (`buildHistoryDetailRows`).
 *
 * Lives in shared-domain so the same string can feed runtime log breadcrumbs alongside the
 * settings UI (per `feedback_ui_text_shared_with_logs.md`).
 */
export const formatPlanHistoryObservedCoverage = (
  entry: Pick<
    DeferredObjectivePlanHistoryEntry,
    'observedIntervals' | 'discoveredFrom' | 'originalPlan' | 'finalPlan'
  >,
): string | null => {
  if (entry.discoveredFrom === 'backfill') return 'No observations recorded — smart task reconstructed from settings';
  // Final plan is the planner's last word; the original plan is the cold-start fallback when
  // the run finalized before a replan. Mirrors the snapshot-pick rule used by the other
  // history-detail producers (`pickLastPlan`, `buildHistoryDetailRows`) so the coverage line
  // doesn't drift from the chart's "planned" axis.
  const lastPlan = pickLastPlan(entry);
  if (lastPlan === null) return null;
  const plannedBuckets = lastPlan.hours.filter(
    (hour) => Number.isFinite(hour.plannedKWh) && hour.plannedKWh > 0,
  );
  if (plannedBuckets.length === 0) return null;
  // Entries from older storage or from a test stub that predates the v2 contract may arrive
  // without `observedIntervals`; treat missing data as "zero observed buckets" so the
  // surface still surfaces the actionable case (planner thought N hours active, observed 0)
  // instead of silently dropping. The contract is enforced at the persistence boundary, not
  // in the renderer.
  const intervals = Array.isArray(entry.observedIntervals) ? entry.observedIntervals : [];
  const observedBuckets = plannedBuckets.filter((hour) => {
    const hourEndMs = hour.startsAtMs + HOUR_MS;
    return intervals.some((interval) => interval.fromMs < hourEndMs && interval.toMs > hour.startsAtMs);
  }).length;
  // Singularize the noun for the M === 1 case ("…of 1 scheduled hour") — matches the
  // `Schedule updated ${count} ${count === 1 ? 'time' : 'times'}` pattern elsewhere in this
  // file. M === 0 is short-circuited above so the helper never has to render "0 scheduled
  // hours" as the denominator. "Scheduled" aligns with `SMART_TASK_LIST_STATUS_LABELS.queued`
  // and keeps planner-layer vocabulary ("planned") out of user copy
  // (feedback_terminology_plan_vs_deadline).
  const noun = plannedBuckets.length === 1 ? 'hour' : 'hours';
  return `Observed ${observedBuckets} of ${plannedBuckets.length} scheduled ${noun}`;
};

// ─── Actual-vs-plan trajectory chart data (v2.7.2 PR 4) ───────────────────────
//
// Re-exported from `deferredPlanHistoryChartData.ts` so consumers can keep
// importing the chart payload from this module. Living in its own file keeps
// the formatters here inside the 500-LOC ESLint cap.
export {
  resolveHistoryDetailChartData,
  historyDetailChartLabels,
  type DeferredPlanHistoryChartData,
  type DeferredPlanHistoryChartMode,
  type DeferredPlanHistoryChartPoint,
  type HistoryDetailChartLabels,
} from './deferredPlanHistoryChartData';

// ─── Per-hour bar strip (v2.7.3) ──────────────────────────────────────────────
//
// Re-exported from `deferredPlanHistoryHourlyStrip.ts` so the postmortem view
// consumes one entry point. Producer-resolves the strip payload — the view
// never branches on the entry's optional fields.
export {
  resolveHistoryDetailHourlyStrip,
  type DeferredPlanHistoryHourlyStripData,
  type HourlyStripBucket,
} from './deferredPlanHistoryHourlyStrip';
