import type { MainFuse, PowerLimitSettings } from '../../packages/contracts/src/capacitySettings';
import type { DailyBudgetUiPayload } from '../../packages/contracts/src/dailyBudgetTypes';

/**
 * Whether this home has a limit that only the whole-home meter can enforce:
 * Capacity limit, Grid import limit, main fuse protection or a daily budget.
 *
 * It decides what a meter outage does (owner ruling 2026-11-28). With one of
 * them on, the house may be over it while nothing is measured, so the
 * silent-meter pass limits every managed device. With none on there is
 * nothing a missing reading can breach: price shifting and smart tasks decide
 * without the meter, so the pass leaves devices as they are.
 *
 * `dailyBudget` is the budget service's snapshot; `null` (no budget service, a
 * meter area, or no snapshot computed yet) reads as no daily budget, as it does
 * for every other planner reader of it.
 */
export function hasMeterDependentLimit(
  limits: PowerLimitSettings,
  mainFuse: MainFuse,
  dailyBudget: DailyBudgetUiPayload | null,
): boolean {
  if (limits.capacityEnabled || limits.gridImportLimitKw !== null) return true;
  if (mainFuse.kind === 'on') return true;
  return dailyBudget?.days[dailyBudget.todayKey]?.budget.enabled === true;
}
