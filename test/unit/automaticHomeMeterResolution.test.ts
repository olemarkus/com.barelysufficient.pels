import { describe, expect, it } from 'vitest';
import { resolveAutomaticHomePowerReading } from '../../lib/device/managerEnergy';

describe('resolveAutomaticHomePowerReading', () => {
  it('accepts the sole finite cumulative reading', () => {
    expect(resolveAutomaticHomePowerReading({
      items: [
        { type: 'device', id: 'load', values: { W: 9_000 } },
        { type: 'cumulative', id: 'meter-main', values: { W: 3_000 } },
      ],
    }, null)).toEqual({
      state: 'resolved',
      watts: 3_000,
      deviceId: 'meter-main',
      cumulativeItemCount: 1,
    });
  });

  it('retains the preferred cumulative meter when report order changes', () => {
    const report = {
      items: [
        { type: 'cumulative', id: 'meter-rental', values: { W: 5_000 } },
        { type: 'cumulative', id: 'meter-main', values: { W: 3_000 } },
      ],
    };

    expect(resolveAutomaticHomePowerReading(report, 'meter-main')).toEqual({
      state: 'resolved',
      watts: 3_000,
      deviceId: 'meter-main',
      cumulativeItemCount: 2,
    });
  });

  it('classifies several cumulative meters without a present preference as ambiguous', () => {
    const report = {
      items: [
        { type: 'cumulative', id: 'meter-main', values: { W: 3_000 } },
        { type: 'cumulative', id: 'meter-rental', values: { W: 5_000 } },
      ],
    };

    expect(resolveAutomaticHomePowerReading(report, null)).toEqual({
      state: 'ambiguous',
      cumulativeItemCount: 2,
    });
    expect(resolveAutomaticHomePowerReading(report, 'meter-gone')).toEqual({
      state: 'ambiguous',
      cumulativeItemCount: 2,
    });
  });

  it('keeps a sole id-less cumulative aggregate usable', () => {
    expect(resolveAutomaticHomePowerReading({
      items: [{ type: 'cumulative', values: { W: -1_200 } }],
    }, 'meter-main')).toEqual({
      state: 'resolved',
      watts: -1_200,
      deviceId: null,
      cumulativeItemCount: 1,
    });
  });

  it('normalizes an empty meter id to an id-less aggregate', () => {
    expect(resolveAutomaticHomePowerReading({
      items: [{ type: 'cumulative', id: '   ', values: { W: 10 } }],
    }, null)).toEqual({
      state: 'resolved',
      watts: 10,
      deviceId: null,
      cumulativeItemCount: 1,
    });
  });

  it('ignores non-finite cumulative readings when counting usable candidates', () => {
    expect(resolveAutomaticHomePowerReading({
      items: [
        { type: 'cumulative', id: 'broken', values: { W: Number.NaN } },
        { type: 'cumulative', id: 'meter-main', values: { W: 700 } },
      ],
    }, null)).toEqual({
      state: 'resolved',
      watts: 700,
      deviceId: 'meter-main',
      cumulativeItemCount: 2,
    });
  });

  it('deduplicates repeated rows for one id before deciding ambiguity', () => {
    expect(resolveAutomaticHomePowerReading({
      items: [
        { type: 'cumulative', id: 'meter-main', values: { W: 700 } },
        { type: 'cumulative', id: 'meter-main', values: { W: 900 } },
      ],
    }, null)).toEqual({
      state: 'resolved',
      watts: 700,
      deviceId: 'meter-main',
      cumulativeItemCount: 2,
    });
  });

  it('classifies missing, malformed, and unreadable reports as unavailable', () => {
    for (const report of [
      null,
      undefined,
      {},
      { items: [] },
      { items: [{ type: 'device', id: 'load', values: { W: 100 } }] },
      { items: [{ type: 'cumulative', values: { W: Number.POSITIVE_INFINITY } }] },
      { items: [{ type: 'cumulative', values: {} }] },
    ]) {
      expect(resolveAutomaticHomePowerReading(report, null).state).toBe('unavailable');
    }
  });
});
