// Producer-side helper for the smart-task **live-plan** revision panel
// (`packages/settings-ui/src/ui/views/DeadlinePlan.tsx`). Builds a flat,
// most-recent-first array of pre-resolved row objects from the active plan's
// `latest` + `history`, so the view layer renders only strings and never
// branches on revision shape / reason ID / hour-diff signs.
//
// Distinct from the post-finalization revision log in `deferredPlanHistory.ts`
// (`PlanHistoryRevisionLogRow`) because:
//   - the input shape is `DeferredObjectiveActivePlanRevisionV1` (full bucket
//     arrays), not a recorder-summarised log entry;
//   - hour-diff is computed here from set membership of `hours[].startsAtMs`
//     between consecutive revisions, rather than carried as pre-counted
//     `hoursAdded` / `hoursRemoved` fields;
//   - the head row is the `latest` revision itself (it's still part of the
//     log — the row narrates "this current plan exists because <reason>");
//     subsequent rows are entries from `history` in order, oldest at the tail.

import type {
  DeferredObjectiveActivePlanRevisionV1,
} from '../../contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectiveSettingsKind } from '../../contracts/src/deferredObjectiveSettings';
import { resolveRevisionReason, type RevisionReasonDisambiguation } from './deadlineLabels';
import { formatTimeInTimeZone } from './utils/dateUtils';

// Resolved shape of a single row in the live-plan revision panel. Mirrors
// `PlanHistoryRevisionLogRow` deliberately — the visual binding on the page
// (`.plan-revision-row` per m3-critic guidance) is shared with the
// post-finalization revision log so both surfaces stay visually identical.
export type ActivePlanRevisionLogRow = {
  // Pre-formatted local time (e.g. `14:32`) of the revision.
  timeLabel: string;
  // Pre-resolved revision number (1-indexed). Useful for `aria-label`s and
  // for tests pinning ordering; the row template does not have to render it.
  revision: number;
  // Short "what changed" copy from `revisionReason`. For `schedule_revised`
  // revisions, this may be one of the disambiguated variants
  // (`Schedule revised — daily budget shifted`, `… — risk changed`,
  // `… — cheaper hour opened`) when the live-plan signals are conclusive.
  reason: string;
  // True when the recorder emitted a reason code the resolver hasn't learned
  // about and the row fell back to `Plan refreshed`. The view layer can use
  // this to suppress the hour-diff chip (otherwise the chip mis-attributes
  // the diff to a vague "Plan refreshed" line) and/or emit a one-shot
  // logging breadcrumb so the gap doesn't go unnoticed.
  isFallback: boolean;
  // e.g. `+2h −1h`, `+2h`, or `−1h`; `null` when both counts are zero (a
  // revision that only redistributed kWh across the same hours — visually
  // quiet) OR when there is no prior revision in the log to diff against
  // (the oldest row).
  hourDiff: string | null;
  // Long-form accessible label paired with `hourDiff`. e.g. `1 hour added`,
  // `2 hours dropped`, or `1 hour added, 2 hours dropped`. Bound to the
  // `<span>`'s `title` and `aria-label` so screen readers don't read the
  // chip as "plus one h". `null` when `hourDiff === null`.
  hourDiffAriaLabel: string | null;
};

// Producer-side gate (`isUserInitiated === true`) marking whether the revision
// was produced by a direct user action. Single criterion today —
// `reason === 'flow_card'`. Kept separate from the resolved label string so
// the consumer never branches on the underlying recorder code.
const isUserInitiatedReason = (
  reasonId: DeferredObjectiveActivePlanRevisionV1['reason'],
): boolean => reasonId === 'flow_card';

// Producer-side summary for the collapsed `<details><summary>` block. The
// view binds `text` to the summary line and consults `shouldShowPanel` to
// decide whether to render the panel at all. Computed from the resolved
// row array (most-recent first) so the producer owns the format string;
// the consumer never assembles copy from row fields.
export type ActivePlanRevisionLogSummary = {
  // Pre-formatted summary line. e.g. `Schedule revised — daily budget shifted
  // at 15:42 (+1h)`. Null when there are no rows worth surfacing.
  text: string | null;
  // Total revision count. Useful as a secondary chip / aria-label.
  count: number;
  // True when at least one revision in the log was *not* a direct user action
  // (i.e. a planner-initiated revision). The panel's mission is to surface
  // *why PELS changed the plan*; if every revision was a user-fired Flow
  // card, the panel adds no narrative the user doesn't already know.
  shouldShowPanel: boolean;
};

const formatHourDiff = (added: number, removed: number): string | null => {
  if (added <= 0 && removed <= 0) return null;
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}h`);
  // U+2212 MINUS SIGN — matches the typographic minus used elsewhere in the
  // smart-task UI (post-finalization revision log, cost meta line, postmortem
  // sentences) so the live revision log doesn't drift to ASCII hyphen and
  // read as a range separator.
  if (removed > 0) parts.push(`−${removed}h`);
  return parts.join(' ');
};

const pluralHour = (n: number): string => (n === 1 ? 'hour' : 'hours');

const formatHourDiffAriaLabel = (added: number, removed: number): string | null => {
  if (added <= 0 && removed <= 0) return null;
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} ${pluralHour(added)} added`);
  if (removed > 0) parts.push(`${removed} ${pluralHour(removed)} dropped`);
  return parts.join(', ');
};

const formatClockTime = (ms: number, timeZone: string): string | null => {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return formatTimeInTimeZone(date, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }, timeZone);
  } catch {
    return null;
  }
};

const diffHourCounts = (
  rev: DeferredObjectiveActivePlanRevisionV1,
  prior: DeferredObjectiveActivePlanRevisionV1,
): { added: number; removed: number } => {
  const curr = new Set(rev.hours.map((h) => h.startsAtMs));
  const old = new Set(prior.hours.map((h) => h.startsAtMs));
  let added = 0;
  let removed = 0;
  for (const k of curr) if (!old.has(k)) added += 1;
  for (const k of old) if (!curr.has(k)) removed += 1;
  return { added, removed };
};

// Assemble the disambiguation signals for `schedule_revised`. Returns
// `undefined` when nothing is known so the resolver doesn't waste a check
// for the bare-label case. `planStatusChanged` requires a prior to compare;
// budget signals are read off the current revision regardless.
const buildDisambiguation = (
  rev: DeferredObjectiveActivePlanRevisionV1,
  prior: DeferredObjectiveActivePlanRevisionV1 | null,
  hourDiff: { added: number; removed: number } | null,
): RevisionReasonDisambiguation | undefined => {
  if (rev.reason !== 'schedule_revised') return undefined;
  return {
    planStatusChanged: prior !== null && prior.planStatus !== rev.planStatus,
    dailyBudgetExhaustedBucketCount: rev.dailyBudgetExhaustedBucketCount,
    floorShortfallCause: rev.floorShortfallCause,
    hoursAdded: hourDiff?.added,
    hoursRemoved: hourDiff?.removed,
  };
};

const buildRow = (
  rev: DeferredObjectiveActivePlanRevisionV1,
  prior: DeferredObjectiveActivePlanRevisionV1 | null,
  timeZone: string,
  kind: DeferredObjectiveSettingsKind,
): ActivePlanRevisionLogRow => {
  const timeLabel = formatClockTime(rev.revisedAtMs, timeZone) ?? '—';
  const hourDiff = prior !== null ? diffHourCounts(rev, prior) : null;
  const { label, isFallback } = resolveRevisionReason(
    rev.reason,
    kind,
    buildDisambiguation(rev, prior, hourDiff),
  );
  if (hourDiff === null) {
    return {
      timeLabel,
      revision: rev.revision,
      reason: label,
      isFallback,
      hourDiff: null,
      hourDiffAriaLabel: null,
    };
  }
  return {
    timeLabel,
    revision: rev.revision,
    reason: label,
    isFallback,
    hourDiff: formatHourDiff(hourDiff.added, hourDiff.removed),
    hourDiffAriaLabel: formatHourDiffAriaLabel(hourDiff.added, hourDiff.removed),
  };
};

/**
 * Build the most-recent-first revision log for the smart-task detail page's
 * inline revision panel. Returns an empty array when there is no `latest`
 * revision (e.g. a pending plan with no allocation yet) so the view can
 * short-circuit the `<details>` block.
 *
 * Per `feedback_ui_text_shared_with_logs.md`, the `revisionReason` resolver
 * is shared with the runtime log breadcrumbs so the two surfaces stay in sync.
 */
export const buildActivePlanRevisionLog = (params: {
  latest: DeferredObjectiveActivePlanRevisionV1 | null;
  history: readonly DeferredObjectiveActivePlanRevisionV1[] | undefined;
  timeZone: string;
  kind: DeferredObjectiveSettingsKind;
}): ActivePlanRevisionLogRow[] => {
  if (!params.latest) return [];
  const chain: DeferredObjectiveActivePlanRevisionV1[] = [
    params.latest,
    ...(params.history ?? []),
  ];
  return chain.map((rev, i) => buildRow(rev, chain[i + 1] ?? null, params.timeZone, params.kind));
};

// Interpunct (U+00B7) separates the summary's reason / time / diff clauses
// so labels whose last words form a verb phrase (`Flow changed what this
// smart task may do`) don't bleed into the time clause and parse as
// `…what this smart task may do at 15:42`. The middle dot is the existing
// PELS clause separator (cf. the panel's outer summary `Recent plan changes
// · …` hint). Single space around the dot keeps screen-reader cadence sane.
const SUMMARY_CLAUSE_SEP = ' · ';

const formatSummaryText = (head: ActivePlanRevisionLogRow): string => {
  const parts: string[] = [head.reason, head.timeLabel];
  // Suppress the diff clause on fallback rows for the same reason the
  // row-level chip is suppressed: a vague `Plan refreshed` reason paired
  // with `+1h` mis-attributes the diff to a reason that says nothing.
  if (head.hourDiff !== null && !head.isFallback) parts.push(head.hourDiff);
  return parts.join(SUMMARY_CLAUSE_SEP);
};

/**
 * Build the producer-side summary for the collapsed `<summary>` block. Takes
 * the rows + the source chain so the panel-visibility gate can be computed
 * on the underlying reasonIds without leaking them through the public row
 * shape. Returns `{ text: null, count: 0, shouldShowPanel: false }` for an
 * empty log so the view can early-return on the summary alone.
 */
export const buildActivePlanRevisionLogSummary = (params: {
  latest: DeferredObjectiveActivePlanRevisionV1 | null;
  history: readonly DeferredObjectiveActivePlanRevisionV1[] | undefined;
  rows: readonly ActivePlanRevisionLogRow[];
}): ActivePlanRevisionLogSummary => {
  const { latest, history, rows } = params;
  if (rows.length === 0 || latest === null) {
    return { text: null, count: 0, shouldShowPanel: false };
  }
  const chainReasons: DeferredObjectiveActivePlanRevisionV1['reason'][] = [
    latest.reason,
    ...(history ?? []).map((r) => r.reason),
  ];
  const shouldShowPanel = chainReasons.some((reasonId) => !isUserInitiatedReason(reasonId));
  // Head selection prefers the most-recent *system* revision so the summary
  // line matches the gate's promise: the panel exists because the planner
  // did something, so the at-rest line should narrate that something. When
  // every revision in the chain is user-initiated (`shouldShowPanel` will
  // be false in that case anyway), fall back to `rows[0]` so the summary
  // is still populated if a future caller renders the panel unconditionally.
  // Chain order matches row order (most-recent first), so `findIndex` on
  // chainReasons maps 1:1 to a rows[] index.
  const systemHeadIndex = chainReasons.findIndex((reasonId) => !isUserInitiatedReason(reasonId));
  const head = systemHeadIndex >= 0 ? rows[systemHeadIndex] : rows[0];
  return {
    text: head === undefined ? null : formatSummaryText(head),
    count: rows.length,
    shouldShowPanel,
  };
};
