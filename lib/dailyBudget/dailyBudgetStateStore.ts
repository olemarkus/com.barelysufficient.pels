import type { DailyBudgetState } from './dailyBudgetTypes';

/**
 * Domain-owned read/write boundary for the persisted daily-budget *state* blob
 * (`DAILY_BUDGET_STATE`) — the companion to {@link DailyBudgetSettingsStore},
 * which owns the *config* keys. The settings-store doc deliberately carves this
 * state seam out as a separate owner; this is it.
 *
 * `read` returns the raw persisted value (the manager normalizes/validates it on
 * load); `write` persists the manager's exported, typed `DailyBudgetState`.
 * Consumers depend on this interface, never on `homey.settings`.
 */
export type DailyBudgetStateStore = {
  read(): unknown;
  write(state: DailyBudgetState): void;
};
