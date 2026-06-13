import type { Logger as PinoLogger } from 'pino';
import { WeatherCollector, type WeatherCollectorDeps } from '../../lib/weather/weatherCollector';
import type { WeatherHistoryState } from '../../packages/contracts/src/weatherAdvisorTypes';

const OSLO = 'Europe/Oslo';
// 2026-01-10T10:00:00Z = 11:00 in Oslo (UTC+1, winter): local dateKey 2026-01-10.
const START_MS = Date.UTC(2026, 0, 10, 10, 0, 0);
const HOUR_MS = 60 * 60 * 1000;

type Harness = {
  collector: WeatherCollector;
  deps: WeatherCollectorDeps;
  store: { read: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
  persisted: { value: unknown };
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
};

const buildHarness = (overrides: Partial<WeatherCollectorDeps> = {}): Harness => {
  // Seed a valid empty state: an absent first read deliberately engages the
  // 5-minute persistence grace window (covered by its own test below).
  const persisted: { value: unknown } = { value: { records: [] } };
  const store = {
    read: vi.fn(() => persisted.value),
    write: vi.fn((state: WeatherHistoryState) => {
      persisted.value = JSON.parse(JSON.stringify(state));
    }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: WeatherCollectorDeps = {
    store,
    readDevice: vi.fn(async (deviceId: string) => ({
      id: deviceId,
      name: 'Weather',
      capabilitiesObj: { measure_temperature: { value: deviceId === 'fc-1' ? -7 : 3.5 } },
    })),
    fetchInsights: vi.fn(async () => ({ step: 6 * HOUR_MS, values: [] })),
    getDailyKwh: vi.fn(() => ({ total: 42.5, controlled: 10, uncontrolled: 32.5 })),
    getDaySuppression: vi.fn(() => ({})),
    isManagedDevice: vi.fn(() => false),
    getUnreliablePeriods: vi.fn(() => []),
    getSettings: vi.fn(() => ({ enabled: true, outdoorDeviceId: 'out-1' })),
    getNowMs: () => Date.now(),
    getTimeZone: () => OSLO,
    logger: logger as unknown as PinoLogger,
    ...overrides,
  };
  return { collector: new WeatherCollector(deps), deps, store, persisted, logger };
};

const lastWritten = (store: Harness['store']): WeatherHistoryState => (
  store.write.mock.calls.at(-1)?.[0] as WeatherHistoryState
);

const sixHourZeroPoints = (dayStartUtcMs: number): Array<{ t: string; v: number }> => (
  Array.from({ length: 4 }, (_, index) => ({
    t: new Date(dayStartUtcMs + index * 6 * HOUR_MS).toISOString(),
    v: 0,
  }))
);

// ── Meter-backfill fixtures: 18 local days 2025-12-21..2026-01-07 at 40 kWh/day ──
const METER_DEVICES = { 'meter-1': { id: 'meter-1', capabilities: ['meter_power.imported'] } };
const KWH_SERIES_START_MS = Date.UTC(2025, 11, 20, 23, 0, 0); // Oslo 2025-12-21 00:00
const KWH_DAYS = 18;
const TRACKER_FROM = '2025-12-23'; // the two oldest days exist only on the meter

const meterDateKey = (dayIndex: number): string => (
  new Date(Date.UTC(2025, 11, 21 + dayIndex, 12)).toISOString().slice(0, 10)
);

/** Cumulative counter sampled 6-hourly on local midnights: exactly 40 kWh/day. */
const meterCounterValues = (): Array<{ t: string; v: number }> => (
  Array.from({ length: KWH_DAYS * 4 + 1 }, (_, index) => ({
    t: new Date(KWH_SERIES_START_MS + index * 6 * HOUR_MS).toISOString(),
    v: 1000 + index * 10,
  }))
);

const meterTempPoints = (): Array<{ t: string; v: number }> => (
  Array.from({ length: KWH_DAYS }, (_, day) => sixHourZeroPoints(KWH_SERIES_START_MS + day * 24 * HOUR_MS)).flat()
);

const trackerKwhForMeterDays = (dateKey: string): { total?: number; controlled?: number } => (
  dateKey >= TRACKER_FROM && dateKey <= meterDateKey(KWH_DAYS - 1) ? { total: 40 } : {}
);

/** Records as the temperature backfill would have created them (kWh joined where the tracker had it). */
const meterSeededRecords = (): WeatherHistoryState['records'] => (
  Array.from({ length: KWH_DAYS }, (_, dayIndex) => {
    const dateKey = meterDateKey(dayIndex);
    const missingKwh = dateKey < TRACKER_FROM;
    return {
      dateKey,
      ...(missingKwh ? {} : { kwhTotal: 40 }),
      tempMeanC: 0,
      tempMinC: -1,
      tempMaxC: 1,
      tempSampleCount: 4,
      quality: { partialTemp: false, missingKwh, unreliablePower: false, backfilled: true },
    };
  })
);

describe('WeatherCollector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers no timers and reads nothing when disabled or unconfigured', () => {
    const { collector, store } = buildHarness({
      getSettings: vi.fn(() => ({ enabled: false })),
    });
    collector.start();
    expect(vi.getTimerCount()).toBe(0);
    expect(store.read).not.toHaveBeenCalled();
  });

  it('samples immediately on start and persists after the debounce window', async () => {
    const { collector, store } = buildHarness();
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.write).toHaveBeenCalledTimes(1);
    const written = lastWritten(store);
    expect(written.accumulators?.['2026-01-10']).toMatchObject({ count: 1, minC: 3.5, maxC: 3.5 });
    // The default harness backfill returns zero records, so the one-shot
    // marker must stay unset (an empty reconstruction is retried next start).
    expect(written.backfilledDeviceId).toBeUndefined();
    collector.stop();
  });

  it('samples hourly and accumulates forecast readings against tomorrow', async () => {
    const { collector, store, deps } = buildHarness({
      getSettings: vi.fn(() => ({ enabled: true, outdoorDeviceId: 'out-1', forecastDeviceId: 'fc-1' })),
    });
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.readDevice).toHaveBeenCalledTimes(2);
    // Next sample at the top of the hour + 90 s.
    await vi.advanceTimersByTimeAsync(HOUR_MS + 90_000);
    expect(deps.readDevice).toHaveBeenCalledTimes(4);
    collector.stop();
    const written = lastWritten(store);
    expect(written.accumulators?.['2026-01-10']?.count).toBe(2);
    // 10:00Z is 11:00 in Oslo; the +24 h targets land on tomorrow's same-ish hours.
    expect(written.forecastHourly?.['2026-01-11']).toEqual({ '11': -7, '12': -7 });
  });

  it('dedupes a restart re-sample landing in the same local hour', async () => {
    const { collector, store } = buildHarness();
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    collector.stop();
    expect(lastWritten(store).accumulators?.['2026-01-10']?.count).toBe(1);

    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    collector.stop();
    expect(lastWritten(store).accumulators?.['2026-01-10']?.count).toBe(1);
  });

  it('recomputes derived fields after rollups and backfills', async () => {
    const recomputeDerived = vi.fn((state: WeatherHistoryState) => ({
      ...state,
      latestFit: { model: 'uncorrelated' } as WeatherHistoryState['latestFit'],
    }));
    vi.setSystemTime(Date.UTC(2026, 0, 10, 22, 30, 0)); // Oslo 23:30
    const { collector, store } = buildHarness({ recomputeDerived });
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(recomputeDerived).not.toHaveBeenCalled(); // samples alone don't refit
    await vi.advanceTimersByTimeAsync(36 * 60 * 1000); // past midnight rollup
    expect(recomputeDerived).toHaveBeenCalledTimes(1);
    collector.stop();
    expect(lastWritten(store).latestFit).toEqual({ model: 'uncorrelated' });
  });

  it('rolls up yesterday shortly after local midnight with kWh snapshot and quality', async () => {
    vi.setSystemTime(Date.UTC(2026, 0, 10, 22, 30, 0)); // Oslo 23:30
    const { collector, store, deps } = buildHarness();
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    // Local midnight is 23:00Z; rollup fires at +5 min.
    await vi.advanceTimersByTimeAsync(36 * 60 * 1000);
    collector.stop();
    expect(deps.getDailyKwh).toHaveBeenCalledWith('2026-01-10');
    const written = lastWritten(store);
    expect(written.records).toHaveLength(1);
    expect(written.records[0]).toMatchObject({
      dateKey: '2026-01-10',
      kwhTotal: 42.5,
      kwhControlled: 10,
      tempSampleCount: 1,
      quality: { partialTemp: true, missingKwh: false, unreliablePower: false, backfilled: false },
    });
    // The 00:01:30 local sample opened the new day's accumulator.
    expect(written.accumulators?.['2026-01-11']?.count).toBe(1);
  });

  it('threads the uncontrolled split and the day suppression covariate into the record', async () => {
    vi.setSystemTime(Date.UTC(2026, 0, 10, 22, 30, 0)); // Oslo 23:30
    const getDaySuppression = vi.fn(() => ({ targetDeficitMs: 7_200_000, deadlineMissedToBudget: true }));
    const { collector, store, deps } = buildHarness({
      getDailyKwh: vi.fn(() => ({ total: 42.5, controlled: 10, uncontrolled: 32.5 })),
      getDaySuppression,
    });
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(36 * 60 * 1000);
    collector.stop();
    expect(getDaySuppression).toHaveBeenCalledWith('2026-01-10');
    expect((deps.getDaySuppression as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    const record = lastWritten(store).records.find((entry) => entry.dateKey === '2026-01-10');
    expect(record).toMatchObject({
      kwhUncontrolled: 32.5,
      suppression: { targetDeficitMs: 7_200_000, deadlineMissedToBudget: true },
    });
  });

  it('catches up rollups for accumulator days the app slept through', async () => {
    const { collector, store, persisted } = buildHarness();
    persisted.value = {
      records: [],
      accumulators: { '2026-01-09': { sumC: -100, count: 20, minC: -12, maxC: -1 } },
      backfilledDeviceId: 'out-1',
    };
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    collector.stop();
    const written = lastWritten(store);
    expect(written.records[0]).toMatchObject({
      dateKey: '2026-01-09',
      tempMeanC: -5,
      kwhTotal: 42.5,
      quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false },
    });
    expect(written.accumulators?.['2026-01-09']).toBeUndefined();
  });

  it('refuses to persist inside the grace window after an implausible read', async () => {
    const { collector, store, logger } = buildHarness();
    store.read.mockReturnValue({ records: 'corrupted' });
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    collector.flush();
    expect(store.write).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith({ event: 'weather_history_flush_skipped_grace' });
    // Debounce + retries all land inside the 5-minute grace…
    await vi.advanceTimersByTimeAsync(290_000);
    expect(store.write).not.toHaveBeenCalled();
    // …and the first retry after expiry finally writes.
    await vi.advanceTimersByTimeAsync(70_000);
    expect(store.write).toHaveBeenCalled();
    collector.stop();
  });

  it('recovers a transiently unreadable store instead of overwriting it', async () => {
    const { collector, store } = buildHarness();
    const preservedRecord = {
      dateKey: '2025-03-01',
      kwhTotal: 55,
      tempMeanC: -2,
      tempMinC: -6,
      tempMaxC: 1,
      tempSampleCount: 24,
      quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false },
    };
    // Boot read misses; the store heals before the first persist attempt.
    store.read.mockReturnValueOnce(undefined);
    store.read.mockReturnValue({ records: [preservedRecord], backfilledDeviceId: 'out-1' });
    collector.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.write).toHaveBeenCalledTimes(1);
    const written = lastWritten(store);
    // Recovered history survives AND the boot sample is merged on top.
    expect(written.records).toEqual([preservedRecord]);
    expect(written.accumulators?.['2026-01-10']?.count).toBe(1);
    expect(written.backfilledDeviceId).toBe('out-1');
    collector.stop();
  });

  it('does not "recover" its own post-grace write over fresher in-memory samples', async () => {
    const { collector, store, persisted } = buildHarness();
    // Reads fail until the first write lands; afterwards they return whatever
    // was last written (the store healed — by our own write).
    let writeHappened = false;
    store.read.mockImplementation(() => (writeHappened ? persisted.value : { records: 'corrupted' }));
    store.write.mockImplementation((state: WeatherHistoryState) => {
      writeHappened = true;
      persisted.value = JSON.parse(JSON.stringify(state));
    });
    collector.start();
    // Grace expires; first write carries the hour-11 boot sample.
    await vi.advanceTimersByTimeAsync(331_000);
    expect(store.write).toHaveBeenCalledTimes(1);
    // Next hourly sample (hour 12) must persist count 2 — a stale "recovery"
    // of our own earlier write would revert it to count 1.
    await vi.advanceTimersByTimeAsync(3_500_000);
    expect(lastWritten(store).accumulators?.['2026-01-10']?.count).toBe(2);
    collector.stop();
  });

  it('keeps a single hourly chain when a reload races an in-flight sample', async () => {
    let releaseRead: (() => void) | undefined;
    const readDevice = vi.fn(async (deviceId: string) => {
      const device = {
        id: deviceId,
        name: 'Weather',
        capabilitiesObj: { measure_temperature: { value: 3.5 } },
      };
      if (releaseRead !== undefined) return device; // already armed → later calls resolve fast
      if (readDevice.mock.calls.length === 2) {
        // Second call (first hourly tick): hold the REST read open.
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
      }
      return device;
    });
    const { collector, deps } = buildHarness({ readDevice });
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    // Fire the hourly timer; its sampleOnce now hangs on the device read.
    await vi.advanceTimersByTimeAsync(HOUR_MS + 90_000);
    // Reload while the read is in flight.
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    releaseRead?.();
    releaseRead = () => {};
    await vi.advanceTimersByTimeAsync(0);
    const callsAfterReload = (deps.readDevice as ReturnType<typeof vi.fn>).mock.calls.length;
    // Exactly one hourly chain must survive: the next tick adds ONE read.
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect((deps.readDevice as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterReload + 1);
    collector.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discards an in-flight read from the previous device after a switch-reload', async () => {
    const gates = new Map<string, () => void>();
    const temps: Record<string, number> = { 'out-1': 3.5, 'out-2': 5.5 };
    const readDevice = vi.fn(async (deviceId: string) => {
      await new Promise<void>((resolve) => {
        gates.set(deviceId, resolve);
      });
      return {
        id: deviceId,
        name: 'Weather',
        capabilitiesObj: { measure_temperature: { value: temps[deviceId] } },
      };
    });
    const settings = vi.fn(() => ({ enabled: true, outdoorDeviceId: 'out-1' } as
      ReturnType<WeatherCollectorDeps['getSettings']>));
    const { collector, store } = buildHarness({ readDevice, getSettings: settings });
    collector.start();
    await vi.advanceTimersByTimeAsync(0); // out-1 boot read now pending
    settings.mockReturnValue({ enabled: true, outdoorDeviceId: 'out-2' });
    collector.start(); // reload onto the new device; out-2 boot read pending
    await vi.advanceTimersByTimeAsync(0);
    // Old device resolves FIRST — its reading must be discarded, not deduped-in.
    gates.get('out-1')?.();
    await vi.advanceTimersByTimeAsync(0);
    gates.get('out-2')?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(collector.getCurrentOutdoorTemperatureC()).toBe(5.5);
    collector.stop();
    expect(lastWritten(store).accumulators?.['2026-01-10']).toMatchObject({ count: 1, minC: 5.5, maxC: 5.5 });
  });

  it('keeps state dirty and retries when the settings write throws', async () => {
    const { collector, store, logger } = buildHarness();
    store.write.mockImplementationOnce(() => {
      throw new Error('settings write failed');
    });
    collector.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.write).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.write).toHaveBeenCalledTimes(2);
    collector.stop();
  });

  it('backfills from Insights once per device and never overwrites live records', async () => {
    const points = [Date.UTC(2026, 0, 4, 23, 0, 0), Date.UTC(2026, 0, 5, 23, 0, 0)]
      .flatMap(sixHourZeroPoints);
    const liveDay5 = {
      dateKey: '2026-01-05',
      kwhTotal: 33,
      tempMeanC: 4,
      tempMinC: 2,
      tempMaxC: 6,
      tempSampleCount: 24,
      quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false },
    };
    const { collector, store, persisted, deps } = buildHarness({
      fetchInsights: vi.fn(async (path: string) => (
        path.includes('lastYear') ? { step: 6 * HOUR_MS, values: points } : { step: 6 * HOUR_MS, values: [] }
      )),
    });
    persisted.value = { records: [liveDay5] };
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    collector.stop();
    const written = lastWritten(store);
    expect(written.backfilledDeviceId).toBe('out-1');
    expect(written.records.map((record) => record.dateKey)).toEqual(['2026-01-05', '2026-01-06']);
    expect(written.records[0].tempMeanC).toBe(4);
    expect(written.records[1].quality.backfilled).toBe(true);

    // The kWh resolution may rescan per start (its no-source outcome never
    // latches), but the TEMPERATURE backfill must not re-fetch once complete.
    const temperatureFetches = (): number => (deps.fetchInsights as ReturnType<typeof vi.fn>).mock.calls
      .filter(([path]) => String(path).includes('measure_temperature')).length;
    const fetchCallsAfterFirstRun = temperatureFetches();
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    collector.stop();
    expect(temperatureFetches()).toBe(fetchCallsAfterFirstRun);
  });

  it('runs the controlled-split backfill once the meter totals exist, filling uncontrolled', async () => {
    vi.setSystemTime(Date.UTC(2026, 1, 1, 12, 0, 0)); // past the Jan series so all 20 days count
    // Meter-filled history: whole-home kwhTotal present, no split, meter marker set.
    const splitRecords = Array.from({ length: 20 }, (_, i) => ({
      dateKey: `2026-01-${String(i + 1).padStart(2, '0')}`,
      kwhTotal: 40,
      tempMeanC: 0,
      tempMinC: -2,
      tempMaxC: 2,
      tempSampleCount: 4,
      quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: true, kwhBackfilled: true },
    }));
    const controlledCounter = Array.from({ length: 21 * 4 + 1 }, (_, idx) => ({
      t: new Date(Date.UTC(2025, 11, 31, 23, 0, 0) + idx * 6 * HOUR_MS).toISOString(),
      v: 1000 + (idx / 4) * 25, // 25 kWh/day controlled
    }));
    const { collector, store, persisted } = buildHarness({
      isManagedDevice: vi.fn((id: string) => id === 'therm-1'),
      getDailyKwh: vi.fn(() => ({ total: 40, controlled: 25, uncontrolled: 15 })),
      fetchInsights: vi.fn(async (path: string) => {
        if (path === 'manager/devices/device') return { 'therm-1': { id: 'therm-1', capabilities: ['meter_power'] } };
        if (path.includes('therm-1:meter_power')) return { step: 6 * HOUR_MS, values: controlledCounter };
        return { step: 6 * HOUR_MS, values: [] };
      }),
    });
    // Temp + meter backfills already done (markers set) → only the split runs.
    persisted.value = {
      records: splitRecords, backfilledDeviceId: 'out-1', backfillVersion: 2, meterKwhBackfillDone: true,
    };
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    collector.stop();
    const written = lastWritten(store);
    expect(written.controlledBackfillVersion).toBe(1);
    const day = written.records.find((record) => record.dateKey === '2026-01-10');
    expect(day?.kwhControlled).toBeCloseTo(25, 6);
    expect(day?.kwhUncontrolled).toBeCloseTo(15, 6);
  });

  it('does NOT start the controlled split while a stale temperature backfill is about to re-run', async () => {
    // meterKwhBackfillDone is stale-true but backfillVersion is old → the temp
    // backfill will re-run and clear markers; the controlled split must wait.
    const fetchInsights = vi.fn(async () => ({ step: 6 * HOUR_MS, values: [] }));
    const { collector, store, persisted } = buildHarness({
      isManagedDevice: vi.fn(() => true),
      fetchInsights,
    });
    persisted.value = {
      records: [{
        dateKey: '2025-12-01',
        kwhTotal: 40,
        tempMeanC: 0,
        tempMinC: -2,
        tempMaxC: 2,
        tempSampleCount: 4,
        quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: true, kwhBackfilled: true },
      }],
      backfilledDeviceId: 'out-1',
      backfillVersion: 1, // stale vs TEMP_BACKFILL_VERSION (2) → temp re-runs
      meterKwhBackfillDone: true,
    };
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    collector.stop();
    // The controlled split never reached its device sweep, and never stamped.
    const deviceListFetched = fetchInsights.mock.calls.some(([path]) => path === 'manager/devices/device');
    expect(deviceListFetched).toBe(false);
    expect(lastWritten(store).controlledBackfillVersion).toBeUndefined();
  });

  it('chains the meter kWh backfill after the temperature backfill and reconciles every record', async () => {
    const recomputeDerived = vi.fn((state: WeatherHistoryState) => state);
    const { collector, store } = buildHarness({
      getDailyKwh: vi.fn(trackerKwhForMeterDays),
      recomputeDerived,
      fetchInsights: vi.fn(async (path: string) => {
        if (path === 'manager/devices/device') return METER_DEVICES;
        if (path.includes('meter-1:meter_power.imported')) return { step: 6 * HOUR_MS, values: meterCounterValues() };
        return path.includes('lastYear')
          ? { step: 6 * HOUR_MS, values: meterTempPoints() }
          : { step: 6 * HOUR_MS, values: [] };
      }),
    });
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    collector.stop();
    const written = lastWritten(store);
    expect(written.backfilledDeviceId).toBe('out-1');
    expect(written.meterKwhBackfillDone).toBe(true);
    expect(written.meterKwhDeviceId).toBe('meter-1');
    expect(written.kwhPurgeVersion).toBe(1);
    // The two pre-tracker days were filled from the validated meter…
    const oldest = written.records.find((record) => record.dateKey === meterDateKey(0));
    expect(oldest?.kwhTotal).toBeCloseTo(40, 6);
    expect(oldest?.quality).toMatchObject({ missingKwh: false, kwhBackfilled: true });
    // …while tracker-covered days stay tracker-sourced.
    const trackerDay = written.records.find((record) => record.dateKey === TRACKER_FROM);
    expect(trackerDay?.kwhTotal).toBe(40);
    expect(trackerDay?.quality.kwhBackfilled).toBeUndefined();
    expect(recomputeDerived).toHaveBeenCalled();
  });

  it('purges legacy kWh once on a conclusive no-candidate election, then stamps', async () => {
    const points = sixHourZeroPoints(Date.UTC(2026, 0, 4, 23, 0, 0));
    const devicesPaths: string[] = [];
    const { collector, store, persisted, logger } = buildHarness({
      getDailyKwh: vi.fn(() => ({})),
      fetchInsights: vi.fn(async (path: string) => {
        if (path === 'manager/devices/device') {
          devicesPaths.push(path);
          return {}; // no meter exists on this home
        }
        return path.includes('lastYear')
          ? { step: 6 * HOUR_MS, values: points }
          : { step: 6 * HOUR_MS, values: [] };
      }),
    });
    // A contaminated no-meter install: a legacy Energy-report fill
    // (reconstructed record, unflagged kWh) and no completed meter pass.
    persisted.value = {
      records: [{
        dateKey: '2025-03-01',
        kwhTotal: 19.5,
        tempMeanC: 1,
        tempMinC: 0,
        tempMaxC: 2,
        tempSampleCount: 4,
        quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: true },
      }],
      backfilledDeviceId: 'old-device',
      backfillVersion: 2,
    };
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    collector.stop();
    const written = lastWritten(store);
    expect(written.backfilledDeviceId).toBe('out-1');
    expect(devicesPaths.length).toBeGreaterThan(0);
    // No comparable source: the marker must stay unset for retry.
    expect(written.meterKwhBackfillDone).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'weather_meter_backfill_no_source' }));
    // Even without a successor source, the retired source's values must not
    // keep feeding the fit — the conclusive no-candidate election purges them.
    const legacy = written.records.find((record) => record.dateKey === '2025-03-01');
    expect(legacy?.kwhTotal).toBeUndefined();
    expect(legacy?.quality.missingKwh).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'weather_kwh_legacy_purged', strippedDays: 1 }),
    );
    // The purge is one-shot: the stamp lands with it.
    expect(written.kwhPurgeVersion).toBe(1);
  });

  it('drops a latched meter marker when the temperature backfill completes for a new device', async () => {
    const points = sixHourZeroPoints(Date.UTC(2026, 0, 4, 23, 0, 0));
    const { collector, store, persisted } = buildHarness({
      getDailyKwh: vi.fn(() => ({})),
      fetchInsights: vi.fn(async (path: string) => {
        if (path === 'manager/devices/device') return {}; // old meter is gone
        return path.includes('lastYear')
          ? { step: 6 * HOUR_MS, values: points }
          : { step: 6 * HOUR_MS, values: [] };
      }),
    });
    persisted.value = {
      records: [],
      backfilledDeviceId: 'old-device',
      backfillVersion: 2,
      meterKwhBackfillDone: true,
      meterKwhDeviceId: 'meter-1',
      kwhPurgeVersion: 1,
    };
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    collector.stop();
    const written = lastWritten(store);
    expect(written.backfilledDeviceId).toBe('out-1');
    // The record set changed: the kWh layer must re-resolve at next chance.
    expect(written.meterKwhBackfillDone).toBeUndefined();
    expect(written.meterKwhDeviceId).toBeUndefined();
  });

  it('never re-strips aged tracker-joined kWh once the purge stamp is set', async () => {
    // A no-meter install: the tracker joined kWh into this reconstructed
    // record at backfill time (unflagged), and has since pruned the day.
    const { collector, store, logger, persisted } = buildHarness({
      getDailyKwh: vi.fn(() => ({})),
      fetchInsights: vi.fn(async (path: string) => (
        path === 'manager/devices/device' ? {} : { step: 6 * HOUR_MS, values: [] }
      )),
    });
    persisted.value = {
      records: [{
        dateKey: '2025-03-01',
        kwhTotal: 41,
        tempMeanC: 1,
        tempMinC: 0,
        tempMaxC: 2,
        tempSampleCount: 4,
        quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: true },
      }],
      backfilledDeviceId: 'out-1',
      backfillVersion: 2,
      kwhPurgeVersion: 1,
    };
    collector.start();
    await vi.advanceTimersByTimeAsync(30_000);
    collector.stop();
    const written = lastWritten(store);
    expect(written.records[0].kwhTotal).toBe(41);
    expect(written.records[0].quality.missingKwh).toBe(false);
    expect(logger.info).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'weather_kwh_legacy_purged' }));
  });

  it('stamps the purge version on states from before the stamp existed (latched meter pass)', async () => {
    const { collector, store, persisted } = buildHarness({
      fetchInsights: vi.fn(async () => ({ step: 6 * HOUR_MS, values: [] })),
    });
    persisted.value = {
      records: [],
      backfilledDeviceId: 'out-1',
      backfillVersion: 2,
      meterKwhBackfillDone: true,
      meterKwhDeviceId: 'meter-1',
    };
    collector.start();
    await vi.advanceTimersByTimeAsync(30_000);
    collector.stop();
    expect(lastWritten(store).kwhPurgeVersion).toBe(1);
  });

  it('re-runs a completed temperature backfill when the stitch version is outdated', async () => {
    const points = sixHourZeroPoints(Date.UTC(2026, 0, 4, 23, 0, 0));
    const { collector, store, persisted } = buildHarness({
      getDailyKwh: vi.fn(() => ({})),
      fetchInsights: vi.fn(async (path: string) => (
        path.includes('lastYear') ? { step: 6 * HOUR_MS, values: points } : { step: 6 * HOUR_MS, values: [] }
      )),
    });
    // Completed under the version-1 stitch (no thisYear window, no version field).
    persisted.value = { records: [], backfilledDeviceId: 'out-1' };
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    collector.stop();
    const written = lastWritten(store);
    expect(written.backfillVersion).toBe(2);
    expect(written.records.map((record) => record.dateKey)).toEqual(['2026-01-05']);
  });

  it('re-kicks a superseded in-flight meter run on the new generation', async () => {
    let releaseFirst: (() => void) | undefined;
    let devicesCalls = 0;
    const { collector, store, persisted } = buildHarness({
      getDailyKwh: vi.fn(trackerKwhForMeterDays),
      fetchInsights: vi.fn(async (path: string) => {
        if (path === 'manager/devices/device') {
          devicesCalls += 1;
          if (devicesCalls === 1) {
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          }
          return METER_DEVICES;
        }
        if (path.includes('meter-1:meter_power.imported')) return { step: 6 * HOUR_MS, values: meterCounterValues() };
        return { step: 6 * HOUR_MS, values: [] };
      }),
    });
    persisted.value = { records: meterSeededRecords(), backfilledDeviceId: 'out-1', backfillVersion: 2 };
    collector.start();
    await vi.advanceTimersByTimeAsync(0); // first meter run now pending
    collector.start(); // reload supersedes it; its own trigger is blocked
    await vi.advanceTimersByTimeAsync(0);
    releaseFirst?.();
    await vi.advanceTimersByTimeAsync(0); // discard + finally re-kick
    await vi.advanceTimersByTimeAsync(30_000);
    collector.stop();
    expect(devicesCalls).toBeGreaterThanOrEqual(2);
    const written = lastWritten(store);
    const oldest = written.records.find((record) => record.dateKey === meterDateKey(0));
    expect(oldest).toMatchObject({ kwhTotal: 40, quality: { missingKwh: false, kwhBackfilled: true } });
    expect(written.meterKwhBackfillDone).toBe(true);
  });

  it('applies a partial meter run but keeps the marker unset for retry', async () => {
    const { collector, store, persisted } = buildHarness({
      getDailyKwh: vi.fn(trackerKwhForMeterDays),
      fetchInsights: vi.fn(async (path: string) => {
        if (path === 'manager/devices/device') return METER_DEVICES;
        if (path.includes('resolution=lastYear')) throw new Error('HTTP 500: boom');
        if (path.includes('meter-1:meter_power.imported')) return { step: 6 * HOUR_MS, values: meterCounterValues() };
        return { step: 6 * HOUR_MS, values: [] };
      }),
    });
    persisted.value = { records: meterSeededRecords(), backfilledDeviceId: 'out-1', backfillVersion: 2 };
    collector.start();
    await vi.advanceTimersByTimeAsync(30_000);
    collector.stop();
    const written = lastWritten(store);
    const oldest = written.records.find((record) => record.dateKey === meterDateKey(0));
    expect(oldest).toMatchObject({ kwhTotal: 40, quality: { missingKwh: false, kwhBackfilled: true } });
    expect(written.meterKwhBackfillDone).toBeUndefined();
    // An incomplete run must not stamp the one-shot purge either.
    expect(written.kwhPurgeVersion).toBeUndefined();
  });

  it('logs and leaves the backfill marker unset when Insights reads fail', async () => {
    const { collector, store, logger } = buildHarness({
      fetchInsights: vi.fn(async () => {
        throw new Error('insights down');
      }),
    });
    collector.start();
    await vi.advanceTimersByTimeAsync(30_000);
    collector.stop();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'weather_backfill_failed' }));
    expect(lastWritten(store).backfilledDeviceId).toBeUndefined();
  });

  it('exposes the latest outdoor temperature while running, never past staleness', async () => {
    const { collector } = buildHarness();
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(collector.getCurrentOutdoorTemperatureC()).toBe(3.5);
    collector.stop();
    vi.setSystemTime(START_MS + 3 * HOUR_MS);
    expect(collector.getCurrentOutdoorTemperatureC()).toBeUndefined();
  });

  it('stops exposing the covariate immediately after a disable-reload', async () => {
    const settings = vi.fn(() => ({ enabled: true, outdoorDeviceId: 'out-1' } as
      ReturnType<WeatherCollectorDeps['getSettings']>));
    const { collector } = buildHarness({ getSettings: settings });
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(collector.getCurrentOutdoorTemperatureC()).toBe(3.5);
    // Flag flipped off; the settings handler restarts the collector.
    settings.mockReturnValue({ enabled: false });
    collector.start();
    expect(collector.getCurrentOutdoorTemperatureC()).toBeUndefined();
  });
});
