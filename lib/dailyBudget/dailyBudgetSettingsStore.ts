import type { DailyBudgetSettings } from './dailyBudgetTypes';

/**
 * Domain-owned read/write boundary for the daily-budget *configuration* keys
 * (enabled, budget kWh, price-shaping toggle, controlled-usage weight, flex
 * share). Consumers depend on this type, never on `homey.settings` — the
 * interface does not expose the SDK, so the service cannot read or normalise
 * the persisted scalars itself.
 *
 * `read` returns a fully-normalised `DailyBudgetSettings` (the adapter snaps
 * out-of-range/garbage persisted values to canonical defaults); `write`
 * persists a typed settings object. The daily-budget *state* (the day's plan
 * and the learned profiles) lives in the userdata store behind
 * `dailyBudgetStateStore.ts` and is not owned here.
 */
export type DailyBudgetSettingsStore = {
  read(): DailyBudgetSettings;
  write(settings: DailyBudgetSettings): void;
};
