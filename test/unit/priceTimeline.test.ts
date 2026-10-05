// The price widget's runtime series: levels from the live classifier, the
// lines that decided them, and whether an export price exists — judged from the
// periods, so Homey's own export terms (which leave PELS's export model off)
// still count.
import { describe, expect, it } from 'vitest';
import { buildPriceTimeline } from '../../lib/price/priceTimeline';
import { EXPORT_PRICE_DISABLED } from '../../lib/price/exportPrice';
import type { CombinedPricePeriod } from '../../lib/price/priceTypes';

const BASE_MS = Date.parse('2026-06-01T00:00:00Z');
const HOUR_MS = 60 * 60 * 1000;
const BAND = { thresholdPercent: 25, minDiff: 0 };

const period = (hour: number, totalPrice: number, exportPrice?: number): CombinedPricePeriod => ({
  startsAt: new Date(BASE_MS + hour * HOUR_MS).toISOString(),
  totalPrice,
  durationMinutes: 60,
  ...(exportPrice === undefined ? {} : { exportPrice }),
});

describe('buildPriceTimeline', () => {
  it('keeps an export price the source attached when PELS\'s own export model is off', () => {
    // Homey export terms: the series carries the export price and the export
    // config PELS applies reads disabled so it is not applied twice.
    const timeline = buildPriceTimeline([period(0, 40, 5), period(1, 100, 9)], BAND, EXPORT_PRICE_DISABLED);
    expect(timeline.hasExportPrice).toBe(true);
    expect(timeline.periods.map((entry) => entry.exportPrice)).toEqual([5, 9]);
  });

  it('applies PELS\'s export model when it is the source', () => {
    const timeline = buildPriceTimeline(
      [period(0, 40), period(1, 100)],
      BAND,
      { enabled: true, spotFactorPercent: 0, fixedInclVat: 3 },
    );
    expect(timeline.hasExportPrice).toBe(true);
    expect(timeline.periods.map((entry) => entry.exportPrice)).toEqual([3, 3]);
  });

  it('reports no export price when no period has one', () => {
    const timeline = buildPriceTimeline([period(0, 40), period(1, 100)], BAND, EXPORT_PRICE_DISABLED);
    expect(timeline.hasExportPrice).toBe(false);
    expect(timeline.periods.every((entry) => entry.exportPrice === undefined)).toBe(true);
  });

  it('classifies the import price and states the lines that decided it', () => {
    const timeline = buildPriceTimeline([period(0, 40), period(1, 100), period(2, 100), period(3, 100)], BAND, EXPORT_PRICE_DISABLED);
    expect(timeline.lines).toEqual({ average: 85, cheapAtOrBelow: 63.75, expensiveFrom: 106.25 });
    expect(timeline.periods.map((entry) => entry.level)).toEqual(['cheap', 'normal', 'normal', 'normal']);
    expect(timeline.periods[0]).toMatchObject({ importPrice: 40, durationMinutes: 60 });
  });
});
