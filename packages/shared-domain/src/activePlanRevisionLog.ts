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
} from '../../contracts/src/deferredObjectiveActivePlans.js';
import type { DeferredObjectiveSettingsKind } from '../../contracts/src/deferredObjectiveSettings.js';
import { revisionReason } from './deadlineLabels.js';
import { formatTimeInTimeZone } from './utils/dateUtils.js';

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
  // Short "what changed" copy from `revisionReason`.
  reason: string;
  // e.g. `+2h −1h`, `+2h`, or `−1h`; `null` when both counts are zero (a
  // revision that only redistributed kWh across the same hours — visually
  // quiet) OR when there is no prior revision in the log to diff against
  // (the oldest row).
  hourDiff: string | null;
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

const buildRow = (
  rev: DeferredObjectiveActivePlanRevisionV1,
  prior: DeferredObjectiveActivePlanRevisionV1 | null,
  timeZone: string,
  kind: DeferredObjectiveSettingsKind,
): ActivePlanRevisionLogRow => {
  const timeLabel = formatClockTime(rev.revisedAtMs, timeZone) ?? '—';
  const reason = revisionReason(rev.reason, kind);
  if (!prior) return { timeLabel, revision: rev.revision, reason, hourDiff: null };
  const { added, removed } = diffHourCounts(rev, prior);
  return { timeLabel, revision: rev.revision, reason, hourDiff: formatHourDiff(added, removed) };
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
