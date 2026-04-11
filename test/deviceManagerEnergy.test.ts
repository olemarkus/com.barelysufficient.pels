import { extractLiveHomePowerWatts } from '../lib/core/deviceManagerEnergy';
import { fetchLivePowerReport } from '../lib/core/deviceManagerFetch';
import * as homeyApi from '../lib/core/deviceManagerHomeyApi';

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

describe('fetchLivePowerReport', () => {
  const logger = { log: vi.fn(), debug: vi.fn(), error: vi.fn() };

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
  });

  it('returns empty results when REST client is not initialized', async () => {
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue(null);

    const result = await fetchLivePowerReport({ logger });

    expect(result.byDeviceId).toEqual({});
    expect(result.homePowerW).toBeNull();
  });

  it('returns empty results on API error', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockRejectedValue(new Error('API down'));

    const result = await fetchLivePowerReport({ logger });

    expect(result.byDeviceId).toEqual({});
    expect(result.homePowerW).toBeNull();
    expect(stderrSpy).toHaveBeenCalled();
  });
});
