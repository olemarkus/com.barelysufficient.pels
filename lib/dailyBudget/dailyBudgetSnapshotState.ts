import { shiftDateKey } from '../utils/dateUtils';
import type { CombinedPriceData } from './dailyBudgetPrices';
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

// Hot-path debounce key for the adjacent-days re-seed. Cheap to compute and
// changes whenever the underlying `combined_prices` horizon shifts (entry
// count changes or the first/last `startsAt` moves). Excludes `lastFetched`
// because `PriceService.updateCombinedPrices` may bump the timestamp on a
// no-op refresh — including it would trigger a rebuild on every price tick
// even when the horizon hasn't changed. Including the date key also forces
// a re-seed on date rollover.
export const computeAdjacentDaysSeedSignature = (
  todayKey: string,
  combinedPrices: CombinedPriceData | null,
): string => {
  const entries = Array.isArray(combinedPrices?.prices) ? combinedPrices.prices : [];
  const first = entries[0]?.startsAt ?? '';
  const last = entries[entries.length - 1]?.startsAt ?? '';
  return `${todayKey}|${entries.length}|${first}|${last}`;
};
