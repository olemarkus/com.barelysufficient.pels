import type { SettingsUiTaskPricePeriod } from '../../../contracts/src/settingsUi/prices.ts';
import { normalizeCombinedPrices } from '../../src/ui/combinedPrices.ts';

// Existing scenarios seed hourly combined prices; mirror the runtime's separate
// presentation port without making the UI infer a native grid from that payload.
export const taskPricePeriodsFixture = (raw: unknown): SettingsUiTaskPricePeriod[] => (
  normalizeCombinedPrices(raw).map((period) => ({
    startsAtMs: Date.parse(period.startsAt),
    endsAtMs: Date.parse(period.startsAt) + 60 * 60 * 1000,
    price: period.total,
    planningPrice: period.budgetPrice ?? period.total,
    isCheap: period.isCheap === true,
    isExpensive: period.isExpensive === true,
  }))
);
