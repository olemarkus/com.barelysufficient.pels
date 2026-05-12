import { render } from 'preact';
import type { DeferredObjectivePlanHistoryEntry } from '../../../../contracts/src/deferredObjectivePlanHistory.ts';
import { PlanHistoryCard } from './DeadlinePlanHistory.tsx';

export type DeadlinesHistoryListState =
  | { status: 'loading' }
  | { status: 'hidden' }
  | { status: 'ready'; entries: DeferredObjectivePlanHistoryEntry[]; timeZone: string };

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
  return (
    <section class="deadlines-history" aria-labelledby="deadlines-history-title">
      <h3 id="deadlines-history-title" class="deadlines-history__heading">Past tasks</h3>
      <div class="plan-history-list">
        {state.entries.map((entry) => (
          <PlanHistoryCard
            key={`${entry.deviceId}-${entry.deadlineAtMs}-${entry.finalizedAtMs}`}
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
