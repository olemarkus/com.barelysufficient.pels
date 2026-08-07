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
// Only the Simulation chip's label is dynamic, so only its strings live here
// (a runtime log can then quote the exact chip a user saw). The Daily-budget
// and Electricity-prices chips carry fixed text in the hub markup
// (`settings-ui/public/index.html`) and the sync module only flips `hidden`.
import { resolvePriceLevelChip } from './priceLevelChips';
import type { SimulationPosture } from './simulationPosture';

export const SETTINGS_HUB_SIMULATION_ON_CHIP = 'On';
/**
 * Mixed posture (multi-home): the aggregate is honestly neither absolute —
 * only some homes are simulating (Main on with a live meter area, or Main
 * live while an area still simulates), or an area's flag never resolved this
 * session so neither absolute can be vouched for. A bare `On` would overclaim
 * and silence would underclaim; the non-absolute state gets its own short
 * word (chip rules: chips stay short, the pages carry the detail).
 */
export const SETTINGS_HUB_SIMULATION_PARTLY_ON_CHIP = 'Partly on';

// The price feed counts as broken when the current price level is neither a
// chip-worthy exception (cheap/expensive) nor an explicit `normal` — i.e. the
// same `!hasUsablePriceLevel` condition the Electricity-prices panel renders
// its `Awaiting prices` value for.
export const isPriceFeedAwaiting = (priceLevel: string | null | undefined): boolean => (
  resolvePriceLevelChip(priceLevel ?? null) === null && priceLevel !== 'normal'
);

/**
 * The Simulation-mode nav card's exception chip for an aggregate posture
 * (`resolveSimulationPosture` in `simulationPosture.ts`): silent while
 * everything PELS controls is live, `On` while everything simulates, and the
 * split state names itself instead of borrowing either absolute.
 */
export const resolveSimulationChipLabel = (posture: SimulationPosture): string | null => {
  if (posture === 'all_live') return null;
  return posture === 'all_simulating'
    ? SETTINGS_HUB_SIMULATION_ON_CHIP
    : SETTINGS_HUB_SIMULATION_PARTLY_ON_CHIP;
};
