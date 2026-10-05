// The price widget's app-side entry: it reaches the app through `homey.app`
// (absent while the app restarts), reads the owner's time zone from the Homey
// clock, and passes the "Show" choice from the query.
import { describe, expect, it, vi } from 'vitest';
import { getTimeline } from '../../widgets/price/src/api';
import type { PriceTimelineRead } from '../../packages/contracts/src/priceTimeline';

const HOUR_MS = 60 * 60 * 1000;

const readyRead = (nowMs: number): PriceTimelineRead => ({
  state: 'ready',
  periods: [-1, 0, 1].map((offset) => ({
    startsAt: new Date(Math.floor(nowMs / HOUR_MS) * HOUR_MS + offset * HOUR_MS).toISOString(),
    durationMinutes: 60,
    importPrice: 50,
    exportPrice: 10,
    level: 'normal' as const,
  })),
  lines: { average: 50, cheapAtOrBelow: 37.5, expensiveFrom: 62.5 },
  priceUnit: 'øre/kWh',
  hasExportPrice: true,
});

const clock = { getTimezone: () => 'Europe/Oslo' };

describe('price widget API', () => {
  it('answers the no-prices empty state while the app is not wired', async () => {
    const payload = await getTimeline({ homey: { clock } });
    expect(payload).toMatchObject({ state: 'empty', title: 'No prices yet' });
  });

  it('builds the payload from the app timeline for the requested view', async () => {
    const getPriceTimelineForUi = vi.fn(() => readyRead(Date.now()));
    const payload = await getTimeline({ homey: { app: { getPriceTimelineForUi }, clock }, query: { show: 'export' } });
    expect(getPriceTimelineForUi).toHaveBeenCalledOnce();
    expect(payload).toMatchObject({ state: 'ready', priceText: '10.00 øre', level: null });
  });

  it('says a failed read is temporary rather than claiming there are no prices', async () => {
    const payload = await getTimeline({
      homey: { app: { getPriceTimelineForUi: () => ({ state: 'unavailable', reason: 'read_failed' }) }, clock },
    });
    expect(payload).toMatchObject({ state: 'empty', title: 'Prices unavailable' });
  });

  it('defaults to the import view without a query', async () => {
    const payload = await getTimeline({
      homey: { app: { getPriceTimelineForUi: () => readyRead(Date.now()) }, clock },
    });
    expect(payload).toMatchObject({ state: 'ready', priceText: '50.00 øre' });
  });
});
