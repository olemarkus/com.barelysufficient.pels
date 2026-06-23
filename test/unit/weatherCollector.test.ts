import type { Logger as PinoLogger } from 'pino';
import { WeatherCollector, type WeatherCollectorDeps } from '../../lib/weather/weatherCollector';
import type { MetDaySummaryWithCoverage, MetForecastFetchResult } from '../../lib/weather/metForecast';
import { CONTROLLED_BACKFILL_VERSION } from '../../lib/weather/weatherHistory';
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

  it('samples the outdoor device hourly (no forecast device path anymore)', async () => {
    const { collector, store, deps } = buildHarness();
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    // Only the outdoor device is read — the +24h forecast device is gone.
    expect(deps.readDevice).toHaveBeenCalledTimes(1);
    // Next sample at the top of the hour + 90 s.
    await vi.advanceTimersByTimeAsync(HOUR_MS + 90_000);
    expect(deps.readDevice).toHaveBeenCalledTimes(2);
    collector.stop();
    expect(lastWritten(store).accumulators?.['2026-01-10']?.count).toBe(2);
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

  // Auto-apply: at the midnight rollup, push the fresh suggestion to the daily
  // budget when opted in. recomputeDerived seeds the suggestion the step reads.
  const withFreshSuggestion = (state: WeatherHistoryState): WeatherHistoryState => ({
    ...state,
    latestFit: { model: 'uncorrelated' } as WeatherHistoryState['latestFit'],
    latestSuggestion: {
      targetDateKey: '2026-01-11', suggestedBudgetKwh: 48,
    } as WeatherHistoryState['latestSuggestion'],
  });

  it('auto-applies the suggested budget at rollup when opted in, and records the audit', async () => {
    const applySuggestedDailyBudget = vi.fn(() => true);
    vi.setSystemTime(Date.UTC(2026, 0, 10, 22, 30, 0)); // Oslo 23:30
    const { collector, store, logger } = buildHarness({
      recomputeDerived: vi.fn(withFreshSuggestion),
      applySuggestedDailyBudget,
      getSettings: vi.fn(() => ({ enabled: true, outdoorDeviceId: 'out-1', autoApplyDailyBudget: true })),
    });
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(36 * 60 * 1000); // past midnight rollup
    collector.stop();
    expect(applySuggestedDailyBudget).toHaveBeenCalledTimes(1);
    expect(applySuggestedDailyBudget).toHaveBeenCalledWith(48);
    expect(lastWritten(store).lastAutoApply).toMatchObject({ dateKey: '2026-01-11', kwh: 48 });
    expect(logger.info.mock.calls.some(([fields]) => (
      (fields as { event?: string })?.event === 'weather_advisor_budget_auto_applied'
    ))).toBe(true);
  });

  it('does not auto-apply when the opt-in is off', async () => {
    const applySuggestedDailyBudget = vi.fn(() => true);
    vi.setSystemTime(Date.UTC(2026, 0, 10, 22, 30, 0));
    const { collector, store } = buildHarness({
      recomputeDerived: vi.fn(withFreshSuggestion),
      applySuggestedDailyBudget,
      getSettings: vi.fn(() => ({ enabled: true, outdoorDeviceId: 'out-1', autoApplyDailyBudget: false })),
    });
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(36 * 60 * 1000);
    collector.stop();
    expect(applySuggestedDailyBudget).not.toHaveBeenCalled();
    expect(lastWritten(store).lastAutoApply).toBeUndefined();
  });

  it('records no audit when the daily budget is off (applier returns false)', async () => {
    const applySuggestedDailyBudget = vi.fn(() => false);
    vi.setSystemTime(Date.UTC(2026, 0, 10, 22, 30, 0));
    const { collector, store } = buildHarness({
      recomputeDerived: vi.fn(withFreshSuggestion),
      applySuggestedDailyBudget,
      getSettings: vi.fn(() => ({ enabled: true, outdoorDeviceId: 'out-1', autoApplyDailyBudget: true })),
    });
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(36 * 60 * 1000);
    collector.stop();
    expect(applySuggestedDailyBudget).toHaveBeenCalledWith(48);
    expect(lastWritten(store).lastAutoApply).toBeUndefined();
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
    // A v1 split marker is intentionally stale so the gross solar split migrates.
    persisted.value = {
      records: splitRecords,
      backfilledDeviceId: 'out-1',
      backfillVersion: 2,
      meterKwhBackfillDone: true,
      controlledBackfillVersion: 1,
    };
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    collector.stop();
    const written = lastWritten(store);
    expect(written.controlledBackfillVersion).toBe(CONTROLLED_BACKFILL_VERSION);
    const day = written.records.find((record) => record.dateKey === '2026-01-10');
    expect(day?.kwhControlled).toBeCloseTo(25, 6);
    expect(day?.kwhUncontrolled).toBeCloseTo(15, 6);
  });

  it('does NOT start the controlled split while a stale temperature backfill is about to re-run', async () => {
    // meterKwhBackfillDone is stale-true but backfillVersion is old → the temp
    // backfill will re-run and clear markers; the controlled split must wait.
    const fetchInsights = vi.fn(async (_path: string) => ({ step: 6 * HOUR_MS, values: [] }));
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

  it('defers the refit until the meter kWh layer settles — never on the temperature pass alone', async () => {
    // The temperature backfill upserts a year of records but kWh only for the
    // tracker-covered recent days; refitting there would persist a low-R²
    // recent-only signature. Hang the meter VALUE fetch so the chain pauses
    // after the temperature pass but before the kWh layer resolves.
    let releaseMeter: (() => void) | undefined;
    let meterHung = false;
    const recomputeDerived = vi.fn((state: WeatherHistoryState) => state);
    const { collector } = buildHarness({
      getDailyKwh: vi.fn(trackerKwhForMeterDays),
      recomputeDerived,
      fetchInsights: vi.fn(async (path: string) => {
        if (path === 'manager/devices/device') return METER_DEVICES;
        if (path.includes('meter-1:meter_power.imported')) {
          // The meter pass probes then fully pulls the same series; hang only
          // the first (probe) call so the chain pauses with the kWh unresolved.
          if (!meterHung) {
            meterHung = true;
            await new Promise<void>((resolve) => { releaseMeter = resolve; });
          }
          return { step: 6 * HOUR_MS, values: meterCounterValues() };
        }
        return path.includes('lastYear')
          ? { step: 6 * HOUR_MS, values: meterTempPoints() }
          : { step: 6 * HOUR_MS, values: [] };
      }),
    });
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    // Temperature pass done, meter pass blocked on its value fetch: no refit yet,
    // and the UI must read as still backfilling (not learning/ready).
    expect(recomputeDerived).not.toHaveBeenCalled();
    expect(collector.isBackfillRunning()).toBe(true);
    releaseMeter?.();
    await vi.advanceTimersByTimeAsync(0);
    // kWh settled → the fit is computed exactly once, on the full-year records.
    expect(recomputeDerived).toHaveBeenCalledTimes(1);
    collector.stop();
  });

  it('keeps the partial fills but defers the refit when the meter resolution is incomplete', async () => {
    // The meter validates on its probe + most windows, but one deep window fails,
    // so resolveMeterDailyKwh returns resolved with complete:false and the caller
    // leaves the marker unlatched for a next-boot retry. The kWh layer is not
    // settled, so the fit must NOT be recomputed on the partially-filled records
    // — the same transient-fit path this change removes — even though the partial
    // fills are still persisted.
    const recomputeDerived = vi.fn((state: WeatherHistoryState) => state);
    const { collector, store } = buildHarness({
      getDailyKwh: vi.fn(trackerKwhForMeterDays),
      recomputeDerived,
      fetchInsights: vi.fn(async (path: string) => {
        if (path === 'manager/devices/device') return METER_DEVICES;
        if (path.includes('meter-1:meter_power.imported')) {
          if (path.includes('resolution=thisYear')) throw new Error('deep window unreadable');
          return { step: 6 * HOUR_MS, values: meterCounterValues() };
        }
        return path.includes('lastYear')
          ? { step: 6 * HOUR_MS, values: meterTempPoints() }
          : { step: 6 * HOUR_MS, values: [] };
      }),
    });
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    collector.stop();
    const written = lastWritten(store);
    // Resolved-but-incomplete: marker stays unset for retry, partial meter fill kept…
    expect(written.meterKwhBackfillDone).toBeUndefined();
    expect(written.records.find((record) => record.dateKey === meterDateKey(0))?.kwhTotal).toBeCloseTo(40, 6);
    // …but no fit was computed on the still-unsettled kWh layer.
    expect(recomputeDerived).not.toHaveBeenCalled();
  });

  it('seeds the first fit on a no-meter home once the meter election concludes', async () => {
    // No cumulative meter exists, but the tracker joined kWh onto recent
    // backfilled days. The temperature pass no longer refits, so the meter
    // no-source handler must seed the first signature rather than leaving the
    // card on "learning" until the next midnight rollup.
    const recomputeDerived = vi.fn((state: WeatherHistoryState) => ({
      ...state,
      latestFit: { model: 'uncorrelated' } as WeatherHistoryState['latestFit'],
    }));
    const { collector, store } = buildHarness({
      getDailyKwh: vi.fn(trackerKwhForMeterDays),
      recomputeDerived,
      fetchInsights: vi.fn(async (path: string) => {
        if (path === 'manager/devices/device') return {}; // no meter on this home
        return path.includes('lastYear')
          ? { step: 6 * HOUR_MS, values: meterTempPoints() }
          : { step: 6 * HOUR_MS, values: [] };
      }),
    });
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    collector.stop();
    expect(recomputeDerived).toHaveBeenCalledTimes(1);
    expect(lastWritten(store).latestFit).toEqual({ model: 'uncorrelated' });
  });

  it('refits exactly once on a no-meter purge that lands below the fit threshold', async () => {
    // Purge strips a legacy day (changedDays > 0) but the result is still too
    // thin to fit, so recomputeDerived returns NO latestFit. The terminal refit
    // must fire once — not twice (a purge refit followed by a re-triggered seed
    // because latestFit stayed undefined), which would double the O(n²) pass and
    // duplicate the `weather_advisor_fit` log line.
    const recomputeDerived = vi.fn((state: WeatherHistoryState) => {
      const { latestFit: _drop, ...rest } = state;
      return rest; // sub-threshold data → fit stripped, latestFit stays undefined
    });
    const { collector, persisted } = buildHarness({
      getDailyKwh: vi.fn(() => ({})),
      recomputeDerived,
      fetchInsights: vi.fn(async (path: string) => (
        path === 'manager/devices/device'
          ? {} // no meter → conclusive no-candidate election
          : { step: 6 * HOUR_MS, values: [] }
      )),
    });
    // A contaminated legacy record (unflagged kWh, no tracker source) the
    // conclusive purge strips → changedDays > 0 with a still-thin usable set.
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
      backfilledDeviceId: 'out-1',
      backfillVersion: 2,
    };
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    collector.stop();
    expect(recomputeDerived).toHaveBeenCalledTimes(1);
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

  // ── MET forecast refresh ───────────────────────────────────────────────────
  // Collector clock: START_MS = Oslo 2026-01-10 11:00 → today 2026-01-10, tomorrow 2026-01-11.
  const TODAY_KEY = '2026-01-10';
  const TOMORROW_KEY = '2026-01-11';
  const metDay = (
    dateKey: string,
    overrides: Partial<MetDaySummaryWithCoverage> = {},
  ): MetDaySummaryWithCoverage => ({
    dateKey,
    meanTempC: -3,
    minTempC: -7,
    maxTempC: 1,
    eveningMinTempC: -6,
    eveningMeanTempC: -5,
    hourCount: 24,
    eveningHourCount: 7,
    fullDayCoverage: true,
    symbolCode: 'cloudy',
    precipMmTotal: 0.4,
    ...overrides,
  });
  /** A full per-day result covering today + tomorrow (what a fresh 200 produces). */
  const metDays = () => ({
    byDay: { [TODAY_KEY]: metDay(TODAY_KEY), [TOMORROW_KEY]: metDay(TOMORROW_KEY) },
  });
  /** A persisted cache covering both needed days, with overridable validators. */
  const cachedBothDays = (extra: Record<string, unknown> = {}) => ({
    byDay: { [TODAY_KEY]: metDay(TODAY_KEY, { meanTempC: -1 }), [TOMORROW_KEY]: metDay(TOMORROW_KEY, { meanTempC: -1 }) },
    fetchedAtMs: START_MS - HOUR_MS,
    ...extra,
  });

  it('stores a fresh MET forecast on ok and marks the state dirty', async () => {
    const fetchForecast = vi.fn(async (): Promise<MetForecastFetchResult> => ({
      outcome: 'ok',
      days: metDays(),
      expires: new Date(START_MS + 30 * 60 * 1000).toUTCString(),
      lastModified: 'Sat, 10 Jan 2026 09:00:00 GMT',
    }));
    const { collector, store } = buildHarness({ fetchForecast });
    collector.start();
    await vi.advanceTimersByTimeAsync(30_000);
    collector.stop();
    expect(fetchForecast).toHaveBeenCalledTimes(1);
    const cache = lastWritten(store).metForecast;
    expect(Object.keys(cache?.byDay ?? {}).sort()).toEqual([TODAY_KEY, TOMORROW_KEY]);
    expect(cache?.byDay[TOMORROW_KEY]).toMatchObject({
      dateKey: TOMORROW_KEY,
      meanTempC: -3,
      minTempC: -7,
      maxTempC: 1,
      eveningMinTempC: -6,
      symbolCode: 'cloudy',
    });
    // The fetch-time-only eveningHourCount is NOT persisted (matches the contract).
    expect(cache?.byDay[TOMORROW_KEY]).not.toHaveProperty('eveningHourCount');
    expect(cache?.lastModified).toBe('Sat, 10 Jan 2026 09:00:00 GMT');
    expect(cache?.fetchedAtMs).toBe(START_MS);
  });

  it('keeps the prior cached forecast on a failed fetch (transient-read discipline)', async () => {
    const fetchForecast = vi.fn(async (): Promise<MetForecastFetchResult> => ({ outcome: 'failed' }));
    const { collector, store, persisted, logger } = buildHarness({ fetchForecast });
    persisted.value = { records: [], metForecast: cachedBothDays() };
    collector.start();
    await vi.advanceTimersByTimeAsync(30_000);
    collector.stop();
    expect(lastWritten(store).metForecast?.byDay[TOMORROW_KEY]?.meanTempC).toBe(-1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'weather_met_forecast_unavailable', outcome: 'failed' }),
    );
  });

  it('keeps the prior cached forecast when the hub has no location', async () => {
    const fetchForecast = vi.fn(async (): Promise<MetForecastFetchResult> => ({ outcome: 'no_location' }));
    const { collector, store, persisted } = buildHarness({ fetchForecast });
    persisted.value = { records: [], metForecast: cachedBothDays({}) };
    collector.start();
    await vi.advanceTimersByTimeAsync(30_000);
    collector.stop();
    expect(lastWritten(store).metForecast?.byDay[TOMORROW_KEY]?.meanTempC).toBe(-1);
  });

  it('keeps the cached forecast unchanged on a 304 not_modified', async () => {
    const fetchForecast = vi.fn(async (): Promise<MetForecastFetchResult> => ({ outcome: 'not_modified' }));
    // Cached, covers both days, but already expired → a conditional refetch (304).
    const { collector, store, persisted } = buildHarness({ fetchForecast });
    persisted.value = {
      records: [],
      metForecast: cachedBothDays({
        expires: new Date(START_MS - 60_000).toUTCString(),
        lastModified: 'Sat, 10 Jan 2026 08:00:00 GMT',
      }),
    };
    collector.start();
    await vi.advanceTimersByTimeAsync(30_000);
    collector.stop();
    // Both days present → If-Modified-Since IS sent (refetch is for content-freshness).
    expect(fetchForecast).toHaveBeenCalledWith({ ifModifiedSince: 'Sat, 10 Jan 2026 08:00:00 GMT' });
    expect(lastWritten(store).metForecast?.byDay[TOMORROW_KEY]?.meanTempC).toBe(-1);
  });

  it('skips the fetch entirely while the cached Expires is in the future AND both days are present', async () => {
    const fetchForecast = vi.fn(async (): Promise<MetForecastFetchResult> => ({ outcome: 'ok', days: metDays() }));
    const { collector, persisted } = buildHarness({ fetchForecast });
    persisted.value = {
      records: [],
      metForecast: cachedBothDays({ expires: new Date(START_MS + 2 * HOUR_MS).toUTCString() }),
    };
    collector.start();
    // Boot refresh + hourly tick both fall inside the cached Expires window.
    await vi.advanceTimersByTimeAsync(HOUR_MS + 90_000);
    collector.stop();
    expect(fetchForecast).not.toHaveBeenCalled();
  });

  it('refetches on a day rollover even with Expires in the future (a needed day is missing)', async () => {
    // Fetched just before midnight: Expires outlives midnight, but the cache only
    // covers yesterday+today, so the now-needed tomorrow (2026-01-11) is missing.
    const fetchForecast = vi.fn(async (): Promise<MetForecastFetchResult> => ({
      outcome: 'ok', days: metDays(),
    }));
    const { collector, store, persisted } = buildHarness({ fetchForecast });
    persisted.value = {
      records: [],
      metForecast: {
        // Covers 2026-01-09 + 2026-01-10 — tomorrow (2026-01-11) is absent.
        byDay: { '2026-01-09': metDay('2026-01-09', { meanTempC: -1 }), [TODAY_KEY]: metDay(TODAY_KEY, { meanTempC: -1 }) },
        fetchedAtMs: START_MS - 60_000,
        expires: new Date(START_MS + 2 * HOUR_MS).toUTCString(), // still in the future
        lastModified: 'Sat, 10 Jan 2026 08:00:00 GMT',
      },
    };
    collector.start();
    await vi.advanceTimersByTimeAsync(30_000);
    collector.stop();
    // A missing needed day forces a 200 — If-Modified-Since is OMITTED (a 304 has
    // no body and could not rebuild byDay for the new tomorrow).
    expect(fetchForecast).toHaveBeenCalledWith({});
    // The stale cache was replaced with the fresh fetch covering today + tomorrow.
    expect(Object.keys(lastWritten(store).metForecast?.byDay ?? {}).sort()).toEqual([TODAY_KEY, TOMORROW_KEY]);
    expect(lastWritten(store).metForecast?.byDay[TOMORROW_KEY]?.meanTempC).toBe(-3);
  });

  it('advances the cache validators on a 304 without changing the summary', async () => {
    const newExpires = new Date(START_MS + 90 * 60 * 1000).toUTCString();
    const fetchForecast = vi.fn(async (): Promise<MetForecastFetchResult> => ({
      outcome: 'not_modified', expires: newExpires, lastModified: 'Sat, 10 Jan 2026 10:00:00 GMT',
    }));
    const { collector, store, persisted, logger } = buildHarness({ fetchForecast });
    persisted.value = {
      records: [],
      metForecast: cachedBothDays({
        expires: new Date(START_MS - 60_000).toUTCString(), // already lapsed → conditional refetch
        lastModified: 'Sat, 10 Jan 2026 08:00:00 GMT',
      }),
    };
    collector.start();
    await vi.advanceTimersByTimeAsync(30_000);
    collector.stop();
    const written = lastWritten(store).metForecast;
    // Temperature data unchanged; Expires/Last-Modified advanced so the next tick
    // is skipped (no "refreshed" log line for a 304 validators-only merge).
    expect(written?.byDay[TOMORROW_KEY]?.meanTempC).toBe(-1);
    expect(written).toMatchObject({ expires: newExpires, lastModified: 'Sat, 10 Jan 2026 10:00:00 GMT' });
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'weather_met_forecast_refreshed' }),
    );
  });

  it('discards the post-midnight rollup when stop() lands during the refresh', async () => {
    // Hold the midnight refresh open, stop() the collector while it's in flight,
    // then release: the continuation must NOT roll up or reschedule a timer on a
    // stopped collector (post-stop mutation / dirty drift). Only the rollup-path
    // refresh is armed to hang (earlier hourly/boot refreshes resolve fast so
    // they don't claim the single-flight first).
    let releaseRefresh: (() => void) | undefined;
    let armHang = false;
    const fetchForecast = vi.fn(async (): Promise<MetForecastFetchResult> => {
      if (armHang) {
        await new Promise<void>((resolve) => { releaseRefresh = resolve; });
      }
      return { outcome: 'failed' };
    });
    vi.setSystemTime(Date.UTC(2026, 0, 10, 22, 30, 0)); // Oslo 23:30 — close to midnight rollup
    const recomputeDerived = vi.fn((state: WeatherHistoryState) => state);
    const { collector, persisted, deps } = buildHarness({ fetchForecast, recomputeDerived });
    // No slept-through accumulator: the boot sample opens today's (2026-01-10),
    // which only the midnight rollup (not boot catch-up) will roll.
    persisted.value = { records: [], backfilledDeviceId: 'out-1' };
    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    expect((deps.getDailyKwh as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0); // boot rolled nothing
    // Let the hourly sample (+31.5 min) fire and resolve its refresh fast, so it
    // doesn't claim the single-flight before the rollup refresh.
    await vi.advanceTimersByTimeAsync(33 * 60 * 1000);
    // Arm the hang so the midnight rollup's (+35 min) refresh blocks on the gate.
    armHang = true;
    fetchForecast.mockClear();
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(releaseRefresh).toBeDefined(); // the rollup refresh is in flight
    // Stop the collector while the refresh is in flight, then release it.
    collector.stop();
    releaseRefresh?.();
    await vi.advanceTimersByTimeAsync(0);
    // The continuation bailed: today's accumulator was never rolled up
    // (getDailyKwh never called) and no timer was rescheduled.
    expect((deps.getDailyKwh as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('re-kicks a superseded in-flight MET refresh on the new generation', async () => {
    // A reload while the prior run's fetch is in flight: the new run's boot
    // refresh is blocked by the single-flight flag, so the superseded run's
    // finally must re-kick a fresh refresh for the new generation rather than
    // leaving it without MET until its next tick.
    let releaseFirst: (() => void) | undefined;
    let calls = 0;
    const fetchForecast = vi.fn(async (): Promise<MetForecastFetchResult> => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      return { outcome: 'ok', days: metDays() };
    });
    const { collector } = buildHarness({ fetchForecast });
    collector.start();
    await vi.advanceTimersByTimeAsync(0); // first (boot) refresh now hanging in flight
    collector.start(); // reload: new generation; its boot refresh is blocked by the in-flight flag
    await vi.advanceTimersByTimeAsync(0);
    releaseFirst?.(); // the superseded fetch resolves (discarded — generation moved)
    await vi.advanceTimersByTimeAsync(0); // its finally re-kicks the new generation's refresh
    collector.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
