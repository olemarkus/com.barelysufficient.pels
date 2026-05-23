import { render } from 'preact';
import type { DeferredObjectivePlanHistoryEntry } from '../../../../contracts/src/deferredObjectivePlanHistory.ts';
import { SMART_TASK_PAST_EMPTY_COPY } from '../../../../shared-domain/src/deadlineLabels.ts';
import { formatMissStreakAggregateLine } from '../../../../shared-domain/src/deferredPlanHistory.ts';
import { groupPlanHistoryByIsoWeek } from '../../../../shared-domain/src/deferredPlanHistoryReceipt.ts';
import { PlanHistoryCard } from './DeadlinePlanHistory.tsx';

export type DeadlinesHistoryListState =
  | { status: 'loading' }
  // `hidden` is kept for callers that explicitly want to suppress the whole
  // section (e.g. transitional renders). `empty` is the user-facing zero-state
  // — same heading shape as `ready`, but a copy line instead of cards.
  | { status: 'hidden' }
  | { status: 'empty' }
  | {
      status: 'ready';
      entries: DeferredObjectivePlanHistoryEntry[];
      timeZone: string;
      // Cost unit suffix for the weekly section roll-ups (e.g. `kr`). Empty
      // / null drops the cost half of the heading; the section break still
      // renders. v2.7.3.
      costUnit?: string;
    };

type MissStreakBadge = { deviceId: string; deviceName: string; line: string };

// Resolves per-device miss-streak badges for the past-tasks subhead. Iterates
// the entries in their existing newest-first order so the first instance of
// each device is the one used to drive the streak window; subsequent entries
// for the same device are skipped to avoid duplicate badges. Per
// `notes/smart-task-ui/README.md`, the badge surfaces the recovering-from-
// mistake user's "pattern at a glance" signal without forcing them to mentally
// aggregate the chip column.
const resolveMissStreakBadges = (
  entries: ReadonlyArray<DeferredObjectivePlanHistoryEntry>,
): MissStreakBadge[] => {
  const seenDevices = new Set<string>();
  const badges: MissStreakBadge[] = [];
  for (const entry of entries) {
    if (seenDevices.has(entry.deviceId)) continue;
    seenDevices.add(entry.deviceId);
    const line = formatMissStreakAggregateLine(entries, entry.deviceId);
    if (line === null) continue;
    badges.push({
      deviceId: entry.deviceId,
      deviceName: entry.deviceName ?? entry.deviceId,
      line,
    });
  }
  return badges;
};

export const DeadlinesHistoryListRoot = ({ state }: { state: DeadlinesHistoryListState }) => {
  if (state.status === 'hidden') return null;
  if (state.status === 'loading') {
    return (
      <section
        class="deadlines-history"
        aria-labelledby="deadlines-history-title"
        aria-busy="true"
      >
        <h3 id="deadlines-history-title" class="deadlines-history__heading">Past tasks</h3>
        <div class="pels-skeleton-stack" aria-hidden="true">
          <span class="pels-skeleton pels-skeleton--card"></span>
          <span class="pels-skeleton pels-skeleton--card"></span>
        </div>
        <span class="visually-hidden">Loading past tasks…</span>
      </section>
    );
  }
  if (state.status === 'empty') {
    return (
      <section class="deadlines-history" aria-labelledby="deadlines-history-title">
        <h3 id="deadlines-history-title" class="deadlines-history__heading">Past tasks</h3>
        <p class="muted">{SMART_TASK_PAST_EMPTY_COPY}</p>
      </section>
    );
  }
  const badges = resolveMissStreakBadges(state.entries);
  // v2.7.3 — ISO-week section breaks. Producer-resolved grouping + heading copy
  // so the view layer never inspects per-week aggregates. The weekly stripe is
  // the emotional anchor for the archive shape; per-row content stays exactly
  // as the existing `PlanHistoryCard` renders it.
  const weekGroups = groupPlanHistoryByIsoWeek(
    state.entries,
    state.timeZone,
    state.costUnit ?? '',
  );
  return (
    <section class="deadlines-history" aria-labelledby="deadlines-history-title">
      <h3 id="deadlines-history-title" class="deadlines-history__heading">Past tasks</h3>
      {badges.length > 0 && (
        <ul class="deadlines-history__miss-streaks" aria-label="Miss streaks">
          {badges.map((badge) => (
            <li key={badge.deviceId} class="deadlines-history__miss-streak">
              <span class="deadlines-history__miss-streak-device">{badge.deviceName}</span>
              {' — '}
              <span class="deadlines-history__miss-streak-count">{badge.line}</span>
            </li>
          ))}
        </ul>
      )}
      {weekGroups.map((group) => (
        <div key={group.weekKey} class="deadlines-history__week-group">
          <h4 class="deadlines-history__week">{group.heading}</h4>
          <div class="plan-history-list">
            {group.entries.map((entry) => (
              <PlanHistoryCard
                key={entry.id}
                entry={entry}
                timeZone={state.timeZone}
              />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
};

export const renderDeadlinesHistoryList = (
  surface: HTMLElement,
  state: DeadlinesHistoryListState,
): void => {
  render(<DeadlinesHistoryListRoot state={state} />, surface);
};
