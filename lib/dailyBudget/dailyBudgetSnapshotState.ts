import { shiftDateKey } from '../utils/dateUtils';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from './dailyBudgetTypes';

// Hot-path snapshot composition. `updateState` runs on every power sample
// (~10s in homey_energy mode) and only recomputes today; without this helper
// the previous behavior wiped any cached tomorrow/yesterday previews on every
// call. Preserves cached adjacent-day entries iff their date keys are still
// chronologically adjacent to the new todayKey, otherwise drops them so a day
// rollover cannot leak stale future days.
export const composeHotPathDailyBudgetSnapshot = (
  newToday: DailyBudgetDayPayload,
  previous: DailyBudgetUiPayload | null,
): { daySnapshots: Record<string, DailyBudgetDayPayload>; snapshot: DailyBudgetUiPayload } => {
  const todayKey = newToday.dateKey;
  const tomorrowKey = shiftDateKey(todayKey, 1);
  const yesterdayKey = shiftDateKey(todayKey, -1);
  const preservedTomorrow = preserveAdjacentDay(previous, 'tomorrowKey', tomorrowKey);
  const preservedYesterday = preserveAdjacentDay(previous, 'yesterdayKey', yesterdayKey);
  const daySnapshots: Record<string, DailyBudgetDayPayload> = {
    [todayKey]: newToday,
    ...(preservedTomorrow ? { [tomorrowKey]: preservedTomorrow } : {}),
    ...(preservedYesterday ? { [yesterdayKey]: preservedYesterday } : {}),
  };
  return {
    daySnapshots,
    snapshot: {
      days: { ...daySnapshots },
      todayKey,
      tomorrowKey: preservedTomorrow ? tomorrowKey : null,
      yesterdayKey: preservedYesterday ? yesterdayKey : null,
    },
  };
};

const preserveAdjacentDay = (
  previous: DailyBudgetUiPayload | null,
  side: 'tomorrowKey' | 'yesterdayKey',
  expectedKey: string,
): DailyBudgetDayPayload | null => (
  previous?.[side] === expectedKey ? previous.days[expectedKey] ?? null : null
);
