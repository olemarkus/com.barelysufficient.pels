// Overview smart-task failure/readiness row (2026-07 coherence train, PR-4).
//
// One slim tappable row between the Overview hero and the device cards —
// tap → the Smart tasks tab. The failing-recovering visitor lands on Overview
// (push notification), where smart-task miss data never reached before; the
// persona spec's P0 says failure must render differently from success, in the
// first sentence, with a one-tap recourse (`notes/personas.md` § Failing).
//
// At most ONE row ever, priority ladder (ux-fit gate 2026-07-04):
//   1. live `Cannot finish` — a failure the owner can still prevent tonight
//      outranks post-hoc diagnosis
//   2. recent-miss rollup (`formatMissStreakAggregateLine` copy, worst device)
//   3. live `At risk`
//   4. paused (compressed widget words — `Unplugged` / `Can’t resume` — the
//      full `Paused — unplugged` after the device-name em-dash would chain
//      three dashes)
//   5. steady: ≥1 genuinely on-track task (`on_track`/`queued`) — the row is
//      a FIXTURE, not an apparition: rendering only in crisis would make the
//      owner meet an unfamiliar element for the first time under stress
//   6. nothing at all (no on-track tasks and no recent misses — including
//      sets that are only `building_plan` (no allocation to claim yet) or
//      `satisfied` (already complete))
//
// ETA grammar: the canonical `Ready by HH:MM`; failing states swap to
// `Due HH:MM` via `resolveSmartTaskWidgetEtaVerb` (`Ready by` beside
// `Cannot finish` is registered as contradictory).
import {
  SMART_TASK_LIST_STATUS_LABELS,
  SMART_TASK_WIDGET_STATUS_LABELS,
  resolveSmartTaskWidgetEtaVerb,
  type SmartTaskListStatusId,
} from './deadlineLabels';

export type OverviewSmartTaskRowTone = 'alert' | 'warn' | 'muted';

export type OverviewSmartTaskRowVariant =
  | 'cannot_finish'
  | 'miss_streak'
  | 'at_risk'
  | 'paused'
  | 'steady';

export type OverviewSmartTaskRow = {
  tone: OverviewSmartTaskRowTone;
  variant: OverviewSmartTaskRowVariant;
  // The leading device name (ellipsizes at narrow widths) — null on the
  // steady variant, whose text is the aggregate count.
  deviceName: string | null;
  // The status text after the em-dash (must never truncate).
  statusText: string;
};

// Log-friendly single line (`Water Heater — 3 of last 4 runs missed`).
export const formatOverviewSmartTaskRowLine = (row: OverviewSmartTaskRow): string => (
  row.deviceName === null ? row.statusText : `${row.deviceName} — ${row.statusText}`
);

export type OverviewSmartTaskStatusInput = {
  deviceName: string;
  statusId: SmartTaskListStatusId;
  deadlineAtMs: number;
};

const pickSoonest = (
  statuses: readonly OverviewSmartTaskStatusInput[],
  ids: readonly SmartTaskListStatusId[],
): OverviewSmartTaskStatusInput | null => {
  let soonest: OverviewSmartTaskStatusInput | null = null;
  for (const status of statuses) {
    if (!ids.includes(status.statusId)) continue;
    if (soonest === null || status.deadlineAtMs < soonest.deadlineAtMs) soonest = status;
  }
  return soonest;
};

const STEADY_NOUN = (count: number): string => (count === 1 ? 'smart task' : 'smart tasks');

export const resolveOverviewSmartTaskRow = (params: {
  statuses: readonly OverviewSmartTaskStatusInput[];
  // Device-deduped recent-miss lines, worst/newest first (the past-tasks
  // subhead's `resolveMissStreakBadges` output).
  missStreaks: ReadonlyArray<{ deviceName: string; line: string }>;
  formatTime: (ms: number) => string;
}): OverviewSmartTaskRow | null => {
  const { statuses, missStreaks, formatTime } = params;

  const cannotFinish = pickSoonest(statuses, ['cannot_meet']);
  if (cannotFinish !== null) {
    return {
      tone: 'alert',
      variant: 'cannot_finish',
      deviceName: cannotFinish.deviceName,
      statusText: `${SMART_TASK_LIST_STATUS_LABELS.cannot_meet} · `
        + `${resolveSmartTaskWidgetEtaVerb(true)} ${formatTime(cannotFinish.deadlineAtMs)}`,
    };
  }

  const missStreak = missStreaks[0];
  if (missStreak !== undefined) {
    return {
      tone: 'alert',
      variant: 'miss_streak',
      deviceName: missStreak.deviceName,
      statusText: missStreak.line,
    };
  }

  const atRisk = pickSoonest(statuses, ['at_risk']);
  if (atRisk !== null) {
    return {
      tone: 'warn',
      variant: 'at_risk',
      deviceName: atRisk.deviceName,
      statusText: `${SMART_TASK_LIST_STATUS_LABELS.at_risk} · `
        + `${resolveSmartTaskWidgetEtaVerb(false)} ${formatTime(atRisk.deadlineAtMs)}`,
    };
  }

  // Every paused member, not just the EV one: a task the owner has to act on is
  // the whole point of this rung, and omitting one makes the row either vanish
  // (single task) or claim "on track" over a task that is not (mixed cohort).
  const paused = pickSoonest(statuses, ['paused_unplugged', 'paused_unmanaged']);
  if (paused !== null) {
    return {
      tone: 'warn',
      variant: 'paused',
      deviceName: paused.deviceName,
      statusText: SMART_TASK_WIDGET_STATUS_LABELS[paused.statusId],
    };
  }

  // The steady claim must stay honest: only tasks that are actually on track
  // (`on_track`, or `queued` — same user-facing state) are counted.
  // `building_plan` (no allocation yet — claiming "on track" would overclaim)
  // and `satisfied` (already complete) render nothing rather than a wrong
  // aggregate.
  const onTrackCount = statuses.filter(
    (status) => status.statusId === 'on_track' || status.statusId === 'queued',
  ).length;
  if (onTrackCount > 0) {
    // Lowercase mid-sentence `on track` — the registered trajectory-stateline
    // form of the chip vocabulary.
    return {
      tone: 'muted',
      variant: 'steady',
      deviceName: null,
      statusText: `${onTrackCount} ${STEADY_NOUN(onTrackCount)} · on track`,
    };
  }

  return null;
};
