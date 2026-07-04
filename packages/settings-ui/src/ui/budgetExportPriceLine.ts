// "Export price now" hero subline resolver. Split out of
// `budgetRedesignResolvers.ts` (its only caller is `budgetRedesign.ts`, which
// resolves the line once per render pass and hands the finished string into
// `resolveHeroData`) so the resolvers module stays under the max-lines cap
// without trimming load-bearing comments.
import type { CombinedPriceRow } from './combinedPrices.ts';
import type { CostDisplay } from './dailyBudgetCost.ts';
import { composeExportPriceNow } from '../../../shared-domain/src/dailyBudgetHeroStrings.ts';
import { formatScaledPriceValue } from './priceUnit.ts';

const ONE_HOUR_MS = 3_600_000;

// "Export price now" hero subline — the current hour's export (feed-in)
// price, or null when no export price covers the hour (absence renders
// nothing; non-prosumers never see an empty placeholder). The value is scaled
// through the SAME CostDisplay {unit, divisor} the hero's other money figures
// use (øre → kr ÷ 100) so a raw øre value is never rendered as kr; signed
// values pass through unclamped (negative = the home pays to export).
export const resolveExportPriceNowLine = (
  rows: CombinedPriceRow[],
  nowMs: number,
  costDisplay: CostDisplay,
): string | null => {
  const current = rows.find((row) => {
    if (typeof row.exportPrice !== 'number') return false;
    const startsAtMs = new Date(row.startsAt).getTime();
    return Number.isFinite(startsAtMs) && startsAtMs <= nowMs && nowMs < startsAtMs + ONE_HOUR_MS;
  });
  if (!current || typeof current.exportPrice !== 'number') return null;
  // Value scaling (øre → kr ÷ divisor, signed, sub-half-cent snap, unit grammar
  // `0.84 kr/kWh`) is shared with the Electricity-prices "Right now" export row.
  return composeExportPriceNow(formatScaledPriceValue(current.exportPrice, costDisplay));
};

