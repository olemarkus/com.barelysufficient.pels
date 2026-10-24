// Current prices use native periods. Hourly projections supply Norway's
// itemized breakdown and the fetch timestamp, never a quarter-hour price.

import type { PriceTimelineRead } from '../../../contracts/src/priceTimeline.ts';
import { findCurrentPriceRow, normalizeCombinedPrices, type CombinedPriceRow } from './combinedPrices.ts';
import {
  formatScaledPriceNumber,
  formatScaledPriceValue,
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
  timeline: PriceTimelineRead,
  nowMs: number,
): LiveSummarySignals => {
  const lastFetchedShort = resolveLastFetchedShort(combinedPrices);
  const period = timeline.state === 'ready' ? timeline.periods.find((candidate) => {
    const start = Date.parse(candidate.startsAt);
    return start <= nowMs && nowMs < start + candidate.durationMinutes * 60_000;
  }) : undefined;
  if (!period || timeline.state !== 'ready') {
    return { lastFetchedShort, exportText: null, priceText: null, breakdownText: null, gridTariffMissing: false };
  }
  const costDisplay: CostDisplay = timeline.priceUnit === 'øre/kWh'
    ? { unit: 'kr', divisor: 100 }
    : { unit: timeline.priceUnit === 'price units' ? '' : timeline.priceUnit, divisor: 1 };
  const current = findCurrentPriceRow(normalizeCombinedPrices(combinedPrices), nowMs);
  return {
    lastFetchedShort,
    exportText: period.exportPrice !== undefined ? formatScaledPriceValue(period.exportPrice, costDisplay) : null,
    priceText: formatScaledPriceValue(period.importPrice, costDisplay),
    breakdownText: current && Math.abs(current.total - period.importPrice) < 0.01
      ? formatBreakdownText(current, costDisplay) : null,
    gridTariffMissing: current?.norwayParts?.gridTariffExVat === 0,
  };
};
