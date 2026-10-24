import { afterEach, describe, expect, it, vi } from 'vitest';
import { PvForecastController } from '../../setup/appInit/createPvForecastService';
import type { PvForecastControllerCtx } from '../../lib/solar/pvForecastController';
import type { PvForecastServiceState } from '../../lib/solar/pvForecastService';
import type { PvForecastStateRead, PvForecastStore } from '../../lib/solar/pvForecastStore';
import { createPvForecastStateStore } from '../../lib/solar/pvForecastStateStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';

const HOUR_MS = 3_600_000;

const flushMicro = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const radiationOk = { ok: true, json: async () => ({ hourly: { time: [], shortwave_radiation: [] } }) };

/** A store whose reads answer `reads` in turn (the last one repeating), keeping what is written. */
const scriptedStore = (reads: PvForecastStateRead[]) => {
  const written: PvForecastServiceState[] = [];
  let index = 0;
  const store: PvForecastStore = {
    read: () => reads[Math.min(index++, reads.length - 1)]!,
    write: (state) => { written.push(state); },
  };
  return { store, written };
};

/** The real userdata store, on a database of its own. */
const userdataStore = () => createPvForecastStateStore(openUserdataDatabase(IN_MEMORY_DATABASE));

const makeCtx = (overrides: Partial<PvForecastControllerCtx> = {}): PvForecastControllerCtx => ({
  // A store that never answers, so persistence-agnostic tests never write.
  store: scriptedStore([{ kind: 'unreadable' }]).store,
  userAgent: 'pels-test',
  getNowMs: () => 0,
  readCoordinates: async () => ({
    kind: 'resolved',
    coordinates: { latitude: 59.91, longitude: 10.75 },
  }),
  logger: { info: vi.fn(), warn: vi.fn() },
  ...overrides,
});

describe('PvForecastController', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('stays dormant on a zero sample and arms on the first positive generation', async () => {
    const fetchMock = vi.fn(async () => radiationOk);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new PvForecastController(makeCtx());

    controller.recordSample(0, 1000); // night-time zero ⇒ still dormant, no network
    await flushMicro();
    expect(fetchMock).not.toHaveBeenCalled();

    controller.recordSample(500, 2000); // first real production ⇒ arms + refreshes
    await flushMicro();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores an unknown (undefined) generation sample', async () => {
    const fetchMock = vi.fn(async () => radiationOk);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new PvForecastController(makeCtx());
    controller.recordSample(undefined, 1000);
    await flushMicro();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('refresh-completion hook (setOnRefreshed)', () => {
    // Non-empty radiation payload ⇒ the provider refresh outcome is 'ok'.
    const radiationWithData = {
      ok: true,
      json: async () => ({ hourly: { time: [1_600_000_000], shortwave_radiation: [100] } }),
    };

    it('invokes the hook after each successful provider refresh', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => radiationWithData));
      const controller = new PvForecastController(makeCtx());
      const onRefreshed = vi.fn();
      controller.setOnRefreshed(onRefreshed);

      controller.recordSample(500, 1000); // arms ⇒ triggers the first refresh
      await flushMicro();
      expect(onRefreshed).toHaveBeenCalledTimes(1);

      await controller.refresh();
      expect(onRefreshed).toHaveBeenCalledTimes(2);
    });

    it('does not invoke the hook when the provider refresh fails or throws', async () => {
      // Empty radiation arrays parse to nothing ⇒ provider outcome 'failed'.
      vi.stubGlobal('fetch', vi.fn(async () => radiationOk));
      const failing = new PvForecastController(makeCtx());
      const onFailedRefresh = vi.fn();
      failing.setOnRefreshed(onFailedRefresh);
      failing.recordSample(500, 1000);
      await flushMicro();
      await failing.refresh();
      expect(onFailedRefresh).not.toHaveBeenCalled();

      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
      const throwing = new PvForecastController(makeCtx());
      const onThrownRefresh = vi.fn();
      throwing.setOnRefreshed(onThrownRefresh);
      throwing.recordSample(500, 1000);
      await flushMicro();
      await expect(throwing.refresh()).resolves.toBeUndefined(); // failure is swallowed
      expect(onThrownRefresh).not.toHaveBeenCalled();
    });

    it('a refresh that completed before registration does not fire the hook retroactively', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => radiationWithData));
      const controller = new PvForecastController(makeCtx());
      controller.recordSample(500, 1000); // successful refresh, no hook registered yet
      await flushMicro();

      const onRefreshed = vi.fn();
      controller.setOnRefreshed(onRefreshed);
      expect(onRefreshed).not.toHaveBeenCalled(); // only future refreshes fire it

      await controller.refresh();
      expect(onRefreshed).toHaveBeenCalledTimes(1);
    });

    it('stays silent while dormant (refresh is a no-op before the first positive sample)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => radiationWithData));
      const controller = new PvForecastController(makeCtx());
      const onRefreshed = vi.fn();
      controller.setOnRefreshed(onRefreshed);
      await controller.refresh();
      expect(onRefreshed).not.toHaveBeenCalled();
    });

    it('never fires after stop() — an in-flight fetch resolving post-teardown is dropped', async () => {
      let resolveFetch: (value: unknown) => void = () => {};
      vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; })));
      const controller = new PvForecastController(makeCtx());
      const onRefreshed = vi.fn();
      controller.setOnRefreshed(onRefreshed);

      controller.recordSample(500, 1000); // arms ⇒ refresh parked on the in-flight fetch
      controller.stop(); // app uninit while the Open-Meteo fetch is still in flight
      resolveFetch(radiationWithData); // fetch lands AFTER teardown
      await flushMicro();

      expect(onRefreshed).not.toHaveBeenCalled();
      await controller.refresh(); // and any later refresh call is a no-op too
      expect(onRefreshed).not.toHaveBeenCalled();
    });
  });

  it('finiteness-gates netPowerW at the boundary; a finite signed net persists as the anchor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => radiationOk));
    const store = userdataStore();
    const controller = new PvForecastController(makeCtx({ store }));
    const lastNetW = () => {
      const read = store.read();
      return read.kind === 'loaded' ? read.state.history.lastNetW : 'not loaded';
    };

    controller.recordSample(500, 1000, Number.NaN); // junk net must not anchor
    controller.stop(); // persists the dirty state
    expect(lastNetW()).toBeUndefined();

    controller.recordSample(600, 2000, -250); // finite SIGNED net (export) threads through
    controller.stop();
    expect(lastNetW()).toBe(-250);
    await flushMicro(); // let the arming refresh settle before teardown
  });

  it('emits trainingMode in the pv_forecast_learned structured log', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => radiationOk));
    // Seed 30 complete legacy daylight hours (no net evidence) ⇒ boot-armed
    // controller learns via the unsegmented median.
    const startMs = Date.UTC(2026, 5, 1, 8, 0, 0);
    const hourly: Record<string, { kwh: number; coveredMs: number }> = {};
    const irradianceByHour: Record<string, number> = {};
    for (let h = 0; h < 30; h += 1) {
      hourly[String(startMs + h * HOUR_MS)] = { kwh: 0.3, coveredMs: HOUR_MS };
      irradianceByHour[String(startMs + h * HOUR_MS)] = 600;
    }
    const store = userdataStore();
    store.write({ history: { lastSampleMs: startMs + 40 * HOUR_MS, hourly }, irradianceByHour });
    const info = vi.fn();
    const controller = new PvForecastController(makeCtx({ store, logger: { info, warn: vi.fn() } }));
    await controller.refresh();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'pv_forecast_learned',
      trainingMode: 'unsegmented_median',
      confidence: 'low',
    }));
  });

  it('swallows a persistence failure — logs it, never throws', () => {
    const warn = vi.fn();
    const controller = new PvForecastController(makeCtx({
      store: { read: () => ({ kind: 'absent' }), write: () => { throw new Error('disk full'); } },
      logger: { info: vi.fn(), warn },
    }));
    controller.recordSample(500, 1000); // marks the state dirty
    expect(() => controller.stop()).not.toThrow(); // stop ⇒ persist ⇒ write throws ⇒ caught
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'pv_forecast_persist_failed' }));
  });

  it('persists an empty store on the first persist, with no window to wait out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => radiationOk));
    // No rows is the store's affirmative answer: nothing recorded, nothing to protect.
    const store = userdataStore();
    const controller = new PvForecastController(makeCtx({ store }));
    controller.recordSample(500, 1000);
    controller.stop();
    expect(store.read().kind).toBe('loaded');
    await flushMicro();
  });

  it('recovers learned history after an unreadable boot read, merging it under live accruals', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => radiationOk));
    // Months of learned history are stored, but the boot read throws; every
    // later read answers. The write is deferred until a read answers, and the
    // stored history is merged under the live state, never overwritten by it.
    const startMs = Date.UTC(2026, 5, 1, 8, 0, 0);
    const bootHourMs = startMs + 30 * HOUR_MS; // crash + restart fall inside this hour
    const hourly: Record<string, { kwh: number; coveredMs: number }> = {};
    for (let h = 0; h < 30; h += 1) hourly[String(startMs + h * HOUR_MS)] = { kwh: 0.3, coveredMs: HOUR_MS };
    // The pre-crash persist recorded 20 min of the boot hour; the cursor sits there.
    hourly[String(bootHourMs)] = { kwh: 0.5, coveredMs: 20 * 60_000 };
    const persisted = { history: { lastSampleMs: bootHourMs + 20 * 60_000, hourly }, irradianceByHour: {} };
    const { store, written } = scriptedStore([{ kind: 'unreadable' }, { kind: 'loaded', state: persisted }]);
    const info = vi.fn();
    const controller = new PvForecastController(makeCtx({ store, logger: { info, warn: vi.fn() } }));

    controller.recordSample(1000, bootHourMs + 22 * 60_000); // arms + anchors the live cursor post-restart
    controller.recordSample(1000, bootHourMs + 23 * 60_000); // accrues a LIVE bucket in the boot hour
    await flushMicro(); // let the arming refresh settle
    controller.stop(); // stop ⇒ persist ⇒ the re-read answers ⇒ merge, never clobber

    // The write carries the RECOVERED months of history, with the LIVE accrual
    // winning the boot hour both sides recorded, and that hour TAINTED: the
    // crash hole between the recovered cursor and the first live sample is
    // invisible to the recorder, so the boundary hour must never train.
    const last = written.at(-1)!;
    expect(Object.keys(last.history.hourly).length).toBe(31);
    expect(last.history.hourly[String(startMs)]).toEqual({ kwh: 0.3, coveredMs: HOUR_MS }); // recovered fills
    expect(last.history.hourly[String(bootHourMs)]?.coveredMs).toBe(60_000); // live accrual wins the overlap
    expect(last.history.hourly[String(bootHourMs)]?.kwh).toBeCloseTo(1000 * 60_000 / 3_600_000 / 1000, 6);
    expect(last.history.lastSampleMs).toBe(bootHourMs + 23 * 60_000); // the live cursor survives the merge
    expect(last.history.taintedHourStarts?.[String(bootHourMs)]).toBe(true); // restart-hole taint
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: 'pv_forecast_state_recovered' }));
  });

  it('defers the write for as long as the store keeps failing to read, and never throws', () => {
    const info = vi.fn();
    const { store, written } = scriptedStore([{ kind: 'unreadable' }]);
    const controller = new PvForecastController(makeCtx({ store, logger: { info, warn: vi.fn() } }));
    controller.recordSample(600, 1000); // arms + marks dirty
    expect(() => controller.stop()).not.toThrow();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: 'pv_forecast_persist_skipped_grace' }));
    expect(written).toHaveLength(0);
  });

  it('an unreadable boot read recovers on a persist tick even before any sample arrives (dirty=false)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => radiationOk);
    vi.stubGlobal('fetch', fetchMock);
    // Night restart: the boot read fails, and no generation sample sets the
    // dirty flag for hours. Recovery must not wait for dirtiness — every tick
    // re-reads until the store answers.
    const startMs = Date.UTC(2026, 5, 1, 8, 0, 0);
    const hourly: Record<string, { kwh: number; coveredMs: number }> = {};
    for (let h = 0; h < 30; h += 1) hourly[String(startMs + h * HOUR_MS)] = { kwh: 0.3, coveredMs: HOUR_MS };
    const { store, written } = scriptedStore([
      { kind: 'unreadable' }, { kind: 'loaded', state: { history: { hourly }, irradianceByHour: {} } },
    ]);
    const info = vi.fn();
    const controller = new PvForecastController(makeCtx({ store, logger: { info, warn: vi.fn() } }));
    // Drive a LIVE persist tick (not shutdown): recovery must run with
    // dirty=false, and the inactive→active transition must fetch irradiance
    // NOW — not at the 3-hour refresh tick (forecasts would stay dark).
    controller.start(); // the immediate start() refresh no-ops while dormant
    await flushMicro();
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000); // first persist interval tick
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'pv_forecast_state_recovered',
      recoveredHours: 30,
    }));
    expect(Object.keys(controller.service.getState().history.hourly).length).toBe(30);
    expect(written).toHaveLength(0); // nothing dirty ⇒ nothing written
    expect(fetchMock).toHaveBeenCalledTimes(1); // recovery armed the forecaster ⇒ immediate refresh
    controller.stop();
  });
});
