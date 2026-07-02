// "Right now" card live signals for the Electricity prices view, all derived
// from the combined-prices read-model:
//   - `lastFetchedShort` — the pre-formatted short clock time of the last fetch.
//   - `exportText` — the current-hour export (feed-in) price, scaled through the
//     CostDisplay divisor (what the home is paid, or pays, for exported power).
//   - `planningReasonLine` — the registered `using your solar` reason line
//     attached to the "Current price" level (which tiers on the planning price
//     post-#1808) when it diverges from the import price.
//
// Kept out of `priceConfig.ts` so that orchestrator stays under its line
// ceiling, and so every "Right now" derivation from the combined-prices payload
// lives in one place. The export/planning fields are null when no row covers
// this hour, when export pricing is off, or when the planning price equals
// import — so a non-prosumer's card never gains a row (byte-identical outside a
// solar home).

import {
  PLANNING_PRICE_REASON_LINE,
  planningPriceDivergesFromImport,
} from '../../../shared-domain/src/price/planningPrice.ts';
import { normalizeCombinedPrices } from './combinedPrices.ts';
import { formatScaledPriceValue, resolveCostDisplayFromCombinedPrices } from './priceUnit.ts';

const ONE_HOUR_MS = 60 * 60 * 1000;

export type LiveSummarySignals = {
  lastFetchedShort: string | null;
  exportText: string | null;
  planningReasonLine: string | null;
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
  const rows = normalizeCombinedPrices(combinedPrices);
  const current = rows.find((row) => {
    const startsAtMs = new Date(row.startsAt).getTime();
    return Number.isFinite(startsAtMs) && startsAtMs <= nowMs && nowMs < startsAtMs + ONE_HOUR_MS;
  });
  if (!current) return { lastFetchedShort, exportText: null, planningReasonLine: null };
  const costDisplay = resolveCostDisplayFromCombinedPrices(combinedPrices);
  return {
    lastFetchedShort,
    // Finite-gate before scaling so a NaN/Infinity never renders as "NaN kr/kWh".
    // `normalizeCombinedPrices` already finite-gates `exportPrice`, so this is a
    // defensive consumer-side assertion (`Number.isFinite` global — no `lib/**`).
    exportText: Number.isFinite(current.exportPrice)
      ? formatScaledPriceValue(current.exportPrice as number, costDisplay)
      : null,
    planningReasonLine: planningPriceDivergesFromImport(current.budgetPrice, current.total, costDisplay.divisor)
      ? PLANNING_PRICE_REASON_LINE
      : null,
  };
};
