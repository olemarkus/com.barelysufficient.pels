import { describe, expect, it } from 'vitest';
import { normalizeCombinedPrices } from '../src/ui/combinedPrices.ts';

describe('normalizeCombinedPrices', () => {
  it('accepts a flat array of price rows', () => {
    const rows = normalizeCombinedPrices([
      { startsAt: '2026-05-17T00:00:00.000Z', total: 0.42 },
      { startsAt: '2026-05-17T01:00:00.000Z', total: 0.18, isCheap: true },
    ]);
    expect(rows).toEqual([
      { startsAt: '2026-05-17T00:00:00.000Z', total: 0.42 },
      { startsAt: '2026-05-17T01:00:00.000Z', total: 0.18, isCheap: true },
    ]);
  });

  it('accepts a `{prices: […]}` wrapper', () => {
    const rows = normalizeCombinedPrices({
      prices: [
        { startsAt: '2026-05-17T02:00:00.000Z', total: 0.31 },
      ],
    });
    expect(rows).toEqual([
      { startsAt: '2026-05-17T02:00:00.000Z', total: 0.31 },
    ]);
  });

  it('flattens the `{days: {date: {hours: […]}}}` shape', () => {
    const rows = normalizeCombinedPrices({
      days: {
        '2026-05-17': {
          hours: [
            { startsAt: '2026-05-17T03:00:00.000Z', total: 0.25 },
            { startsAt: '2026-05-17T04:00:00.000Z', total: 0.27, isExpensive: true },
          ],
        },
        '2026-05-18': {
          hours: [
            { startsAt: '2026-05-18T00:00:00.000Z', total: 0.12, isCheap: true },
          ],
        },
      },
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ startsAt: '2026-05-17T03:00:00.000Z', total: 0.25 });
    expect(rows[1]).toEqual({ startsAt: '2026-05-17T04:00:00.000Z', total: 0.27, isExpensive: true });
    expect(rows[2]).toEqual({ startsAt: '2026-05-18T00:00:00.000Z', total: 0.12, isCheap: true });
  });

  it('falls back to `totalPrice` when `total` is missing', () => {
    const rows = normalizeCombinedPrices([
      { startsAt: '2026-05-17T05:00:00.000Z', totalPrice: 0.55 },
      { startsAt: '2026-05-17T06:00:00.000Z', total: 0.61, totalPrice: 0.99 },
    ]);
    expect(rows).toEqual([
      { startsAt: '2026-05-17T05:00:00.000Z', total: 0.55 },
      { startsAt: '2026-05-17T06:00:00.000Z', total: 0.61 },
    ]);
  });

  it('drops entries without a finite total or string startsAt', () => {
    const rows = normalizeCombinedPrices([
      { startsAt: '2026-05-17T07:00:00.000Z', total: Number.NaN },
      { startsAt: '2026-05-17T08:00:00.000Z' },
      { total: 0.42 },
      null,
      'nope',
      { startsAt: '2026-05-17T09:00:00.000Z', total: 0.42 },
    ]);
    expect(rows).toEqual([
      { startsAt: '2026-05-17T09:00:00.000Z', total: 0.42 },
    ]);
  });

  it('returns an empty array for an unrecognized shape', () => {
    expect(normalizeCombinedPrices(null)).toEqual([]);
    expect(normalizeCombinedPrices(undefined)).toEqual([]);
    expect(normalizeCombinedPrices(42)).toEqual([]);
    expect(normalizeCombinedPrices({})).toEqual([]);
  });
});
