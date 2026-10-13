import { describe, expect, it } from 'vitest';
import { normalizeCombinedPrices } from '../src/ui/combinedPrices.ts';
import { resolvePriceBreakdown } from '../src/ui/priceBreakdown.ts';
import { resolveLiveSummarySignals } from '../src/ui/livePriceSignals.ts';

// One Norway hour as the runtime stores it (`priceServiceCombined.ts`), in øre.
const NOW = Date.parse('2026-10-13T10:30:00.000Z');
const norwayHour = (extra: Record<string, unknown>) => {
  const parts: Record<string, number> = {
    spotPriceExVat: 40,
    gridTariffExVat: 20,
    providerSurchargeExVat: 2,
    consumptionTaxExVat: 7.13,
    enovaFeeExVat: 1,
    vatMultiplier: 1.25,
    ...extra,
  };
  const relief = typeof parts.norgesprisAdjustment === 'number'
    ? parts.norgesprisAdjustment
    : -parts.electricitySupport;
  const exVat = parts.spotPriceExVat + parts.gridTariffExVat + parts.providerSurchargeExVat
    + parts.consumptionTaxExVat + parts.enovaFeeExVat;
  return { startsAt: '2026-10-13T10:00:00.000Z', total: exVat * 1.25 + relief, ...parts };
};

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

describe('resolvePriceBreakdown', () => {
  it('adds up to the price under Strømstøtte, with the support subtracted', () => {
    const hour = norwayHour({ electricitySupport: 3.5 });
    const [row] = normalizeCombinedPrices({ prices: [hour] });
    const breakdown = resolvePriceBreakdown(row.norwayParts!);

    expect(breakdown.map((part) => part.label)).toEqual(['Spot', 'grid tariff', 'surcharge', 'taxes', 'support']);
    expect(sum(breakdown.map((part) => part.value))).toBeCloseTo(hour.total, 6);
  });

  it('adds up to the price under Norgespris, with the adjustment to the fixed price as its own part', () => {
    const hour = norwayHour({ electricitySupport: 0, norgesprisAdjustment: -12.5 });
    const [row] = normalizeCombinedPrices({ prices: [hour] });
    const breakdown = resolvePriceBreakdown(row.norwayParts!);

    expect(breakdown.slice(0, 2)).toEqual([{ label: 'Spot', value: 50 }, { label: 'Norgespris', value: -12.5 }]);
    expect(breakdown.map((part) => part.label)).not.toContain('support');
    expect(sum(breakdown.map((part) => part.value))).toBeCloseTo(hour.total, 6);
  });

  it('shows the spot price as it is once the Norgespris cap is used up', () => {
    // The monthly cap is used: the hour is billed at spot, with no adjustment.
    const [row] = normalizeCombinedPrices({ prices: [norwayHour({ electricitySupport: 0, norgesprisAdjustment: 0 })] });

    expect(resolvePriceBreakdown(row.norwayParts!).map((part) => part.label)).toEqual(['Spot', 'grid tariff', 'surcharge', 'taxes']);
  });

  it('leaves out a grid tariff the home has none of', () => {
    const [row] = normalizeCombinedPrices({ prices: [norwayHour({ gridTariffExVat: 0, electricitySupport: 0 })] });

    expect(resolvePriceBreakdown(row.norwayParts!).map((part) => part.label)).toEqual(['Spot', 'surcharge', 'taxes']);
  });

  it('carries no parts when a relief field is there but unreadable', () => {
    // Read past, a Norgespris hour would show as Strømstøtte at the full spot price.
    const hour = { ...norwayHour({ electricitySupport: 0 }), norgesprisAdjustment: '-50' };
    const [row] = normalizeCombinedPrices({ prices: [hour] });
    expect(row.norwayParts).toBeUndefined();
  });

  it('shows no parts that do not add up to the price', () => {
    const hour = { ...norwayHour({ electricitySupport: 0 }), total: 30 };
    expect(resolveLiveSummarySignals({ priceScheme: 'norway', prices: [hour] }, NOW).breakdownText).toBeNull();
  });

  it('carries no parts for a row that lacks any of them', () => {
    const [row] = normalizeCombinedPrices({ prices: [{ startsAt: '2026-10-13T10:00:00.000Z', total: 30 }] });
    expect(row.norwayParts).toBeUndefined();
  });
});

describe('resolveLiveSummarySignals, price now', () => {
  it('writes the price and its parts in the card\'s unit', () => {
    const signals = resolveLiveSummarySignals({ priceScheme: 'norway', prices: [norwayHour({ electricitySupport: 3.5 })] }, NOW);

    // Shown rounded, the parts add up to the price shown (0.84): the spot price takes any rounding.
    expect(signals.breakdownText).toBe('Spot 0.50 · grid tariff 0.25 · surcharge 0.03 · taxes 0.10 · support −0.04');
    expect(signals.priceText).toBe('0.84 kr/kWh');
    expect(signals.gridTariffMissing).toBe(false);
  });

  it('says when a Norway price has no grid tariff in it', () => {
    const signals = resolveLiveSummarySignals({
      priceScheme: 'norway', prices: [norwayHour({ gridTariffExVat: 0, electricitySupport: 0 })],
    }, NOW);

    expect(signals.gridTariffMissing).toBe(true);
  });

  it('writes no parts for a source that publishes one price', () => {
    const signals = resolveLiveSummarySignals({
      priceScheme: 'homey', priceUnit: 'EUR', prices: [{ startsAt: '2026-10-13T10:00:00.000Z', total: 0.31 }],
    }, NOW);

    expect(signals.priceText).toBe('0.31 EUR/kWh');
    expect(signals.breakdownText).toBeNull();
  });
});
