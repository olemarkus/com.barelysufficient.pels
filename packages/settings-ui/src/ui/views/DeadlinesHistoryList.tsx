import { render } from 'preact';
import type { DeferredObjectivePlanHistoryEntry } from '../../../../contracts/src/deferredObjectivePlanHistory.ts';
import { SMART_TASK_PAST_EMPTY_COPY } from '../../../../shared-domain/src/deadlineLabels.ts';
import { PlanHistoryCard } from './DeadlinePlanHistory.tsx';

export type DeadlinesHistoryListState =
  | { status: 'loading' }
  // `hidden` is kept for callers that explicitly want to suppress the whole
  // section (e.g. transitional renders). `empty` is the user-facing zero-state
  // — same heading shape as `ready`, but a copy line instead of cards.
  | { status: 'hidden' }
  | { status: 'empty' }
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
  if (state.status === 'empty') {
    return (
      <section class="deadlines-history" aria-labelledby="deadlines-history-title">
        <h3 id="deadlines-history-title" class="deadlines-history__heading">Past tasks</h3>
        <p class="muted">{SMART_TASK_PAST_EMPTY_COPY}</p>
      </section>
    );
  }
  return (
    <section class="deadlines-history" aria-labelledby="deadlines-history-title">
      <h3 id="deadlines-history-title" class="deadlines-history__heading">Past tasks</h3>
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
