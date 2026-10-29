import { applyBudgetPrices, type BudgetPriceInputs } from './budgetPrice';
import { applyExportPrices, type ExportPriceConfig } from './exportPrice';
import type { CombinedPriceFields, CombinedPricePeriod } from './priceTypes';

/** Export decisions use feed-in value alone, before solar planning adjustments. */
export const isExportCostlyAt = (
  series: CombinedPricePeriod[],
  exportConfig: ExportPriceConfig,
  nowMs: number,
): boolean => applyExportPrices(series, exportConfig).some((period) => {
  const start = Date.parse(period.startsAt);
  return start <= nowMs && nowMs < start + period.durationMinutes * 60_000
    && typeof period.exportPrice === 'number' && Number.isFinite(period.exportPrice) && period.exportPrice < 0;
});

/** Both native and hourly planning series derive solar value after export pricing. */
export const applyPlanningPriceDecorations = <T extends CombinedPriceFields>(
  series: T[],
  exportConfig: ExportPriceConfig,
  budgetInputs: BudgetPriceInputs | undefined,
  timeZone: string,
): T[] => applyBudgetPrices(
  applyExportPrices(series, exportConfig),
  budgetInputs,
  timeZone,
);
