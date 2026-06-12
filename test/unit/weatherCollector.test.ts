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
    getDailyKwh: vi.fn(() => ({ total: 42.5, controlled: 10 })),
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

    const fetchCallsAfterFirstRun = (deps.fetchInsights as ReturnType<typeof vi.fn>).mock.calls.length;
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    collector.stop();
    expect((deps.fetchInsights as ReturnType<typeof vi.fn>).mock.calls.length).toBe(fetchCallsAfterFirstRun);
  });

  it('chains the Energy-report backfill after the temperature backfill and patches missing kWh', async () => {
    const points = [Date.UTC(2026, 0, 4, 23, 0, 0), Date.UTC(2026, 0, 5, 23, 0, 0)]
      .flatMap(sixHourZeroPoints);
    const recomputeDerived = vi.fn((state: WeatherHistoryState) => state);
    const { collector, store } = buildHarness({
      // No tracker kWh at all: the backfilled days arrive missingKwh.
      getDailyKwh: vi.fn(() => ({})),
      recomputeDerived,
      fetchInsights: vi.fn(async (path: string) => {
        if (path.startsWith('manager/energy/report/month')) {
          return path.includes('2026-01')
            ? { subReports: { '2026-01-05': { electricity: { consumedPeriod: 52.5 } } } }
            : { subReports: {} };
        }
        return path.includes('lastYear')
          ? { step: 6 * HOUR_MS, values: points }
          : { step: 6 * HOUR_MS, values: [] };
      }),
    });
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    collector.stop();
    const written = lastWritten(store);
    expect(written.backfilledDeviceId).toBe('out-1');
    expect(written.energyReportBackfillDone).toBe(true);
    const day5 = written.records.find((record) => record.dateKey === '2026-01-05');
    expect(day5).toMatchObject({ kwhTotal: 52.5, quality: { missingKwh: false } });
    // 2026-01-06 had no report entry: stays missing, but the run is complete.
    const day6 = written.records.find((record) => record.dateKey === '2026-01-06');
    expect(day6?.quality.missingKwh).toBe(true);
    expect(recomputeDerived).toHaveBeenCalled();
  });

  it('clears the energy marker when the temperature backfill lands for a new device', async () => {
    const points = sixHourZeroPoints(Date.UTC(2026, 0, 4, 23, 0, 0));
    const energyPaths: string[] = [];
    const { collector, store, persisted } = buildHarness({
      getDailyKwh: vi.fn(() => ({})),
      fetchInsights: vi.fn(async (path: string) => {
        if (path.startsWith('manager/energy/report/month')) {
          energyPaths.push(path);
          return { subReports: { '2026-01-05': { electricity: { consumedPeriod: 33 } } } };
        }
        return path.includes('lastYear')
          ? { step: 6 * HOUR_MS, values: points }
          : { step: 6 * HOUR_MS, values: [] };
      }),
    });
    // A previous device completed both passes; the user then switched devices.
    persisted.value = { records: [], backfilledDeviceId: 'old-device', energyReportBackfillDone: true };
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    collector.stop();
    const written = lastWritten(store);
    expect(written.backfilledDeviceId).toBe('out-1');
    expect(energyPaths.length).toBeGreaterThan(0);
    expect(written.records.find((record) => record.dateKey === '2026-01-05')?.kwhTotal).toBe(33);
    expect(written.energyReportBackfillDone).toBe(true);
  });

  it('does not latch the energy marker on an empty month span (clock skew)', async () => {
    const { collector, store, persisted, logger } = buildHarness({ getDailyKwh: vi.fn(() => ({})) });
    persisted.value = {
      records: [{
        dateKey: '2026-01-05',
        tempMeanC: 0,
        tempMinC: -1,
        tempMaxC: 1,
        tempSampleCount: 4,
        quality: { partialTemp: false, missingKwh: true, unreliablePower: false, backfilled: true },
      }],
      backfilledDeviceId: 'out-1',
    };
    // Pre-NTP boot: "today" lands before the oldest record.
    vi.setSystemTime(Date.UTC(2025, 11, 1, 10, 0, 0));
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    collector.stop();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'weather_energy_backfill_empty_span' }));
    expect(lastWritten(store).energyReportBackfillDone).toBeUndefined();
  });

  it('re-kicks a superseded in-flight energy run on the new generation', async () => {
    let releaseFirst: (() => void) | undefined;
    let energyCalls = 0;
    const { collector, store, persisted } = buildHarness({
      getDailyKwh: vi.fn(() => ({})),
      fetchInsights: vi.fn(async (path: string) => {
        if (path.startsWith('manager/energy/report/month')) {
          energyCalls += 1;
          if (energyCalls === 1) {
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          }
          return { subReports: { '2026-01-05': { electricity: { consumedPeriod: 41 } } } };
        }
        return { step: 6 * HOUR_MS, values: [] };
      }),
    });
    persisted.value = {
      records: [{
        dateKey: '2026-01-05',
        tempMeanC: 0,
        tempMinC: -1,
        tempMaxC: 1,
        tempSampleCount: 4,
        quality: { partialTemp: false, missingKwh: true, unreliablePower: false, backfilled: true },
      }],
      backfilledDeviceId: 'out-1',
    };
    collector.start();
    await vi.advanceTimersByTimeAsync(0); // first energy run now pending
    collector.start(); // reload supersedes it; its own trigger is blocked
    await vi.advanceTimersByTimeAsync(0);
    releaseFirst?.();
    await vi.advanceTimersByTimeAsync(0); // discard + finally re-kick
    await vi.advanceTimersByTimeAsync(30_000);
    collector.stop();
    expect(energyCalls).toBeGreaterThanOrEqual(2);
    const written = lastWritten(store);
    expect(written.records[0]).toMatchObject({ kwhTotal: 41, quality: { missingKwh: false } });
    expect(written.energyReportBackfillDone).toBe(true);
  });

  it('keeps the energy marker unset when a report month fails non-404', async () => {
    const points = sixHourZeroPoints(Date.UTC(2026, 0, 4, 23, 0, 0));
    const { collector, store } = buildHarness({
      getDailyKwh: vi.fn(() => ({})),
      fetchInsights: vi.fn(async (path: string) => {
        if (path.startsWith('manager/energy/report/month')) throw new Error('HTTP 500: boom');
        return path.includes('lastYear')
          ? { step: 6 * HOUR_MS, values: points }
          : { step: 6 * HOUR_MS, values: [] };
      }),
    });
    collector.start();
    await vi.advanceTimersByTimeAsync(30_000);
    collector.stop();
    expect(lastWritten(store).energyReportBackfillDone).toBeUndefined();
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
