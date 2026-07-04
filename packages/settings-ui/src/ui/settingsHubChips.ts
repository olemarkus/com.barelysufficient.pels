// Exception-only state chips on the Settings-hub nav cards. Imperative DOM
// sync over the static hub markup (the hub has no rendering owner — this
// matches the `syncDryRunBannerVisibility` paradigm). The chips live in
// `index.html` as hidden spans; this module only flips `hidden` and never
// invents copy (labels come from `shared-domain/settingsHubChips.ts`).
import {
  SETTINGS_UI_POWER_PATH,
  type SettingsUiPowerPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import { DAILY_BUDGET_ENABLED } from '../../../contracts/src/settingsKeys.ts';
import { isPriceFeedAwaiting } from '../../../shared-domain/src/settingsHubChips.ts';
import { getApiReadModel, getSetting } from './homey.ts';
import { state } from './state.ts';

const setChipHidden = (id: string, hidden: boolean): void => {
  const el = document.getElementById(id);
  if (el) el.hidden = hidden;
};

// The Daily-budget chip shows while the feature is disabled (an unset value
// reads as disabled — the feature is opt-in).
const readBudgetChipHidden = async (): Promise<boolean> => (
  await getSetting(DAILY_BUDGET_ENABLED) === true
);

// Cached power read: every runtime `power_updated` push primes/patches this
// cache with a fresh `status.priceLevel`, and the push handler also re-syncs
// these chips — so the cached value is always at most one push old and the
// chip never issues extra `/ui_power` GETs (the power-read economy the
// settings tests enforce).
const readPricesChipHidden = async (): Promise<boolean> => {
  const payload = await getApiReadModel<SettingsUiPowerPayload>(SETTINGS_UI_POWER_PATH);
  return !isPriceFeedAwaiting(payload?.status?.priceLevel ?? null);
};

// Async chip states resolve first, then commit in one guarded step: the
// sequence is re-checked AFTER the awaits so a stale slow read can never
// flip `hidden` after a fresher sync already committed (checking only before
// the await would leave that window open).
let syncSequence = 0;
export const syncSettingsHubChips = (): void => {
  // Simulation syncs synchronously off `state.dryRun` (already maintained by
  // `loadCapacitySettings` / the save path) — no async window to guard.
  setChipHidden('settings-nav-chip-simulation', state.dryRun !== true);

  syncSequence += 1;
  const sequence = syncSequence;
  void (async () => {
    const [budgetHidden, pricesHidden]: Array<boolean | null> = await Promise.all([
      readBudgetChipHidden().catch((): null => null),
      // A failed power read is not evidence the price feed is broken — keep
      // the chip as it was rather than flashing a false exception.
      readPricesChipHidden().catch((): null => null),
    ]);
    if (sequence !== syncSequence) return;
    if (budgetHidden !== null) setChipHidden('settings-nav-chip-budget', budgetHidden);
    if (pricesHidden !== null) setChipHidden('settings-nav-chip-prices', pricesHidden);
  })();
};
