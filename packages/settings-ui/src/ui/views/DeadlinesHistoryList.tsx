import { render } from 'preact';
import type { DeferredObjectivePlanHistoryEntry } from '../../../../contracts/src/deferredObjectivePlanHistory.ts';
import { SMART_TASK_PAST_EMPTY_COPY } from '../../../../shared-domain/src/deadlineLabels.ts';
import { formatMissStreakAggregateLine } from '../../../../shared-domain/src/deferredPlanHistory.ts';
import { PlanHistoryCard } from './DeadlinePlanHistory.tsx';

export type DeadlinesHistoryListState =
  | { status: 'loading' }
  // `hidden` is kept for callers that explicitly want to suppress the whole
  // section (e.g. transitional renders). `empty` is the user-facing zero-state
  // — same heading shape as `ready`, but a copy line instead of cards.
  | { status: 'hidden' }
  | { status: 'empty' }
  | { status: 'ready'; entries: DeferredObjectivePlanHistoryEntry[]; timeZone: string };

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

const DeadlinesHistoryListRoot = ({ state }: { state: DeadlinesHistoryListState }) => {
  if (state.status === 'hidden') return null;
  if (state.status === 'loading') {
    return (
      <section class="deadlines-history" aria-labelledby="deadlines-history-title">
        <h3 id="deadlines-history-title" class="deadlines-history__heading">Past tasks</h3>
        <p class="muted">Loading past tasks…</p>
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
      <div class="plan-history-list">
        {state.entries.map((entry) => (
          <PlanHistoryCard
            key={entry.id}
            entry={entry}
            timeZone={state.timeZone}
          />
        ))}
      </div>
    </section>
  );
};

export const renderDeadlinesHistoryList = (
  surface: HTMLElement,
  state: DeadlinesHistoryListState,
): void => {
  render(<DeadlinesHistoryListRoot state={state} />, surface);
};
