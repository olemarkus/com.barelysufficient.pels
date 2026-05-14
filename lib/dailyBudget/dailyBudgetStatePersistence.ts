import type Homey from 'homey';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import { DAILY_BUDGET_STATE } from '../utils/settingsKeys';
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

  shouldPersist(params: {
    reason: DailyBudgetStatePersistReason;
    stateJson: string;
    nowMs: number;
  }): 'persist' | 'unchanged' | 'throttled' {
    const { reason, stateJson, nowMs } = params;
    if (this.hasPersistedJson(stateJson)) return 'unchanged';
    if (this.shouldThrottle(reason, nowMs)) return 'throttled';
    return 'persist';
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

  private shouldThrottle(reason: DailyBudgetStatePersistReason, nowMs: number): boolean {
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
  settings: Homey.App['homey']['settings'];
  policy: DailyBudgetStatePersistencePolicy;
  state: DailyBudgetState;
  reason: DailyBudgetStatePersistReason;
  nowMs: number;
};

export function maybePersistDailyBudgetState(params: PersistDailyBudgetStateParams): void {
  const stateJson = JSON.stringify(params.state);
  const decision = params.policy.shouldPersist({ reason: params.reason, stateJson, nowMs: params.nowMs });
  if (decision === 'unchanged') {
    incPerfCounter('settings_set.daily_budget_state_skipped_unchanged_total');
    return;
  }
  if (decision === 'throttled') {
    incPerfCounter('settings_set.daily_budget_state_skipped_throttle_total');
    return;
  }
  persistDailyBudgetState({ ...params, stateJson });
}

export function persistDailyBudgetState(
  params: PersistDailyBudgetStateParams & { stateJson?: string },
): void {
  const stateJson = params.stateJson ?? JSON.stringify(params.state);
  if (params.policy.hasPersistedJson(stateJson)) {
    incPerfCounter('settings_set.daily_budget_state_skipped_unchanged_total');
    return;
  }
  const persistStart = Date.now();
  params.settings.set(DAILY_BUDGET_STATE, params.state);
  params.policy.recordPersisted({ reason: params.reason, stateJson, nowMs: params.nowMs });
  incPerfCounter('settings_set.daily_budget_state');
  incPerfCounter(`settings_set.daily_budget_state_reason.${params.reason}_total`);
  incPerfCounter('daily_budget_persist_total');
  addPerfDuration('daily_budget_persist_ms', Date.now() - persistStart);
}
