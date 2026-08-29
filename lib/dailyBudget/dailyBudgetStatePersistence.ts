import type { DailyBudgetStateStore } from './dailyBudgetStateStore';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import type { DailyBudgetState, DailyBudgetStatePersistReason } from './dailyBudgetTypes';

const LOW_PRIORITY_PERSIST_INTERVAL_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const LOW_PRIORITY_REASONS = new Set<DailyBudgetStatePersistReason>(['runtime', 'plan']);

const PERSIST_REASON_PRIORITY: DailyBudgetStatePersistReason[] = [
  'reset',
  'manual',
  'rollover',
  'observed_stats',
  'frozen',
  'bucket',
  'plan',
  'runtime',
];

export function resolveDailyBudgetPersistReason(
  reasons: ReadonlySet<DailyBudgetStatePersistReason>,
): DailyBudgetStatePersistReason | null {
  return PERSIST_REASON_PRIORITY.find((reason) => reasons.has(reason)) ?? null;
}

export function isLowPriorityDailyBudgetPersistReason(reason: DailyBudgetStatePersistReason): boolean {
  return LOW_PRIORITY_REASONS.has(reason);
}

export class DailyBudgetStatePersistencePolicy {
  private lastPersistedStateJson = '';
  private lastPersistMs = 0;

  initialize(state: DailyBudgetState): void {
    this.lastPersistedStateJson = JSON.stringify(state);
  }

  hasPersistedJson(stateJson: string): boolean {
    return stateJson === this.lastPersistedStateJson;
  }

  recordPersisted(params: {
    reason: DailyBudgetStatePersistReason;
    stateJson: string;
    nowMs: number;
  }): void {
    this.lastPersistedStateJson = params.stateJson;
    this.lastPersistMs = params.nowMs;
  }

  /**
   * Pure clock-and-reason check: it reads `reason`, `nowMs` and the last persist
   * time, and nothing about the state itself. That is what lets
   * `maybePersistDailyBudgetState` ask it before building or serializing the state
   * it would otherwise discard.
   *
   * `maybePersistDailyBudgetState` is its only permitted caller. It is public
   * because that caller is a free function rather than a method, not because the
   * throttle is open for general use: a module that branches on it directly —
   * `if (!policy.isThrottled(...))` in the service, say — has moved the write
   * policy out of this file, which is the whole thing this file owns.
   */
  isThrottled(reason: DailyBudgetStatePersistReason, nowMs: number): boolean {
    if (!isLowPriorityDailyBudgetPersistReason(reason)) return false;
    if (this.lastPersistMs === 0) return false;
    if (nowMs - this.lastPersistMs >= LOW_PRIORITY_PERSIST_INTERVAL_MS) return false;
    // Hour boundary bypass: if the UTC wall-clock hour rolled over since
    // the last persist, allow the write through. This caps crash-loss of
    // unflushed `lastUsedNowKWh` accumulation to under one hour. It adds at
    // most ~24 hour-boundary-forced writes per day on top of whatever the
    // 10-minute throttle already allows (which on its own permits up to
    // ~144 low-priority writes per day when samples are frequent).
    return Math.floor(nowMs / HOUR_MS) === Math.floor(this.lastPersistMs / HOUR_MS);
  }
}

type PersistDailyBudgetStateParams = {
  stateStore: DailyBudgetStateStore;
  policy: DailyBudgetStatePersistencePolicy;
  state: DailyBudgetState;
  reason: DailyBudgetStatePersistReason;
  nowMs: number;
};

/** As above, but the state is deferred so a throttled call never builds it. */
type MaybePersistDailyBudgetStateParams =
  Omit<PersistDailyBudgetStateParams, 'state'> & { state: () => DailyBudgetState };

/**
 * Ask the throttle first, then build the state.
 *
 * The throttle rejects the large majority of these calls — 7,636 of 7,781 in one
 * production sample — and it is a pure clock check. Everything the discarded
 * calls used to pay for is now behind it: `state` is a thunk so a throttled call
 * never exports the state, and the ~11.5 KB of JSON that the identity check needs
 * is only produced once the clock has already said a write is allowed.
 *
 * The thunk makes "safe to skip entirely" a requirement on whatever produces the
 * state: `DailyBudgetManager.exportState` is a pure read, so a call that never
 * happens costs nothing and changes nothing.
 *
 * The reordering moves one counter attribution: a low-priority call that is both
 * throttled and unchanged now counts as `skipped_throttle` rather than
 * `skipped_unchanged`. Neither wrote before and neither writes now. Read the two
 * counters as "the clock refused" and "the clock allowed it, but nothing had
 * changed" — deciding between them for the overlap is exactly the serialization
 * this function exists to avoid.
 */
export function maybePersistDailyBudgetState(params: MaybePersistDailyBudgetStateParams): void {
  if (params.policy.isThrottled(params.reason, params.nowMs)) {
    incPerfCounter('settings_set.daily_budget_state_skipped_throttle_total');
    return;
  }
  persistDailyBudgetState({ ...params, state: params.state() });
}

export function persistDailyBudgetState(params: PersistDailyBudgetStateParams): void {
  const stateJson = JSON.stringify(params.state);
  if (params.policy.hasPersistedJson(stateJson)) {
    incPerfCounter('settings_set.daily_budget_state_skipped_unchanged_total');
    return;
  }
  const persistStart = Date.now();
  params.stateStore.write(params.state);
  params.policy.recordPersisted({ reason: params.reason, stateJson, nowMs: params.nowMs });
  incPerfCounter('settings_set.daily_budget_state');
  incPerfCounter(`settings_set.daily_budget_state_reason.${params.reason}_total`);
  incPerfCounter('daily_budget_persist_total');
  addPerfDuration('daily_budget_persist_ms', Date.now() - persistStart);
}
