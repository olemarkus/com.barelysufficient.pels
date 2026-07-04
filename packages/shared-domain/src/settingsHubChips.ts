// Settings-hub nav-card exception chips (2026-07 coherence train, PR-5).
//
// The Orchestrator scanning the Settings hub wants "what's non-default /
// what's broken" at a glance. Three cards carry an exception-only chip —
// normal state stays silent per the chip rules (`notes/ui-terminology.md`):
//
//   Simulation mode    → `On` (warn)  while simulation is active
//   Daily budget       → `Off` (muted) while the feature is disabled
//   Electricity prices → `Awaiting prices` (warn) while no price covers now
//
// Strings live here so a runtime log can quote the exact chip a user saw.
import { resolvePriceLevelChip } from './priceLevelChips';

export const SETTINGS_HUB_SIMULATION_ON_CHIP = 'On';
export const SETTINGS_HUB_BUDGET_OFF_CHIP = 'Off';
// The Electricity-prices panel's own no-usable-price wording (its "Right now"
// tier renders `Awaiting prices` in exactly this state) — the chip reuses it
// so the hub teaser and the panel tell one story.
export const SETTINGS_HUB_PRICES_AWAITING_CHIP = 'Awaiting prices';

// The price feed counts as broken when the current price level is neither a
// chip-worthy exception (cheap/expensive) nor an explicit `normal` — i.e. the
// same `!hasUsablePriceLevel` condition the Electricity-prices panel renders
// its `Awaiting prices` value for.
export const isPriceFeedAwaiting = (priceLevel: string | null | undefined): boolean => (
  resolvePriceLevelChip(priceLevel ?? null) === null && priceLevel !== 'normal'
);
