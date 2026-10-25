import { applyBudgetPrices, type BudgetPriceInputs } from './budgetPrice';
import { applyExportPrices, type ExportPriceConfig } from './exportPrice';
import type { CombinedPriceFields } from './priceTypes';

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
