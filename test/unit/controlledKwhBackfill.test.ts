import type { Logger as PinoLogger } from 'pino';
import type { WeatherDailyRecord, WeatherHistoryState } from '../../packages/contracts/src/weatherAdvisorTypes';
import { applyControlledOutcome, resolveControlledDailyKwh } from '../../lib/weather/controlledKwhBackfill';

const OSLO = 'Europe/Oslo';
const HOUR_MS = 60 * 60 * 1000;
// Oslo local midnight (winter) is 23:00Z the previous UTC day.
const SERIES_START_MS = Date.UTC(2025, 11, 31, 23, 0, 0); // local 2026-01-01 00:00
const DAY_COUNT = 30;
const NOW_MS = Date.UTC(2026, 0, 31, 12, 0, 0);

const dateKeyOf = (dayIndex: number): string => `2026-01-${String(1 + dayIndex).padStart(2, '0')}`;

/** Cumulative meter at 6 h steps so each local-midnight diff is exactly `perDay` kWh. */
const counterValues = (perDay: number): Array<{ t: string; v: number }> => (
  Array.from({ length: DAY_COUNT * 4 + 1 }, (_, index) => ({
    t: new Date(SERIES_START_MS + index * 6 * HOUR_MS).toISOString(),
    v: 1000 + (index / 4) * perDay,
  }))
);

type DeviceSpec = { id: string; managed: boolean; perDay?: number };

const buildFetch = (devices: DeviceSpec[]) => vi.fn(async (path: string) => {
  if (path === 'manager/devices/device') {
    return Object.fromEntries(devices.map((d) => [d.id, { id: d.id, capabilities: ['meter_power'] }]));
  }
  const match = devices.find((d) => path.includes(`${d.id}:meter_power`));
  if (match) {
    return { step: 6 * HOUR_MS, values: match.perDay === undefined ? [] : counterValues(match.perDay) };
  }
  throw new Error(`unexpected path ${path}`);
});

// Tracker controlled = 40 kWh/day over the series window.
const trackerControlled = (dateKey: string): number | undefined => {
  const dayIndex = Array.from({ length: DAY_COUNT }, (_, i) => dateKeyOf(i)).indexOf(dateKey);
  return dayIndex >= 0 ? 40 : undefined;
};

const isManagedFrom = (devices: DeviceSpec[]) => (id: string): boolean => (
  devices.find((d) => d.id === id)?.managed ?? false
);

describe('resolveControlledDailyKwh', () => {
  it('sums managed device meters and validates against the tracker controlled total', async () => {
    const devices: DeviceSpec[] = [
      { id: 'therm-1', managed: true, perDay: 25 },
      { id: 'therm-2', managed: true, perDay: 15 },
      { id: 'fridge', managed: false, perDay: 100 }, // unmanaged → excluded from the sum
    ];
    const result = await resolveControlledDailyKwh({
      fetchFromHomeyApi: buildFetch(devices),
      isManaged: isManagedFrom(devices),
      getControlledDailyKwh: trackerControlled,
      timeZone: OSLO,
      nowMs: NOW_MS,
    });
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.devicesUsed).toBe(2);
    expect(result.devicesMissingMeter).toBe(0);
    expect(result.medianRatio).toBeCloseTo(1, 6); // (25+15)/40
    expect(result.controlledDailyKwh[dateKeyOf(5)]).toBeCloseTo(40, 6);
    expect(result.complete).toBe(true);
  });

  it('counts a managed device with no meter history as missing, still using the rest', async () => {
    const devices: DeviceSpec[] = [
      { id: 'therm-1', managed: true, perDay: 25 },
      { id: 'therm-2', managed: true, perDay: 15 },
      { id: 'relay', managed: true, perDay: undefined }, // metered capability but empty log
    ];
    const result = await resolveControlledDailyKwh({
      fetchFromHomeyApi: buildFetch(devices),
      isManaged: isManagedFrom(devices),
      getControlledDailyKwh: trackerControlled,
      timeZone: OSLO,
      nowMs: NOW_MS,
    });
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.devicesUsed).toBe(2);
    expect(result.devicesMissingMeter).toBe(1);
    expect(result.controlledDailyKwh[dateKeyOf(5)]).toBeCloseTo(40, 6);
  });

  it('returns not_validated when the summed meters disagree with the tracker controlled', async () => {
    const devices: DeviceSpec[] = [{ id: 'therm-1', managed: true, perDay: 12 }]; // 12 vs tracker 40 → 0.3
    const result = await resolveControlledDailyKwh({
      fetchFromHomeyApi: buildFetch(devices),
      isManaged: isManagedFrom(devices),
      getControlledDailyKwh: trackerControlled,
      timeZone: OSLO,
      nowMs: NOW_MS,
    });
    expect(result.outcome).toBe('not_validated');
    if (result.outcome !== 'not_validated') return;
    expect(result.medianRatio).toBeCloseTo(0.3, 2);
  });

  it('returns no_devices when nothing managed has a cumulative meter', async () => {
    const devices: DeviceSpec[] = [{ id: 'fridge', managed: false, perDay: 30 }];
    const result = await resolveControlledDailyKwh({
      fetchFromHomeyApi: buildFetch(devices),
      isManaged: isManagedFrom(devices),
      getControlledDailyKwh: trackerControlled,
      timeZone: OSLO,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ outcome: 'no_devices' });
  });

  it('tolerates flow-mode per-day noise in the reference (median centered, wide spread passes)', async () => {
    const devices: DeviceSpec[] = [{ id: 'therm-1', managed: true, perDay: 40 }];
    // Reference swings ±50% day to day but centers on 40 — the flow-mode case.
    const noisyTracker = (dateKey: string): number | undefined => {
      const dayIndex = Array.from({ length: DAY_COUNT }, (_, i) => dateKeyOf(i)).indexOf(dateKey);
      if (dayIndex < 0) return undefined;
      return dayIndex % 2 === 0 ? 60 : 26.7; // median of {40/60, 40/26.7} ≈ 1.0
    };
    const result = await resolveControlledDailyKwh({
      fetchFromHomeyApi: buildFetch(devices),
      isManaged: isManagedFrom(devices),
      getControlledDailyKwh: noisyTracker,
      timeZone: OSLO,
      nowMs: NOW_MS,
    });
    expect(result.outcome).toBe('resolved');
  });
});

describe('applyControlledOutcome', () => {
  const logger: Pick<PinoLogger, 'info'> = { info: vi.fn() };
  const meterDay = (dateKey: string, kwhTotal: number): WeatherDailyRecord => ({
    dateKey,
    kwhTotal,
    tempMeanC: 0,
    tempMinC: -2,
    tempMaxC: 2,
    tempSampleCount: 4,
    quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: true, kwhBackfilled: true },
  });
  const stateOf = (): WeatherHistoryState => ({ records: [meterDay('2025-02-01', 50)] });

  it('applies the split and stamps the version on a complete resolved run', () => {
    const { state, dirty } = applyControlledOutcome({
      state: stateOf(),
      result: {
        outcome: 'resolved',
        controlledDailyKwh: { '2025-02-01': 18 },
        overlapDays: 30,
        medianRatio: 1.0,
        devicesUsed: 2,
        devicesMissingMeter: 0,
        complete: true,
      },
      logger,
    });
    expect(dirty).toBe(true);
    expect(state.controlledBackfillVersion).toBe(1);
    expect(state.records[0]).toMatchObject({ kwhControlled: 18, kwhUncontrolled: 32 });
  });

  it('applies best-effort but does NOT stamp on an incomplete resolved run (lets a later run refresh)', () => {
    const { state, dirty } = applyControlledOutcome({
      state: stateOf(),
      result: {
        outcome: 'resolved',
        controlledDailyKwh: { '2025-02-01': 12 },
        overlapDays: 30,
        medianRatio: 1.0,
        devicesUsed: 1,
        devicesMissingMeter: 0,
        complete: false,
      },
      logger,
    });
    expect(dirty).toBe(true);
    expect(state.controlledBackfillVersion).toBeUndefined();
    expect(state.records[0].kwhControlled).toBe(12);
  });

  it('never latches on a failed/absent validation, so a later-added meter stays adoptable', () => {
    for (const result of [
      { outcome: 'not_validated' as const, overlapDays: 40, medianRatio: 0.4, devicesUsed: 1 },
      { outcome: 'not_validated' as const, overlapDays: 5, medianRatio: 0.4, devicesUsed: 1 },
      { outcome: 'no_devices' as const },
    ]) {
      const { state, dirty } = applyControlledOutcome({ state: stateOf(), result, logger });
      expect(dirty).toBe(false);
      expect(state.controlledBackfillVersion).toBeUndefined();
      expect(state.records[0].kwhControlled).toBeUndefined();
    }
  });
});
