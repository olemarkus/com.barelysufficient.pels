// "Right now" card live signals for the Electricity prices view, all derived
// from the combined-prices read-model:
//   - `lastFetchedShort` — the pre-formatted short clock time of the last fetch.
//   - `exportText` — the current-hour export (feed-in) price, scaled through the
//     CostDisplay divisor (what the home is paid, or pays, for exported power).
//   - `priceText` — the import price now, and `breakdownText` the parts the
//     Norway source adds up into it (`Spot 0.27 · grid tariff 0.20 · taxes 0.10`).
//
// Kept out of `priceConfig.ts` so that orchestrator stays under its line
// ceiling, and so every "Right now" derivation from the combined-prices payload
// lives in one place. The export field is null when no row covers this hour or
// when export pricing is off — so a non-prosumer's card never gains a row
// (byte-identical outside a solar home). The price level itself classifies the
// import price, so no solar note explains it.

import { findCurrentPriceRow, normalizeCombinedPrices, type CombinedPriceRow } from './combinedPrices.ts';
import {
  formatScaledPriceNumber,
  formatScaledPriceValue,
  resolveCostDisplayFromCombinedPrices,
} from './priceUnit.ts';
import { resolvePriceBreakdown } from './priceBreakdown.ts';
import type { CostDisplay } from './dailyBudgetCost.ts';

export type LiveSummarySignals = {
  lastFetchedShort: string | null;
  exportText: string | null;
  priceText: string | null;
  breakdownText: string | null;
  /** A Norway price without a grid tariff in it: no company chosen, or its tariff not fetched yet. */
  gridTariffMissing: boolean;
};

const roundToCents = (value: number): number => Math.round(value * 100) / 100;

// Each part is shown rounded, and the spot price takes up the rounding, so the
// parts always add up to the price shown above them. A negative part gets a
// real minus sign, which reads as one.
const formatBreakdownText = (row: CombinedPriceRow, costDisplay: CostDisplay): string | null => {
  if (!row.norwayParts) return null;
  const breakdown = resolvePriceBreakdown(row.norwayParts);
  // Parts that do not add up to the price are not its parts: show none.
  if (Math.abs(breakdown.reduce((sum, part) => sum + part.value, 0) - row.total) > 0.01) return null;
  const divisor = Math.max(1, costDisplay.divisor);
  const [spot, ...rest] = breakdown.map((part) => ({ ...part, value: roundToCents(part.value / divisor) }));
  const restTotal = rest.reduce((sum, part) => sum + part.value, 0);
  const parts = [{ ...spot, value: roundToCents(row.total / divisor) - restTotal }, ...rest];
  return parts
    .map((part) => `${part.label} ${formatScaledPriceNumber(part.value, { ...costDisplay, divisor: 1 })}`)
    .map((text) => text.replace(/ -/u, ' −'))
    .join(' · ');
};

// Narrow the unknown `combinedPrices` read-model to its `lastFetched` field and
// format it as a short local clock time. Returns null when missing/unparseable
// so the card shows the neutral dash.
const resolveLastFetchedShort = (combinedPrices: unknown): string | null => {
  if (!combinedPrices || typeof combinedPrices !== 'object') return null;
  const raw = (combinedPrices as { lastFetched?: unknown }).lastFetched;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const ms = new Date(raw).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
};

export const resolveLiveSummarySignals = (
  combinedPrices: unknown,
  nowMs: number,
): LiveSummarySignals => {
  const lastFetchedShort = resolveLastFetchedShort(combinedPrices);
  const current = findCurrentPriceRow(normalizeCombinedPrices(combinedPrices), nowMs);
  if (!current) {
    return { lastFetchedShort, exportText: null, priceText: null, breakdownText: null, gridTariffMissing: false };
  }
  const costDisplay = resolveCostDisplayFromCombinedPrices(combinedPrices);
  return {
    lastFetchedShort,
    // Finite-gate before scaling so a NaN/Infinity never renders as "NaN kr/kWh".
    // `normalizeCombinedPrices` already finite-gates `exportPrice`, so this is a
    // defensive consumer-side assertion (`Number.isFinite` global — no `lib/**`).
    exportText: Number.isFinite(current.exportPrice)
      ? formatScaledPriceValue(current.exportPrice as number, costDisplay)
      : null,
    priceText: formatScaledPriceValue(current.total, costDisplay),
    breakdownText: formatBreakdownText(current, costDisplay),
    gridTariffMissing: current.norwayParts?.gridTariffExVat === 0,
  };
};
