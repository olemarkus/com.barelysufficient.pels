import type { DeferredObjectiveSettingsKind } from '../../contracts/src/deferredObjectiveSettings.js';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionLogEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
  DeferredObjectivePlanOutcome,
} from '../../contracts/src/deferredObjectivePlanHistory.js';
import { APPROX_GLYPH, revisionReason } from './deadlineLabels.js';
import { formatTimeInTimeZone } from './utils/dateUtils.js';

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

export const formatPlanHistoryProgressLine = (
  entry: Pick<
    DeferredObjectivePlanHistoryEntry,
    'objectiveKind'
    | 'targetTemperatureC'
    | 'targetPercent'
    | 'startProgressC'
    | 'startProgressPercent'
    | 'finalProgressC'
    | 'finalProgressPercent'
  >,
): string | null => {
  if (entry.objectiveKind === 'temperature') {
    const start = formatTemperature(entry.startProgressC);
    const end = formatTemperature(entry.finalProgressC);
    const target = formatTemperature(entry.targetTemperatureC);
    if (!start || !target) return null;
    return `${start} → ${end ?? '—'}  ·  target ${target}`;
  }
  const start = formatPercent(entry.startProgressPercent);
  const end = formatPercent(entry.finalProgressPercent);
  const target = formatPercent(entry.targetPercent);
  if (!start || !target) return null;
  return `${start} → ${end ?? '—'}  ·  target ${target}`;
};

export const formatPlanHistoryReachedAtLine = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'metAtMs' | 'outcome'>,
  timeZone = 'UTC',
): string | null => {
  if (entry.outcome !== 'met' || entry.metAtMs === null) return null;
  const date = new Date(entry.metAtMs);
  if (Number.isNaN(date.getTime())) return null;
  const timeLabel = formatTimeInTimeZone(date, {
    hour: '2-digit',
    minute: '2-digit',
  }, timeZone);
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

export const getPlanHistoryOutcomeLabel = (outcome: DeferredObjectivePlanOutcome): string => (
  OUTCOME_LABELS[outcome]
);

export const getPlanHistoryOutcomeTone = (outcome: DeferredObjectivePlanOutcome): DeferredPlanHistoryChipTone => (
  OUTCOME_TONES[outcome]
);

export const shouldShowBackupHoursPill = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'usedPolicyAvoid' | 'usedDeadlineReserve'>,
): boolean => entry.usedPolicyAvoid || entry.usedDeadlineReserve;

// Overshoot threshold matches the `notes/smart-task-ui/README.md` design spec
// ("Notable extras: overshoot line if delivered > target by > 5 °C / 10 %").
// Pulled out of `wasOvershoot` so the dedicated overshoot line helper below
// can share the constant without a second copy. Kept module-private so the
// thresholds stay encapsulated alongside the helpers that read them.
const OVERSHOOT_TEMPERATURE_THRESHOLD_C_PUBLIC = 5;
const OVERSHOOT_PERCENT_THRESHOLD_PUBLIC = 10;

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
    DeferredObjectivePlanHistoryEntry,
    'outcome'
    | 'objectiveKind'
    | 'targetTemperatureC'
    | 'targetPercent'
    | 'finalProgressC'
    | 'finalProgressPercent'
  >,
): string | null => {
  if (entry.outcome !== 'met') return null;
  if (entry.objectiveKind === 'temperature') {
    if (entry.finalProgressC === null || entry.targetTemperatureC === null) return null;
    const delta = entry.finalProgressC - entry.targetTemperatureC;
    if (delta <= OVERSHOOT_TEMPERATURE_THRESHOLD_C_PUBLIC) return null;
    return `Overshoot ${delta.toFixed(1)} °C`;
  }
  if (entry.finalProgressPercent === null || entry.targetPercent === null) return null;
  const delta = entry.finalProgressPercent - entry.targetPercent;
  if (delta <= OVERSHOOT_PERCENT_THRESHOLD_PUBLIC) return null;
  return `Overshoot ${delta.toFixed(0)} %`;
};

/**
 * Composes the muted "See {device} usage on {date} →" cross-link label rendered below the
 * history-detail hero. Per `notes/smart-task-ui/README.md` "Cross-surface: vs Usage /
 * Insights", the asymmetric link from a Smart-task history detail to the same-day Usage
 * chart helps the recovering-from-mistake user see the device's whole-day energy context
 * when investigating a miss.
 *
 * Falls back to "usage" when the device name is missing so the line never reads as a
 * bare placeholder. `dateLabel` is the localized day string supplied by the caller (UI
 * layer) so shared-domain stays free of locale/Date helpers — same rule as
 * `formatPlanHistoryDeadlineLine`. The trailing arrow is part of the label so the
 * link reads as a navigation affordance even without underline styling.
 */
export const formatPlanHistoryUsageDayLinkLabel = (
  deviceName: string | null,
  dateLabel: string,
): string => {
  const device = deviceName && deviceName.trim().length > 0 ? deviceName : 'device';
  return `See ${device} usage on ${dateLabel} →`;
};

// Window size for the "miss-streak" aggregate on the past-tasks landing surface.
// Mirrors the lived-state Connected 300 example from `notes/smart-task-ui/README.md`:
// 3 missed runs in the most recent 4 history entries triggered the recovering-from-mistake
// persona's need for an aggregate signal. The window stays small (4) so a single late-night
// miss in an otherwise-healthy device never trips the aggregate.
const MISS_STREAK_WINDOW = 4;
// Half the window is the threshold — keeps the resolver kind-agnostic and matches the
// notes' "3 of last 4 missed" framing (3/4 ≥ 0.5).
const MISS_STREAK_THRESHOLD = 0.5;

/**
 * Composes the "Past tasks (N of last M missed)" subhead string when a device's most-recent
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
  return `${missed} of last ${recent.length} missed`;
};

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const formatDurationMs = (ms: number): string => {
  if (ms <= 0) return '0m';
  // Floor to whole minutes so a sub-hour gap never rounds up across the hour boundary (e.g.
  // 59m 31s must render as "59m", not "1h", to stay consistent with the caller's HOUR_MS
  // threshold for the "Brief gap" / "Not observed for" split).
  const totalMinutes = Math.floor(ms / MINUTE_MS);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
};

const sumObservedMs = (
  intervals: ReadonlyArray<{ fromMs: number; toMs: number }>,
): number => intervals.reduce((acc, interval) => acc + Math.max(0, interval.toMs - interval.fromMs), 0);

// True when the snapshot recorded the planner's daily-budget cap collapsing
// on at least one bucket in the run-up. The recorder persists positive
// counts only (`captureRevisionSnapshot` filters zeros), so the helper
// treats absence and zero identically — the budget was either not checked
// or was fine. Producer-side resolver so consumers never branch on the raw
// optional field.
const snapshotShowsBudgetExhausted = (
  snapshot: DeferredObjectivePlanHistoryRevisionSnapshot | null,
): boolean => (
  snapshot !== null
    && typeof snapshot.dailyBudgetExhaustedBucketCount === 'number'
    && snapshot.dailyBudgetExhaustedBucketCount > 0
);

const pickLastPlan = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'finalPlan' | 'originalPlan'>,
): DeferredObjectivePlanHistoryRevisionSnapshot | null => (
  // Prefer the final plan's status — it reflects the planner's last word
  // before finalization. Fall back to the original snapshot when the run
  // finalized before the planner replanned (no finalPlan recorded).
  entry.finalPlan ?? entry.originalPlan
);

/**
 * Composes a short human-readable explanation for *why* a finalized run was marked missed.
 * Resolves to flat copy from the recorded snapshots so the missed-history surface mirrors the
 * succeeded path's "explanation density": users opening a missed run need to see the cause
 * without inferring from chart bars alone.
 *
 * Branches resolve in priority order (most specific first):
 *  1. Daily budget exhausted on the last revision → an action-oriented sentence
 *     pointing the user at the budget surface as the recourse path (v2.7.2 PR 3
 *     fold-in from PR #856 P2: the previous "couldn't reserve enough energy"
 *     fallback under-served the daily-budget cause).
 *  2. Final plan status `cannot_meet` → "PELS couldn't reserve enough energy in time."
 *  3. Final plan status `at_risk`     → "The smart task fell behind and didn't catch up
 *                                       before the deadline."
 *  4. Discovered from backfill        → "PELS was restarted during this smart task —
 *                                       outcome reconstructed from settings."
 *  5. Otherwise                       → "The device did not reach the target before the
 *                                       deadline."
 *
 * Returns `null` only when the entry is not `outcome === 'missed'`; the missed-history page
 * always renders something so the user is never left with a chip and no explanation.
 *
 * Per `feedback_hard_cap_is_physical.md`, the daily-budget branch recommends lowering the
 * daily budget so future days reserve power earlier — never raising the capacity hard cap.
 *
 * Lives in shared-domain so the same strings can feed runtime log breadcrumbs (per
 * `feedback_ui_text_shared_with_logs.md`).
 */
export const formatPlanHistoryMissedReason = (
  entry: Pick<
    DeferredObjectivePlanHistoryEntry,
    'outcome' | 'originalPlan' | 'finalPlan' | 'discoveredFrom'
  >,
): string | null => {
  if (entry.outcome !== 'missed') return null;
  const lastPlan = pickLastPlan(entry);
  if (snapshotShowsBudgetExhausted(lastPlan)) {
    return 'The daily energy budget was used up before the deadline. '
      + 'Lower today\'s daily budget so tomorrow\'s planning has room, or move the '
      + 'deadline to a later day.';
  }
  if (lastPlan?.planStatus === 'cannot_meet') {
    return 'PELS couldn\'t reserve enough energy in time. '
      + 'Try lowering the target or moving the deadline later.';
  }
  if (lastPlan?.planStatus === 'at_risk') {
    return 'The smart task fell behind and didn\'t catch up before the deadline.';
  }
  if (entry.discoveredFrom === 'backfill') {
    return 'PELS was restarted during this smart task — outcome reconstructed from settings.';
  }
  return 'The device did not reach the target before the deadline.';
};

// Outcome variant the postmortem resolver picks for a finalized entry. Six
// concrete variants plus the `unknown` fallback so the consumer never has
// to handle null. Producer resolves the variant once; the view layer reads
// the resolved sentence and never re-derives.
export type DeferredPlanHistoryPostmortemVariant =
  | 'met-with-margin'
  | 'met-with-overshoot'
  | 'met-at-buzzer'
  | 'missed-by-shortfall'
  | 'missed-by-budget-exhaustion'
  | 'abandoned-by-clear'
  | 'abandoned-by-unplug'
  | 'unknown';

export type DeferredPlanHistoryPostmortem = {
  variant: DeferredPlanHistoryPostmortemVariant;
  sentence: string;
};

const MET_AT_BUZZER_WINDOW_MS = HOUR_MS;
// Aliased to the module-private constants used by `formatPlanHistoryOvershootLine`
// so the two helpers can't drift on the threshold definition (5 °C / 10 %).
const OVERSHOOT_TEMPERATURE_THRESHOLD_C = OVERSHOOT_TEMPERATURE_THRESHOLD_C_PUBLIC;
const OVERSHOOT_PERCENT_THRESHOLD = OVERSHOOT_PERCENT_THRESHOLD_PUBLIC;

const formatClockTime = (ms: number, timeZone: string): string | null => {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return formatTimeInTimeZone(date, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }, timeZone);
};

const formatTargetValue = (
  kind: 'temperature' | 'ev_soc',
  targetTemperatureC: number | null,
  targetPercent: number | null,
): string | null => {
  if (kind === 'temperature') {
    return targetTemperatureC === null ? null : `${targetTemperatureC.toFixed(1)} °C`;
  }
  return targetPercent === null ? null : `${targetPercent.toFixed(0)} %`;
};

const formatFinalProgressValue = (
  kind: 'temperature' | 'ev_soc',
  finalProgressC: number | null,
  finalProgressPercent: number | null,
): string | null => {
  if (kind === 'temperature') {
    return finalProgressC === null ? null : `${finalProgressC.toFixed(1)} °C`;
  }
  return finalProgressPercent === null ? null : `${finalProgressPercent.toFixed(0)} %`;
};

const formatShortfallValue = (
  kind: 'temperature' | 'ev_soc',
  finalProgressC: number | null,
  targetTemperatureC: number | null,
  finalProgressPercent: number | null,
  targetPercent: number | null,
): string | null => {
  if (kind === 'temperature') {
    if (finalProgressC === null || targetTemperatureC === null) return null;
    const gap = targetTemperatureC - finalProgressC;
    if (gap <= 0) return null;
    return `${gap.toFixed(1)} °C`;
  }
  if (finalProgressPercent === null || targetPercent === null) return null;
  const gap = targetPercent - finalProgressPercent;
  if (gap <= 0) return null;
  return `${gap.toFixed(0)} %`;
};

// Detect whether a `met` outcome overshot the target meaningfully. Threshold
// matches the Smart-task UI design spec ("Notable extras: overshoot line if
// delivered > target by > 5 °C / 10 %"). The producer surfaces the overshoot
// to the postmortem sentence; the dedicated overshoot line copy lives in PR 6.
const wasOvershoot = (
  kind: 'temperature' | 'ev_soc',
  finalProgressC: number | null,
  targetTemperatureC: number | null,
  finalProgressPercent: number | null,
  targetPercent: number | null,
): boolean => {
  if (kind === 'temperature') {
    if (finalProgressC === null || targetTemperatureC === null) return false;
    return finalProgressC - targetTemperatureC > OVERSHOOT_TEMPERATURE_THRESHOLD_C;
  }
  if (finalProgressPercent === null || targetPercent === null) return false;
  return finalProgressPercent - targetPercent > OVERSHOOT_PERCENT_THRESHOLD;
};

type PostmortemEntry = Pick<
  DeferredObjectivePlanHistoryEntry,
  'outcome'
  | 'objectiveKind'
  | 'targetTemperatureC'
  | 'targetPercent'
  | 'finalProgressC'
  | 'finalProgressPercent'
  | 'metAtMs'
  | 'deadlineAtMs'
  | 'finalizedAtMs'
  | 'finalPlan'
  | 'originalPlan'
  | 'discoveredFrom'
>;

type MetTimingLabels = {
  targetLabel: string;
  metAtLabel: string;
  deadlineLabel: string;
  marginMs: number;
};

// Bundles the three labels + margin that the met-postmortem sentences need.
// Returns null when any of the timing pieces are missing — the caller falls
// through to the plain "Reached the target before the deadline" copy.
const resolveMetTimingLabels = (
  entry: PostmortemEntry,
  timeZone: string,
): MetTimingLabels | null => {
  const targetLabel = formatTargetValue(
    entry.objectiveKind,
    entry.targetTemperatureC,
    entry.targetPercent,
  );
  const metAtLabel = entry.metAtMs !== null ? formatClockTime(entry.metAtMs, timeZone) : null;
  const deadlineLabel = formatClockTime(entry.deadlineAtMs, timeZone);
  const marginMs = entry.metAtMs === null ? null : entry.deadlineAtMs - entry.metAtMs;
  if (targetLabel === null
    || metAtLabel === null
    || deadlineLabel === null
    || marginMs === null
    || marginMs < 0) return null;
  return { targetLabel, metAtLabel, deadlineLabel, marginMs };
};

const resolveMetPostmortem = (
  entry: PostmortemEntry,
  timeZone: string,
): DeferredPlanHistoryPostmortem => {
  const timing = resolveMetTimingLabels(entry, timeZone);
  const overshot = wasOvershoot(
    entry.objectiveKind,
    entry.finalProgressC,
    entry.targetTemperatureC,
    entry.finalProgressPercent,
    entry.targetPercent,
  );
  if (overshot && timing !== null) {
    return {
      variant: 'met-with-overshoot',
      sentence: `Hit ${timing.targetLabel} at ${timing.metAtLabel}, before ${timing.deadlineLabel} — overshot.`,
    };
  }
  // Met-at-buzzer: reached the target inside the last planned hour of the
  // window. The window length is hard-coded to one hour so the test is
  // independent of plan length — a deadline that hits 2 minutes early reads
  // the same whether the run was 6 or 24 hours.
  if (timing !== null && timing.marginMs <= MET_AT_BUZZER_WINDOW_MS) {
    return {
      variant: 'met-at-buzzer',
      sentence: `Hit ${timing.targetLabel} at ${timing.metAtLabel}, `
        + `${formatDurationMs(timing.marginMs)} before ${timing.deadlineLabel}.`,
    };
  }
  if (timing !== null) {
    return {
      variant: 'met-with-margin',
      sentence: `Hit ${timing.targetLabel} at ${timing.metAtLabel}, `
        + `${formatDurationMs(timing.marginMs)} before ${timing.deadlineLabel}.`,
    };
  }
  // Met but we lack the timing detail to compose the receipt sentence (legacy
  // entry without `metAtMs`, malformed deadline). Fall back to a plain
  // confirmation rather than null so the hero always carries a lead line.
  const targetLabel = formatTargetValue(
    entry.objectiveKind,
    entry.targetTemperatureC,
    entry.targetPercent,
  );
  return {
    variant: 'met-with-margin',
    sentence: targetLabel !== null
      ? `Reached ${targetLabel} before the deadline.`
      : 'Reached the target before the deadline.',
  };
};

const resolveMissedPostmortem = (
  entry: PostmortemEntry,
  timeZone: string,
): DeferredPlanHistoryPostmortem => {
  const lastPlan = pickLastPlan(entry);
  const deadlineLabel = formatClockTime(entry.deadlineAtMs, timeZone);
  if (snapshotShowsBudgetExhausted(lastPlan)) {
    // Budget-exhaustion gets the most specific copy — the user opening a
    // missed run needs to see that the cause was the budget cap, not a
    // device problem, so the recourse (lower daily budget) lands cleanly.
    return {
      variant: 'missed-by-budget-exhaustion',
      sentence: deadlineLabel !== null
        ? `The daily energy budget ran out before ${deadlineLabel}.`
        : 'The daily energy budget ran out before the deadline.',
    };
  }
  const finalLabel = formatFinalProgressValue(
    entry.objectiveKind,
    entry.finalProgressC,
    entry.finalProgressPercent,
  );
  const targetLabel = formatTargetValue(
    entry.objectiveKind,
    entry.targetTemperatureC,
    entry.targetPercent,
  );
  const shortfallLabel = formatShortfallValue(
    entry.objectiveKind,
    entry.finalProgressC,
    entry.targetTemperatureC,
    entry.finalProgressPercent,
    entry.targetPercent,
  );
  if (
    finalLabel !== null
      && targetLabel !== null
      && shortfallLabel !== null
      && deadlineLabel !== null
  ) {
    return {
      variant: 'missed-by-shortfall',
      sentence: `Reached ${finalLabel} by ${deadlineLabel} — ${shortfallLabel} short of ${targetLabel}.`,
    };
  }
  return {
    variant: 'missed-by-shortfall',
    sentence: 'Did not reach the target before the deadline.',
  };
};

const resolveAbandonedPostmortem = (
  entry: PostmortemEntry,
  timeZone: string,
): DeferredPlanHistoryPostmortem => {
  const finalizedLabel = formatClockTime(entry.finalizedAtMs, timeZone);
  // Outcome `'replaced'` is the user-swapped path: the user changed the
  // target / deadline so the previous in-progress run was wrapped up before
  // its deadline (see `DeferredObjectivePlanHistoryRecorder.finalizeForUserChange`).
  // `'abandoned'` covers two distinct underlying paths that aren't
  // distinguishable from the persisted outcome alone:
  //   - `finalizeForUserChange(..., 'abandoned')` when the user clears the
  //     deadline outright; and
  //   - the stale-diagnostic timeout path (`finalizeStaleRecords`) when the
  //     diagnostic stream stops while the deadline is still future — e.g.
  //     EV plugged out, thermal device offline beyond the grace window.
  // Without more signal in the schema, the copy stays kind-aware but
  // cause-neutral so neither branch claims a cause it cannot prove.
  if (entry.outcome === 'replaced') {
    return {
      variant: 'abandoned-by-clear',
      sentence: finalizedLabel !== null
        ? `You replaced this smart task at ${finalizedLabel}.`
        : 'You replaced this smart task before the deadline.',
    };
  }
  // `outcome === 'abandoned'` — either an explicit user-clear or a stale
  // diagnostic. We can't distinguish, so the copy says "stopped" rather
  // than asserting "unplugged" (which would be wrong for the clear path)
  // or "cleared" (which would be wrong for the unplug path). The kind
  // suffix names the most likely underlying device behaviour without
  // claiming a specific cause.
  const kindSuffix = entry.objectiveKind === 'ev_soc'
    ? ' (charger stopped reporting or the smart task was cleared)'
    : ' (device stopped reporting or the smart task was cleared)';
  return {
    variant: 'abandoned-by-unplug',
    sentence: finalizedLabel !== null
      ? `This smart task stopped at ${finalizedLabel}${kindSuffix}.`
      : `This smart task stopped before the deadline${kindSuffix}.`,
  };
};

/**
 * Composes a one-sentence postmortem for a finalized history entry. Six concrete
 * variants split across the three outcome shapes from
 * `notes/smart-task-ui/README.md` "Asymmetric treatment of failure":
 *
 *  - `met-with-margin`     — reached the target with > 1h to spare.
 *  - `met-with-overshoot`  — succeeded but the final reading exceeded the
 *                            target by > 5 °C or > 10 %.
 *  - `met-at-buzzer`       — reached the target inside the last planned hour.
 *  - `missed-by-shortfall` — final progress < target with no daily-budget
 *                            cause recorded.
 *  - `missed-by-budget-exhaustion` — the final revision recorded the daily
 *                                    budget cap collapsing buckets in the run-up.
 *  - `abandoned-by-clear`  — user cleared / replaced the smart task before
 *                            finalization (`outcome === 'replaced'`).
 *  - `abandoned-by-unplug` — diagnostic stream stopped before the deadline
 *                            (EV unplugged, device went offline).
 *
 * Returns the `unknown` variant rather than `null` so the consumer always
 * has a sentence to render — the panic visitor lands on a page that says
 * *something* about why, even when the schema can't fully recover the cause.
 *
 * `timeZone` is supplied by the caller (UI layer) so this stays free of any
 * runtime locale/Date helpers beyond `formatTimeInTimeZone`.
 *
 * Lives in shared-domain so structured log breadcrumbs and the history-detail
 * hero render the same sentence (per `feedback_ui_text_shared_with_logs.md`).
 */
export const formatPlanHistoryPostmortem = (
  entry: PostmortemEntry,
  timeZone = 'UTC',
): DeferredPlanHistoryPostmortem => {
  if (entry.outcome === 'met') return resolveMetPostmortem(entry, timeZone);
  if (entry.outcome === 'missed') return resolveMissedPostmortem(entry, timeZone);
  if (entry.outcome === 'abandoned' || entry.outcome === 'replaced') {
    return resolveAbandonedPostmortem(entry, timeZone);
  }
  // `outcome === 'unknown'` — the recorder couldn't classify (e.g. backfill
  // entry without progress data). Surface that honestly rather than invent a
  // success/failure narrative.
  if (entry.discoveredFrom === 'backfill') {
    return {
      variant: 'unknown',
      sentence: 'PELS was restarted during this smart task — the outcome was reconstructed from settings.',
    };
  }
  return {
    variant: 'unknown',
    sentence: 'PELS could not determine how this smart task finished.',
  };
};

// Composes the secondary line shared by the Succeeded receipt and the Missed
// diagnosis shapes — `Cost ≈ X kr [partial] · Y kWh delivered`. The
// `costSuffix` lets the Missed branch surface `" partial"` so the user reads
// the cost as the partial-delivery cost, not the planned total. Null when
// neither delivery nor cost was captured (legacy entry, no hourly feed) —
// better than fabricating "0 kWh delivered" for entries with no record. The
// approximation glyph matches `formatDeadlineCostMetaLine` from the live
// hero so cost reads identically across live and past surfaces.
export const formatPlanHistoryCostAndDelivered = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'deliveredKWh' | 'totalCost'>,
  costUnit: string,
  costSuffix: string,
): string | null => {
  const hasDelivery = typeof entry.deliveredKWh === 'number'
    && Number.isFinite(entry.deliveredKWh);
  const hasCost = typeof entry.totalCost === 'number'
    && Number.isFinite(entry.totalCost);
  if (!hasDelivery && !hasCost) return null;
  const trimmedUnit = costUnit.trim();
  const parts: string[] = [];
  if (hasCost && trimmedUnit.length > 0) {
    parts.push(`Cost ${APPROX_GLYPH} ${entry.totalCost!.toFixed(2)} ${trimmedUnit}${costSuffix}`);
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
//   `timeLabel`   pre-formatted local time (e.g. `14:32`) of the revision.
//   `reason`      short "what changed" copy from `revisionReason`.
//   `hourDiff`    e.g. `+2h −1h` or `+2h` / `−1h`; `null` when both counts
//                 are zero (the revision touched the same hours the previous
//                 revision already covered, so the diff is silent).
export type PlanHistoryRevisionLogRow = {
  timeLabel: string;
  reason: string;
  hourDiff: string | null;
};

const formatHourDiff = (hoursAdded: number, hoursRemoved: number): string | null => {
  // Both counts are non-negative integer counts of bucket starts in the
  // symmetric difference between consecutive revisions, so a zero on either
  // side means "no change in that direction". Producer-side suppression of
  // the all-zero case keeps the row visually quiet when a revision only
  // moved per-hour kWh (without adding or removing hours).
  const added = Number.isFinite(hoursAdded) && hoursAdded > 0 ? Math.floor(hoursAdded) : 0;
  const removed = Number.isFinite(hoursRemoved) && hoursRemoved > 0 ? Math.floor(hoursRemoved) : 0;
  if (added === 0 && removed === 0) return null;
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}h`);
  // U+2212 MINUS SIGN — matches the typographic minus used elsewhere in the
  // smart-task UI (cost meta line, postmortem sentences) so the revision log
  // doesn't drift to ASCII hyphen and read as a range separator.
  if (removed > 0) parts.push(`−${removed}h`);
  return parts.join(' ');
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
  const reason = revisionReason(entry.reasonId, kind);
  const hourDiff = formatHourDiff(entry.hoursAdded, entry.hoursRemoved);
  return { timeLabel, reason, hourDiff };
};

/**
 * Returns a short human-readable note about how complete the observation was for the entry, or
 * `null` if coverage was effectively full (≥99% of the [start, deadline] window). Used by the
 * settings UI to explain entries that may have data gaps (PELS off, diagnostics unavailable).
 */
export const formatPlanHistoryObservedCoverage = (
  entry: Pick<
    DeferredObjectivePlanHistoryEntry,
    'observedIntervals' | 'discoveredFrom' | 'startedAtMs' | 'deadlineAtMs'
  >,
): string | null => {
  if (entry.discoveredFrom === 'backfill') return 'No observations recorded — smart task reconstructed from settings';
  // Entries from older storage or from a test stub that predates the v2 contract may arrive
  // without `observedIntervals`; without this guard the reduce below would throw and crash
  // the surrounding component. Treat missing data as "no coverage info" rather than a hard
  // failure — the contract is enforced at the persistence boundary, not in the renderer.
  if (!Array.isArray(entry.observedIntervals)) return null;
  const windowMs = Math.max(0, entry.deadlineAtMs - entry.startedAtMs);
  if (windowMs < MINUTE_MS) return null;
  const observedMs = Math.min(windowMs, sumObservedMs(entry.observedIntervals));
  const missingMs = Math.max(0, windowMs - observedMs);
  if (missingMs <= Math.max(MINUTE_MS, windowMs * 0.01)) return null;
  if (missingMs >= HOUR_MS) return `Not observed for ${formatDurationMs(missingMs)}`;
  return `Brief gap (${formatDurationMs(missingMs)}) in observation`;
};

// ─── Actual-vs-plan trajectory chart data (v2.7.2 PR 4) ───────────────────────
//
// Re-exported from `deferredPlanHistoryChartData.ts` so consumers can keep
// importing the chart payload from this module. Living in its own file keeps
// the formatters here inside the 500-LOC ESLint cap.
export {
  resolveHistoryDetailChartData,
  type DeferredPlanHistoryChartData,
  type DeferredPlanHistoryChartMode,
  type DeferredPlanHistoryChartPoint,
} from './deferredPlanHistoryChartData.js';

// ─── Per-hour bar strip (v2.7.3) ──────────────────────────────────────────────
//
// Re-exported from `deferredPlanHistoryHourlyStrip.ts` so the postmortem view
// consumes one entry point. Producer-resolves the strip payload — the view
// never branches on the entry's optional fields.
export {
  resolveHistoryDetailHourlyStrip,
  type DeferredPlanHistoryHourlyStripData,
  type HourlyStripBucket,
} from './deferredPlanHistoryHourlyStrip.js';
