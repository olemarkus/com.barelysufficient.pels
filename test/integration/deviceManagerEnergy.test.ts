import { extractLiveHomePowerWatts, extractLiveMeterItems, extractLiveMeterPowerWatts } from '../../lib/device/managerEnergy';
import { fetchLiveMeterItems, fetchLivePowerReport } from '../../lib/device/transport/managerFetch';
import * as homeyApi from '../../lib/device/transport/managerHomeyApi';
import type { Logger } from '../../lib/utils/types';

describe('extractLiveHomePowerWatts', () => {
  it('returns watts from first cumulative item', () => {
    const report = {
      items: [
        { type: 'device', id: 'd1', values: { W: 100 } },
        { type: 'cumulative', values: { W: 4500 } },
      ],
    };
    expect(extractLiveHomePowerWatts(report)).toBe(4500);
  });

  it('returns null for missing report', () => {
    expect(extractLiveHomePowerWatts(null)).toBeNull();
    expect(extractLiveHomePowerWatts(undefined)).toBeNull();
  });

  it('returns null for empty report', () => {
    expect(extractLiveHomePowerWatts({})).toBeNull();
    expect(extractLiveHomePowerWatts({ items: [] })).toBeNull();
  });

  it('returns null for non-cumulative items only', () => {
    const report = {
      items: [
        { type: 'device', id: 'd1', values: { W: 100 } },
        { type: 'sum', values: { W: 500 } },
      ],
    };
    expect(extractLiveHomePowerWatts(report)).toBeNull();
  });

  it('takes first cumulative item, not sum', () => {
    const report = {
      items: [
        { type: 'sum', values: { W: 9999 } },
        { type: 'cumulative', values: { W: 3000 } },
        { type: 'cumulative', values: { W: 5000 } },
      ],
    };
    expect(extractLiveHomePowerWatts(report)).toBe(3000);
  });

  it('handles negative watts (solar export)', () => {
    const report = {
      items: [{ type: 'cumulative', values: { W: -1200 } }],
    };
    expect(extractLiveHomePowerWatts(report)).toBe(-1200);
  });

  it('handles zero watts', () => {
    const report = {
      items: [{ type: 'cumulative', values: { W: 0 } }],
    };
    expect(extractLiveHomePowerWatts(report)).toBe(0);
  });

  it('returns null for non-finite values', () => {
    expect(extractLiveHomePowerWatts({
      items: [{ type: 'cumulative', values: { W: NaN } }],
    })).toBeNull();
    expect(extractLiveHomePowerWatts({
      items: [{ type: 'cumulative', values: { W: Infinity } }],
    })).toBeNull();
  });

  it('returns null for missing W property', () => {
    const report = {
      items: [{ type: 'cumulative', values: {} }],
    };
    expect(extractLiveHomePowerWatts(report)).toBeNull();
  });
});

describe('extractLiveMeterPowerWatts', () => {
  it('matches the id in a cumulative item (Homey-marked whole-home meter)', () => {
    const report = {
      items: [
        { type: 'device', id: 'other', values: { W: 100 } },
        { type: 'cumulative', id: 'han-meter', values: { W: 443 } },
      ],
    };
    expect(extractLiveMeterPowerWatts(report, 'han-meter')).toBe(443);
  });

  it('matches the id in a device item (unmarked meter)', () => {
    const report = {
      items: [
        { type: 'cumulative', id: 'marked-meter', values: { W: 9999 } },
        { type: 'device', id: 'han-meter', values: { W: 3200 } },
      ],
    };
    expect(extractLiveMeterPowerWatts(report, 'han-meter')).toBe(3200);
  });

  it('passes negative watts through (export on a net meter)', () => {
    const report = {
      items: [{ type: 'device', id: 'han-meter', values: { W: -1500 } }],
    };
    expect(extractLiveMeterPowerWatts(report, 'han-meter')).toBe(-1500);
  });

  it('never falls back to another cumulative item when the id is absent', () => {
    const report = {
      items: [
        { type: 'cumulative', id: 'marked-meter', values: { W: 4500 } },
        { type: 'device', id: 'other', values: { W: 100 } },
      ],
    };
    expect(extractLiveMeterPowerWatts(report, 'gone-meter')).toBeNull();
  });

  it('ignores a matching id on a non-power item type', () => {
    const report = {
      items: [{ type: 'zone', id: 'zone-id', values: { W: 500 } }],
    };
    expect(extractLiveMeterPowerWatts(report, 'zone-id')).toBeNull();
  });

  it('returns null for non-finite or missing readings on the matched item', () => {
    expect(extractLiveMeterPowerWatts({
      items: [{ type: 'device', id: 'm', values: { W: NaN } }],
    }, 'm')).toBeNull();
    expect(extractLiveMeterPowerWatts({
      items: [{ type: 'device', id: 'm', values: { W: Infinity } }],
    }, 'm')).toBeNull();
    expect(extractLiveMeterPowerWatts({
      items: [{ type: 'device', id: 'm', values: { W: null } }],
    }, 'm')).toBeNull();
    expect(extractLiveMeterPowerWatts({
      items: [{ type: 'device', id: 'm' }],
    }, 'm')).toBeNull();
  });

  it('returns null for malformed reports', () => {
    expect(extractLiveMeterPowerWatts(null, 'm')).toBeNull();
    expect(extractLiveMeterPowerWatts({}, 'm')).toBeNull();
    expect(extractLiveMeterPowerWatts({ items: [null, 42, 'junk'] }, 'm')).toBeNull();
  });
});

describe('extractLiveMeterItems', () => {
  it('lists cumulative and device items with an id, preserving report order', () => {
    const report = {
      items: [
        { type: 'cumulative', id: 'han', values: { W: 443 } },
        { type: 'device', id: 'subpanel', values: { W: 120 } },
        { type: 'device', id: 'plug', values: { W: 0 } },
      ],
    };
    expect(extractLiveMeterItems(report)).toEqual([
      { id: 'han', type: 'cumulative' },
      { id: 'subpanel', type: 'device' },
      { id: 'plug', type: 'device' },
    ]);
  });

  it('lists a meter regardless of its reading — a momentarily non-finite/absent W stays pickable', () => {
    // The reader resolves W per poll; listing must not gate on this poll's value.
    const report = {
      items: [
        { type: 'cumulative', id: 'han', values: { W: NaN } },
        { type: 'device', id: 'subpanel' },
      ],
    };
    expect(extractLiveMeterItems(report)).toEqual([
      { id: 'han', type: 'cumulative' },
      { id: 'subpanel', type: 'device' },
    ]);
  });

  it('omits an id-less cumulative item (covered by Automatic) and other item types', () => {
    const report = {
      items: [
        { type: 'cumulative', values: { W: 443 } },
        { type: 'generator', id: 'pv', values: { W: 900 } },
        { type: 'zone', id: 'z1', values: { W: 500 } },
        { type: 'device', id: 'han', values: { W: 100 } },
      ],
    };
    expect(extractLiveMeterItems(report)).toEqual([{ id: 'han', type: 'device' }]);
  });

  it('dedupes by id, first occurrence winning', () => {
    const report = {
      items: [
        { type: 'cumulative', id: 'han', values: { W: 443 } },
        { type: 'device', id: 'han', values: { W: 443 } },
      ],
    };
    expect(extractLiveMeterItems(report)).toEqual([{ id: 'han', type: 'cumulative' }]);
  });

  it('returns an empty list for malformed reports', () => {
    expect(extractLiveMeterItems(null)).toEqual([]);
    expect(extractLiveMeterItems({})).toEqual([]);
    expect(extractLiveMeterItems({ items: [null, 42, 'junk', { type: 'device', id: 42 }] })).toEqual([]);
  });
});

describe('fetchLivePowerReport', () => {
  const logger = { log: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns both device power and home power from the REST API', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [
        { type: 'device', id: 'dev1', values: { W: 800 } },
        { type: 'cumulative', values: { W: 3200 } },
      ],
    });

    const result = await fetchLivePowerReport({ logger });

    expect(result.byDeviceId).toEqual({ dev1: 800 });
    expect(result.homePowerW).toBe(3200);
    expect(result.deviceCount).toBe(1);
  });

  it('resolves homePowerW from the selected meter, ignoring the cumulative item', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [
        { type: 'cumulative', id: 'marked-meter', values: { W: 9999 } },
        { type: 'device', id: 'han-meter', values: { W: 3200 } },
      ],
    });

    const result = await fetchLivePowerReport({ logger, meterDeviceId: 'han-meter' });

    expect(result.homePowerW).toBe(3200);
    expect(result.byDeviceId).toEqual({ 'han-meter': 3200 });
  });

  it('resolves homePowerW to null when the selected meter is missing, keeping the rest of the report', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      totalGenerated: { W: 600 },
      items: [
        { type: 'cumulative', id: 'marked-meter', values: { W: 4500 } },
        { type: 'device', id: 'dev1', values: { W: 800 } },
      ],
    });

    const result = await fetchLivePowerReport({ logger, meterDeviceId: 'gone-meter' });

    expect(result.homePowerW).toBeNull();
    expect(result.byDeviceId).toEqual({ dev1: 800 });
    expect(result.generationW).toBe(600);
  });

  it('returns empty results when REST client is not initialized', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue(null);

    const result = await fetchLivePowerReport({ logger });

    expect(result.byDeviceId).toEqual({});
    expect(result.homePowerW).toBeNull();
    expect(result.deviceCount).toBe(0);
  });

  it('returns empty results on API error', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockRejectedValue(new Error('API down'));

    const result = await fetchLivePowerReport({ logger });

    expect(result.byDeviceId).toEqual({});
    expect(result.homePowerW).toBeNull();
    expect(result.deviceCount).toBe(0);
    expect(stderrSpy).toHaveBeenCalled();
  });
});

describe('fetchLiveMeterItems', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the report meter items', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({
      items: [
        { type: 'cumulative', id: 'han', values: { W: 3200 } },
        { type: 'device', id: 'sub', values: { W: 800 } },
      ],
    });

    await expect(fetchLiveMeterItems()).resolves.toEqual([
      { id: 'han', type: 'cumulative' },
      { id: 'sub', type: 'device' },
    ]);
  });

  it('returns an empty list when the REST client is not initialized', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue(null);
    await expect(fetchLiveMeterItems()).resolves.toEqual([]);
  });

  it('returns an empty list on API error, never throwing', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockRejectedValue(new Error('API down'));
    await expect(fetchLiveMeterItems()).resolves.toEqual([]);
  });
});
