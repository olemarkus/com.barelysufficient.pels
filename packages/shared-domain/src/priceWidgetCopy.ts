// Canonical user-facing copy for the "Electricity price" dashboard widget
// (widgets/price). Lives in shared-domain so the widget payload builder (which
// runs in the app process) and the browser renderer use one source of truth,
// and so log breadcrumbs can quote identical wording.
//
// Imported DIRECTLY by file path (no barrel/index).

import { priceRateLabelToAmountUnit } from './price/priceUnitLabel';
import { resolvePriceLevelChip } from './priceLevelChips';

export const PRICE_WIDGET_TITLE = 'Electricity price';

export const PRICE_WIDGET_EMPTY = {
  noPrices: 'No prices yet',
  noPricesSubtitle: 'PELS shows prices once your price source has delivered them.',
  readFailed: 'Prices unavailable',
  readFailedSubtitle: 'PELS could not read prices just now and tries again in a minute.',
  noCurrentPrice: 'No price for right now',
  noCurrentPriceSubtitle: 'Your price source has not delivered a price for the current period yet.',
  noExport: 'No export price set up',
  noExportSubtitle: 'Set up an export price in PELS under Electricity prices.',
  noCurrentExport: 'No export price for right now',
  noCurrentExportSubtitle: 'Your export price does not cover the current period.',
  loadError: 'Could not load. Reopen the dashboard.',
} as const;

// Level words come from the canonical chip pair (`priceLevelChips.ts`), never
// the bare "Cheap" / "Expensive"; `Price normal` is the strip-legend word for
// the level the chip never shows.
const chipLabel = (level: 'cheap' | 'expensive'): string => resolvePriceLevelChip(level)?.label ?? '';

export const PRICE_WIDGET_LEVEL_LABEL = {
  cheap: chipLabel('cheap'),
  normal: 'Price normal',
  expensive: chipLabel('expensive'),
} as const;

/** The screen-reader phrase, in the canonical `Price: low` form. */
export const formatPriceWidgetLevelAria = (level: 'cheap' | 'normal' | 'expensive'): string => (
  `Price: ${PRICE_WIDGET_LEVEL_LABEL[level].replace(/^Price\s+/u, '')}`
);

export const PRICE_WIDGET_LEGEND = {
  import: 'Import',
  export: 'Export',
} as const;

export const PRICE_WIDGET_DAY_TOMORROW = 'Tomorrow';

export const PRICE_WIDGET_TOMORROW_PENDING = "The lines can move when tomorrow's prices arrive.";

export const PRICE_WIDGET_EXPORT_SUBLINE = 'Per kWh you export. Below zero, you pay to export.';

const PLACEHOLDER_UNIT = 'price units';
const NORWAY_RATE_UNIT = 'øre/kWh';

/**
 * The money unit a single price is written with, from the runtime's per-kWh
 * rate label: `øre/kWh` → `øre`, `EUR` → `EUR`. Empty for the unit-less
 * placeholder, so a price reads as a bare number rather than "0.41 price units".
 */
export const resolvePriceWidgetAmountUnit = (priceUnit: string): string => {
  const trimmed = priceUnit.trim();
  if (trimmed === '' || trimmed === PLACEHOLDER_UNIT) return '';
  return priceRateLabelToAmountUnit(trimmed);
};

/** The per-kWh axis label: `øre/kWh`, `EUR/kWh`, or empty without a unit. */
export const resolvePriceWidgetAxisUnit = (priceUnit: string): string => {
  const amountUnit = resolvePriceWidgetAmountUnit(priceUnit);
  if (amountUnit === '') return '';
  return priceUnit.trim() === NORWAY_RATE_UNIT ? NORWAY_RATE_UNIT : `${amountUnit}/kWh`;
};

/**
 * Decimals for a price: two from 1 up (40.27 øre), three below it (0.406 EUR),
 * one from 100 up. Fine enough that a price close to a line does not print as
 * the line itself while the level says otherwise.
 */
const priceDecimals = (value: number): number => {
  const magnitude = Math.abs(value);
  if (magnitude >= 100) return 1;
  if (magnitude >= 1) return 2;
  return 3;
};

const withUnit = (text: string, amountUnit: string): string => (amountUnit === '' ? text : `${text} ${amountUnit}`);

export const formatPriceWidgetPrice = (value: number, amountUnit: string): string => (
  withUnit(value.toFixed(priceDecimals(value)), amountUnit)
);

/** The facts behind the subline: the lines, and what the series reaches. */
export type PriceWidgetSublineFacts = {
  average: number;
  cheapAtOrBelow: number;
  expensiveFrom: number;
  lowest: number;
  highest: number;
  hasCheap: boolean;
  hasExpensive: boolean;
  amountUnit: string;
};

/**
 * The subline under the current price. It always says where the lines are,
 * and when a level never occurs it says how far the series stays from that
 * line, so a chart without shading reads as a choice rather than a gap: PELS
 * does not trade comfort for a difference of a few cents.
 */
export const formatPriceWidgetSubline = (facts: PriceWidgetSublineFacts): string => {
  const price = (value: number): string => formatPriceWidgetPrice(value, facts.amountUnit);
  if (!facts.hasCheap && !facts.hasExpensive) {
    return `Prices stay close to the average of ${price(facts.average)}, so none count as low or high`;
  }
  const highLine = `High from ${price(facts.expensiveFrom)}`;
  const lowLine = `low up to ${price(facts.cheapAtOrBelow)}`;
  const high = facts.hasExpensive ? highLine : `${highLine}, highest ${price(facts.highest)}`;
  const low = facts.hasCheap ? lowLine : `${lowLine}, lowest ${price(facts.lowest)}`;
  return `${high} · ${low}`;
};
