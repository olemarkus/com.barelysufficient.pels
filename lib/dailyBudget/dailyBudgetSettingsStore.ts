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
 * persists a typed settings object. The daily-budget *state* blob
 * (`DAILY_BUDGET_STATE`) is a separate seam and not owned here.
 */
export type DailyBudgetSettingsStore = {
  read(): DailyBudgetSettings;
  write(settings: DailyBudgetSettings): void;
};
