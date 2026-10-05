// The price widget's node payload builder: the rolling window, the current
// price and level, merged level shades, the subline that always states the
// lines, the tomorrow-pending caption, and the import/export/both modes.
import { describe, expect, it } from 'vitest';
import type {
  PriceTimelinePeriod,
  PriceTimelineRead,
  PriceTimelineLevel,
} from '../../packages/contracts/src/priceTimeline';
import {
  buildPriceWidgetPayload,
  resolvePriceWidgetShow,
} from '../../widgets/price/src/priceWidgetPayload';
import type { PriceWidgetReadyPayload } from '../../widgets/price/src/priceWidgetTypes';

const TZ = 'Europe/Oslo';
const HOUR_MS = 60 * 60 * 1000;
// 2026-10-05 00:00 in Oslo (UTC+2).
const DAY_START_MS = Date.UTC(2026, 9, 4, 22, 0, 0);
const NOW_MS = DAY_START_MS + 10.5 * HOUR_MS; // 10:30

const LINES = { average: 50, cheapAtOrBelow: 37.5, expensiveFrom: 62.5 };

const levelOf = (price: number): PriceTimelineLevel => {
  if (price <= LINES.cheapAtOrBelow) return 'cheap';
  if (price >= LINES.expensiveFrom) return 'expensive';
  return 'normal';
};

const hourly = (prices: number[], withExport = false): PriceTimelinePeriod[] => prices.map((price, hour) => ({
  startsAt: new Date(DAY_START_MS + hour * HOUR_MS).toISOString(),
  durationMinutes: 60,
  importPrice: price,
  ...(withExport ? { exportPrice: price / 2 } : {}),
  level: levelOf(price),
}));

const ready = (periods: PriceTimelinePeriod[], hasExportPrice = false): PriceTimelineRead => ({
  state: 'ready',
  periods,
  lines: LINES,
  priceUnit: 'øre/kWh',
  hasExportPrice,
});

// A day with a cheap stretch at 12-14 and an expensive one at 17-19.
const DAY = [50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 30, 30, 50, 50, 50, 70, 70, 50, 50, 50, 50, 50];

const build = (read: PriceTimelineRead, show: 'import' | 'export' | 'both' = 'import') => (
  buildPriceWidgetPayload(read, show, NOW_MS, TZ)
);

const expectReady = (payload: ReturnType<typeof build>): PriceWidgetReadyPayload => {
  if (payload.state !== 'ready') throw new Error(`expected ready, got ${payload.subtitle}`);
  return payload;
};

describe('resolvePriceWidgetShow', () => {
  it('defaults to import for anything but export or both', () => {
    expect(resolvePriceWidgetShow('export')).toBe('export');
    expect(resolvePriceWidgetShow('both')).toBe('both');
    expect(resolvePriceWidgetShow(undefined)).toBe('import');
    expect(resolvePriceWidgetShow('junk')).toBe('import');
  });
});

describe('buildPriceWidgetPayload', () => {
  it('tells no prices, a failed read and a missing current price apart', () => {
    expect(build({ state: 'unavailable', reason: 'no_prices' })).toMatchObject({ state: 'empty', title: 'No prices yet' });
    expect(build({ state: 'unavailable', reason: 'read_failed' })).toMatchObject({ state: 'empty', title: 'Prices unavailable' });
    expect(build(ready(hourly(DAY).slice(0, 5)))).toMatchObject({ state: 'empty', title: 'No price for right now' });
  });

  it('starts the window on the hour three hours before now and runs to the last price', () => {
    const payload = expectReady(build(ready(hourly(DAY))));
    expect(payload.chart.windowStartMs).toBe(DAY_START_MS + 7 * HOUR_MS);
    expect(payload.chart.windowEndMs).toBe(DAY_START_MS + 24 * HOUR_MS);
    expect(payload.chart.importSteps[0]?.startMs).toBe(DAY_START_MS + 7 * HOUR_MS);
    expect(payload.chart.nowMs).toBe(NOW_MS);
  });

  it('heads with the current import price and its level', () => {
    const payload = expectReady(build(ready(hourly(DAY))));
    expect(payload.priceText).toBe('50.00 øre');
    expect(payload.level).toEqual({ label: 'Price normal', tone: null });
    expect(payload.chart.nowPrice).toBe(50);
  });

  it('merges consecutive low or high periods into one shade each', () => {
    const payload = expectReady(build(ready(hourly(DAY))));
    expect(payload.chart.shades).toEqual([
      { startMs: DAY_START_MS + 12 * HOUR_MS, endMs: DAY_START_MS + 14 * HOUR_MS, level: 'cheap' },
      { startMs: DAY_START_MS + 17 * HOUR_MS, endMs: DAY_START_MS + 19 * HOUR_MS, level: 'expensive' },
    ]);
    expect(payload.legend.map((item) => item.key)).toEqual(['cheap', 'expensive']);
  });

  it('states both lines when both levels occur', () => {
    const payload = expectReady(build(ready(hourly(DAY))));
    expect(payload.subline).toBe('High from 62.50 øre · low up to 37.50 øre');
  });

  it('still states the expensive line, and the highest price, when nothing is high', () => {
    const noHigh = DAY.map((price) => Math.min(price, 55));
    const payload = expectReady(build(ready(hourly(noHigh))));
    expect(payload.subline).toBe('High from 62.50 øre, highest 55.00 øre · low up to 37.50 øre');
    expect(payload.chart.shades.every((shade) => shade.level === 'cheap')).toBe(true);
  });

  it('says prices stay near the average when neither level occurs in the window', () => {
    const flat = DAY.map(() => 50);
    const payload = expectReady(build(ready(hourly(flat))));
    expect(payload.subline).toBe('Prices stay close to the average of 50.00 øre, so none count as low or high');
    expect(payload.chart.shades).toEqual([]);
    expect(payload.legend).toEqual([]);
  });

  it('judges what occurs over the visible window, not hours already off the chart', () => {
    // Expensive at 02:00 only: before the window, so the chart shows no high shade.
    const earlyPeak = DAY.map((price, hour) => (hour === 2 ? 70 : Math.min(price, 55)));
    const payload = expectReady(build(ready(hourly(earlyPeak))));
    expect(payload.subline.startsWith('High from 62.50 øre, highest 55.00 øre')).toBe(true);
  });

  it('notes that the lines can move until tomorrow has prices', () => {
    expect(expectReady(build(ready(hourly(DAY)))).caption).toBe("The lines can move when tomorrow's prices arrive.");
    // Part of tomorrow is not all of it: the average is still unsettled.
    const partial = expectReady(build(ready(hourly([...DAY, 50, 50, 50]))));
    expect(partial.caption).toBe("The lines can move when tomorrow's prices arrive.");
    const twoDays = expectReady(build(ready(hourly([...DAY, ...DAY]))));
    expect(twoDays.caption).toBeNull();
    expect(twoDays.chart.dayDividers).toEqual([{ atMs: DAY_START_MS + 24 * HOUR_MS, label: 'Tomorrow' }]);
  });

  it('labels local 00/06/12/18 hours inside the window', () => {
    const payload = expectReady(build(ready(hourly(DAY))));
    expect(payload.chart.timeTicks.map((tick) => tick.label)).toEqual(['12', '18', '00']);
  });

  it('draws the export price as a second line in the both view', () => {
    const payload = expectReady(build(ready(hourly(DAY, true), true), 'both'));
    expect(payload.chart.exportSteps).toHaveLength(payload.chart.importSteps.length);
    expect(payload.legend.map((item) => item.key)).toEqual(['import', 'export', 'cheap', 'expensive']);
    expect(payload.priceText).toBe('50.00 øre');
  });

  it('falls back to the import price alone for both without an export price', () => {
    const payload = expectReady(build(ready(hourly(DAY)), 'both'));
    expect(payload.chart.exportSteps).toEqual([]);
    expect(payload.legend.map((item) => item.key)).toEqual(['cheap', 'expensive']);
  });

  it('shows the export price without levels in the export view', () => {
    const payload = expectReady(build(ready(hourly(DAY, true), true), 'export'));
    expect(payload.priceText).toBe('25.00 øre');
    expect(payload.level).toBeNull();
    expect(payload.chart.shades).toEqual([]);
    expect(payload.chart.importSteps).toEqual([]);
  });

  it('says the export price does not cover now when only the current period lacks one', () => {
    const periods = hourly(DAY, true).map((period, hour) => {
      if (hour !== 10) return period;
      const { exportPrice: _omitted, ...rest } = period;
      return rest;
    });
    const payload = build(ready(periods, true), 'export');
    expect(payload).toMatchObject({ state: 'empty', title: 'No export price for right now' });
  });

  it('labels local full hours in a half-hour time zone', () => {
    // Asia/Kolkata is UTC+5:30, so no local full hour falls on a UTC one.
    const start = Date.UTC(2026, 9, 4, 18, 30, 0); // 10-05 00:00 IST
    const periods = Array.from({ length: 24 }, (_, hour) => ({
      startsAt: new Date(start + hour * HOUR_MS).toISOString(),
      durationMinutes: 60,
      importPrice: 50,
      level: 'normal' as const,
    }));
    const payload = buildPriceWidgetPayload(
      { state: 'ready', periods, lines: LINES, priceUnit: 'øre/kWh', hasExportPrice: false },
      'import',
      start + 8 * HOUR_MS,
      'Asia/Kolkata',
    );
    if (payload.state !== 'ready') throw new Error('expected ready');
    expect(payload.chart.timeTicks.map((tick) => tick.label)).toEqual(['06', '12', '18', '00']);
    expect(payload.chart.timeTicks[0]?.atMs).toBe(start + 6 * HOUR_MS);
  });

  it('says no export price is set up for the export view without one', () => {
    const payload = build(ready(hourly(DAY)), 'export');
    expect(payload).toMatchObject({ state: 'empty', title: 'No export price set up' });
  });

  it('describes the level for screen readers in the canonical Price: form', () => {
    expect(expectReady(build(ready(hourly(DAY)))).ariaLabel).toBe('Price now 50.00 øre. Price: normal');
  });

  it('writes currency prices below one with three decimals, so neighbouring periods stay apart', () => {
    const eur = hourly(DAY.map((price) => price / 123));
    const read: PriceTimelineRead = {
      state: 'ready',
      periods: eur,
      lines: { average: 0.4065, cheapAtOrBelow: 0.3049, expensiveFrom: 0.5081 },
      priceUnit: 'EUR',
      hasExportPrice: false,
    };
    const payload = expectReady(build(read));
    expect(payload.priceText).toBe('0.407 EUR');
    expect(payload.subline).toContain('High from 0.508 EUR');
    expect(payload.chart.axisUnit).toBe('EUR/kWh');
  });

  it('places the hour labels and the tomorrow divider by local time across a DST change', () => {
    // 2026-10-25 in Oslo has 25 hours (CEST -> CET at 03:00). Prices for the
    // 24 + 25 hours of 10-24 and 10-25, viewed at 22:30 on 10-24.
    const start = Date.UTC(2026, 9, 23, 22, 0, 0); // 10-24 00:00 CEST
    const periods = Array.from({ length: 49 }, (_, hour) => ({
      startsAt: new Date(start + hour * HOUR_MS).toISOString(),
      durationMinutes: 60,
      importPrice: 50,
      level: 'normal' as const,
    }));
    const payload = buildPriceWidgetPayload(
      { state: 'ready', periods, lines: LINES, priceUnit: 'øre/kWh', hasExportPrice: false },
      'import',
      start + 22.5 * HOUR_MS,
      TZ,
    );
    if (payload.state !== 'ready') throw new Error('expected ready');
    expect(payload.chart.dayDividers).toEqual([{ atMs: start + 24 * HOUR_MS, label: 'Tomorrow' }]);
    // 00, 06, 12, 18 and the next 00 on the 25-hour day fall 7, 6, 6 and 6 hours apart.
    expect(payload.chart.timeTicks.map((tick) => tick.label)).toEqual(['00', '06', '12', '18', '00']);
    expect(payload.chart.timeTicks.map((tick) => (tick.atMs - start) / HOUR_MS)).toEqual([24, 31, 37, 43, 49]);
    expect(payload.caption).toBeNull();
  });

  it('keeps zero on the price axis and splits it into at most four intervals', () => {
    const payload = expectReady(build(ready(hourly(DAY))));
    expect(payload.chart.yMin).toBe(0);
    expect(payload.chart.yMax).toBeGreaterThanOrEqual(70);
    expect(payload.chart.yTicks.length).toBeLessThanOrEqual(5);
    expect(payload.chart.axisUnit).toBe('øre/kWh');
  });

  it('reaches below zero for negative prices', () => {
    const negative = DAY.map((price, hour) => (hour === 13 ? -8 : price));
    const payload = expectReady(build(ready(hourly(negative))));
    expect(payload.chart.yMin).toBeLessThan(0);
    expect(payload.chart.yMin).toBeLessThanOrEqual(-8);
  });
});
