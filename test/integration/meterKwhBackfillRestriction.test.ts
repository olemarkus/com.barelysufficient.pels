import { resolveMeterDailyKwh } from '../../lib/weather/meterKwhBackfill';

const OSLO = 'Europe/Oslo';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FIRST_MIDNIGHT_MS = Date.UTC(2026, 0, 1, 23, 0, 0);
const DAY_COUNT = 18;
const NOW_MS = Date.UTC(2026, 0, 20, 12, 0, 0);
const DAILY_KWH = 30;

const devices = {
  'han-1': { id: 'han-1', capabilities: ['meter_power.imported'] },
  'thermo-1': { id: 'thermo-1', capabilities: ['meter_power'] },
  lamp: { id: 'lamp', capabilities: ['onoff'] },
};

const counterValues = (scale: number): Array<{ t: string; v: number }> => (
  Array.from({ length: DAY_COUNT * 4 + 1 }, (_, index) => ({
    t: new Date(FIRST_MIDNIGHT_MS + index * 6 * HOUR_MS).toISOString(),
    v: 1000 + index * (DAILY_KWH / 4) * scale,
  }))
);

const dateKeyAt = (dayIndex: number): string => (
  new Date(FIRST_MIDNIGHT_MS + dayIndex * DAY_MS + HOUR_MS).toISOString().slice(0, 10)
);

const trackerKwh = (dateKey: string): { total?: number } => (
  dateKey >= dateKeyAt(2) && dateKey < dateKeyAt(DAY_COUNT) ? { total: DAILY_KWH } : {}
);

const buildFetch = () => vi.fn(async (path: string): Promise<unknown> => {
  if (path === 'manager/devices/device') return devices;
  if (path.includes('han-1:meter_power.imported')) {
    return { step: 6 * HOUR_MS, values: counterValues(1) };
  }
  if (path.includes('thermo-1:meter_power')) {
    return { step: 6 * HOUR_MS, values: counterValues(0.3) };
  }
  throw new Error(`unexpected path ${path}`);
});

describe('meter kWh election restriction at the Insights boundary', () => {
  it('confines the election to the admitted meter — a better-matching rival is never probed', async () => {
    const fetchFromHomeyApi = buildFetch();
    const result = await resolveMeterDailyKwh({
      fetchFromHomeyApi,
      getDailyKwh: trackerKwh,
      restrictToDeviceId: 'thermo-1',
      timeZone: OSLO,
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ outcome: 'no_comparable_source', candidatesChecked: 1, probeFailures: 0 });
    expect(fetchFromHomeyApi.mock.calls.some(([path]) => path.includes('han-1'))).toBe(false);
  });

  it('resolves normally when the admitted meter validates', async () => {
    const fetchFromHomeyApi = buildFetch();
    const result = await resolveMeterDailyKwh({
      fetchFromHomeyApi,
      getDailyKwh: trackerKwh,
      restrictToDeviceId: 'han-1',
      timeZone: OSLO,
      nowMs: NOW_MS,
    });

    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.deviceId).toBe('han-1');
    expect(fetchFromHomeyApi.mock.calls.some(([path]) => path.includes('thermo-1'))).toBe(false);
  });

  it('reports no_candidates when the admitted meter exposes no cumulative capability', async () => {
    const fetchFromHomeyApi = buildFetch();
    const result = await resolveMeterDailyKwh({
      fetchFromHomeyApi,
      getDailyKwh: trackerKwh,
      restrictToDeviceId: 'lamp',
      timeZone: OSLO,
      nowMs: NOW_MS,
    });

    expect(result).toEqual({ outcome: 'no_candidates' });
  });
});
