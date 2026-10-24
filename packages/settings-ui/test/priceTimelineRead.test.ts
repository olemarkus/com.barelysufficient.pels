import { describe, expect, it } from 'vitest';
import type { PriceTimelineRead } from '../../contracts/src/priceTimeline.ts';
import { classifyPriceTimelineRead } from '../src/ui/priceTimelineRead.ts';
import { resolveLiveSummarySignals } from '../src/ui/livePriceSignals.ts';

const timeline: Extract<PriceTimelineRead, { state: 'ready' }> = {
  state: 'ready', priceUnit: 'EUR', hasExportPrice: true,
  lines: { average: 0.2, cheapAtOrBelow: 0.1, expensiveFrom: 0.3 },
  periods: [
    { startsAt: '2026-10-24T10:00:00Z', durationMinutes: 15, importPrice: 0.1, exportPrice: -0.04, level: 'cheap' },
    { startsAt: '2026-10-24T10:15:00Z', durationMinutes: 15, importPrice: 0.3, exportPrice: 0.12, level: 'expensive' },
  ],
};
const hourly = {
  priceScheme: 'homey', priceUnit: 'EUR',
  prices: [{ startsAt: '2026-10-24T10:00:00Z', total: 0.2, exportPrice: 0.04 }],
};

describe('native current price', () => {
  it.each([
    ['10:14:59', '0.10 EUR/kWh', '-0.04 EUR/kWh'],
    ['10:15:00', '0.30 EUR/kWh', '0.12 EUR/kWh'],
    ['10:30:00', null, null],
    ['09:59:59', null, null],
  ])('uses the published period at %s, never its hourly average', (time, priceText, exportText) => {
    expect(resolveLiveSummarySignals(hourly, timeline, Date.parse(`2026-10-24T${time}Z`)))
      .toMatchObject({ priceText, exportText });
  });

  it('does not substitute an hourly price when native prices are unavailable', () => {
    expect(resolveLiveSummarySignals(hourly, { state: 'unavailable', reason: 'read_failed' },
      Date.parse('2026-10-24T10:10:00Z')).priceText).toBeNull();
  });
});

describe('classifyPriceTimelineRead', () => {
  it('preserves native periods and signed export prices', () => {
    expect(classifyPriceTimelineRead(timeline)).toEqual(timeline);
  });

  it.each([undefined, null, { ...timeline, periods: [{ ...timeline.periods[0], durationMinutes: 0 }] },
    { ...timeline, periods: [{ ...timeline.periods[0], importPrice: Infinity }] },
    { ...timeline, periods: [{ ...timeline.periods[0], startsAt: 'invalid' }] },
    { ...timeline, periods: [{ ...timeline.periods[0], exportPrice: '0.2' }] },
  ])('rejects malformed API reads', (value) => {
    expect(classifyPriceTimelineRead(value)).toEqual({ state: 'unavailable', reason: 'read_failed' });
  });
});
