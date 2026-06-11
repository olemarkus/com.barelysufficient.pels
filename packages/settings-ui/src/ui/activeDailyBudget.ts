// Active daily-budget kWh, producer-resolved for chart overlays.
//
// The Usage tab's daily-history chart (mark line + readout budget context)
// must show the SAME budget number as the Budget tab's hero. The hero renders
// `payload.days[todayKey].budget.dailyBudgetKWh` from the runtime's
// `DailyBudgetUiPayload` — the model's actual stored budget. The
// budget-adjust draft is NOT a valid source here: `clampKWh` clamps the
// stored value into the slider range on read, so a stored 12 kWh would render
// as a 20 kWh mark line while the hero says 12.0.
//
// `dailyBudget.ts` (the payload's single render path) pushes the resolved
// value here on every payload refresh; consumers read one flat
// `number | null` and never touch the payload shape (producer-resolves rule).
// This module stays import-light on purpose so `power.ts` does not pull the
// Budget page's render stack.
import type { DailyBudgetUiPayload } from '../../../contracts/src/dailyBudgetTypes.ts';

let activeDailyBudgetKWh: number | null = null;
let changeListener: (() => void) | null = null;

// Single-listener seam (same idiom as `setBudgetAdjustRefresh`): the Usage
// tab's daily-history render registers here so a budget edit made while that
// tab is visible repaints the mark line/readout immediately instead of
// waiting for the next stats refresh. Kept as a callback slot so this module
// stays import-light (see header comment).
export const setActiveDailyBudgetChangeListener = (listener: () => void): void => {
  changeListener = listener;
};

// Resolve the payload to the flat overlay value: today's configured budget
// when the feature is enabled and the value is a positive finite number,
// otherwise null (callers suppress the overlay/context line on null).
export const resolveActiveDailyBudgetKWh = (
  payload: DailyBudgetUiPayload | null,
): number | null => {
  const today = payload?.days[payload.todayKey];
  if (!today?.budget.enabled) return null;
  const value = today.budget.dailyBudgetKWh;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
};

export const setActiveDailyBudgetFromPayload = (payload: DailyBudgetUiPayload | null): void => {
  const next = resolveActiveDailyBudgetKWh(payload);
  const changed = next !== activeDailyBudgetKWh;
  activeDailyBudgetKWh = next;
  if (changed) changeListener?.();
};

export const getActiveDailyBudgetKWh = (): number | null => activeDailyBudgetKWh;
