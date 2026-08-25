import { afterEach, describe, expect, it, vi } from 'vitest';
import { PvForecastController, type PvForecastControllerCtx } from '../../setup/appInit/createPvForecastService';
import { PV_FORECAST_STATE, PV_FORECAST_STATE_INITIALIZED } from '../../lib/utils/settingsKeys';

const HOUR_MS = 3_600_000;

const flushMicro = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const radiationOk = { ok: true, json: async () => ({ hourly: { time: [], shortwave_radiation: [] } }) };

const makeCtx = (overrides: Partial<PvForecastControllerCtx> = {}): PvForecastControllerCtx => ({
  homey: {
    // No blob, no marker, and an EMPTY key list: classified `unreadable` (an
    // empty list proves nothing), so persistence-agnostic tests run with the
    // grace armed and never write.
    settings: { get: () => undefined, set: () => {}, getKeys: () => [] },
  },
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
    const stored = new Map<string, unknown>();
    let now = 0;
    const controller = new PvForecastController(makeCtx({
      homey: {
        settings: {
          get: (key) => stored.get(key),
          set: (key, value) => { stored.set(key, value); },
          // A healthy list without the blob's key ⇒ the boot read proves a
          // fresh install (`absent`), so writes may proceed once the confirm
          // window is outlasted. An empty list would classify `unreadable`
          // and defer writes for the whole process (never by time).
          getKeys: () => ['pels_status', ...stored.keys()],
        },
      },
      getNowMs: () => now,
    }));
    type PersistedHistory = { history?: { lastNetW?: number } } | undefined;

    controller.recordSample(500, 1000, Number.NaN); // junk net must not anchor
    // Advance past the absent-confirm window so the clean-absent re-read lets
    // the first write proceed.
    now = 16 * 60 * 1000;
    controller.stop(); // persists the dirty state
    expect((stored.get(PV_FORECAST_STATE) as PersistedHistory)?.history?.lastNetW).toBeUndefined();

    controller.recordSample(600, 2000, -250); // finite SIGNED net (export) threads through
    controller.stop();
    expect((stored.get(PV_FORECAST_STATE) as PersistedHistory)?.history?.lastNetW).toBe(-250);
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
    const seeded = { history: { lastSampleMs: startMs + 40 * HOUR_MS, hourly }, irradianceByHour };
    const info = vi.fn();
    const controller = new PvForecastController(makeCtx({
      homey: { settings: { get: () => seeded, set: () => {}, getKeys: () => [PV_FORECAST_STATE] } },
      logger: { info, warn: vi.fn() },
    }));
    await controller.refresh();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'pv_forecast_learned',
      trainingMode: 'unsegmented_median',
      confidence: 'low',
    }));
  });

  it('swallows a persistence failure — logs it, never throws', () => {
    const warn = vi.fn();
    let now = 0;
    const controller = new PvForecastController(makeCtx({
      homey: {
        settings: {
          get: () => undefined,
          set: () => { throw new Error('quota exceeded'); },
          getKeys: () => ['pels_status'], // healthy list ⇒ boot proves `absent`
        },
      },
      getNowMs: () => now,
      logger: { info: vi.fn(), warn },
    }));
    controller.recordSample(500, 1000); // marks the state dirty
    // Advance past the absent-confirm window: within it the write is deferred
    // (re-read-before-overwrite), so the throw would never fire.
    now = 16 * 60 * 1000;
    expect(() => controller.stop()).not.toThrow(); // stop ⇒ persist ⇒ set throws ⇒ caught
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'pv_forecast_persist_failed' }));
  });

  it('recovers learned history after a transient empty boot read, merging it under live accruals', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => radiationOk));
    // Months of learned history live on disk (so the written-before marker is
    // set), but the FIRST blob read at boot transiently misses; every later
    // read returns the blob. The marker turns that miss into `unreadable`, so
    // the grace arms and the persist re-reads before writing.
    const startMs = Date.UTC(2026, 5, 1, 8, 0, 0);
    const bootHourMs = startMs + 30 * HOUR_MS; // crash + restart fall inside this hour
    const hourly: Record<string, { kwh: number; coveredMs: number }> = {};
    for (let h = 0; h < 30; h += 1) hourly[String(startMs + h * HOUR_MS)] = { kwh: 0.3, coveredMs: HOUR_MS };
    // The pre-crash persist recorded 20 min of the boot hour; the cursor sits there.
    hourly[String(bootHourMs)] = { kwh: 0.5, coveredMs: 20 * 60_000 };
    const persisted = { history: { lastSampleMs: bootHourMs + 20 * 60_000, hourly }, irradianceByHour: {} };
    let reads = 0;
    let lastWritten: unknown;
    const info = vi.fn();
    const controller = new PvForecastController(makeCtx({
      homey: {
        settings: {
          get: (key) => {
            if (key === PV_FORECAST_STATE_INITIALIZED) return true;
            if (key !== PV_FORECAST_STATE) return undefined;
            reads += 1;
            return reads === 1 ? undefined : persisted; // boot read misses, then heals
          },
          set: (key, value) => { if (key === PV_FORECAST_STATE) lastWritten = value; },
          getKeys: () => [PV_FORECAST_STATE, PV_FORECAST_STATE_INITIALIZED],
        },
      },
      logger: { info, warn: vi.fn() },
    }));

    controller.recordSample(1000, bootHourMs + 22 * 60_000); // arms + anchors the live cursor post-restart
    controller.recordSample(1000, bootHourMs + 23 * 60_000); // accrues a LIVE bucket in the boot hour
    await flushMicro(); // let the arming refresh settle
    controller.stop(); // stop ⇒ persist ⇒ re-read heals ⇒ merge, never clobber

    // The write must carry the RECOVERED months of history, never the near-empty
    // in-memory state the boot miss produced — with the LIVE accrual winning the
    // boot hour both sides recorded, and that hour TAINTED: the crash hole
    // between the recovered cursor and the first live sample is invisible to
    // the recorder, so the boundary hour must never train.
    const written = lastWritten as {
      history: {
        lastSampleMs: number;
        hourly: Record<string, { kwh: number; coveredMs: number }>;
        taintedHourStarts: Record<string, true>;
      };
    };
    expect(Object.keys(written.history.hourly).length).toBe(31);
    expect(written.history.hourly[String(startMs)]).toEqual({ kwh: 0.3, coveredMs: HOUR_MS }); // recovered fills
    expect(written.history.hourly[String(bootHourMs)]?.coveredMs).toBe(60_000); // live accrual wins the overlap
    expect(written.history.hourly[String(bootHourMs)]?.kwh).toBeCloseTo(1000 * 60_000 / 3_600_000 / 1000, 6);
    expect(written.history.lastSampleMs).toBe(bootHourMs + 23 * 60_000); // the live cursor survives the merge
    expect(written.history.taintedHourStarts[String(bootHourMs)]).toBe(true); // restart-hole taint
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: 'pv_forecast_state_recovered' }));
  });

  it('does not crash when the recovery re-read throws; keeps the grace armed and defers the write', () => {
    const info = vi.fn();
    const written: string[] = [];
    let reads = 0;
    const controller = new PvForecastController(makeCtx({
      homey: {
        settings: {
          get: (key) => {
            if (key === PV_FORECAST_STATE_INITIALIZED) return true; // marker: blob was written before
            if (key !== PV_FORECAST_STATE) return undefined;
            reads += 1;
            if (reads === 1) return undefined; // boot read misses ⇒ unreadable ⇒ arm grace
            throw new Error('transient settings failure'); // recovery re-read throws
          },
          set: (key) => { written.push(key); },
          getKeys: () => [PV_FORECAST_STATE, PV_FORECAST_STATE_INITIALIZED],
        },
      },
      logger: { info, warn: vi.fn() },
    }));
    controller.recordSample(600, 1000); // arms + marks dirty
    // persist ⇒ the recovery re-read throws inside the adapter, which classifies
    // it `unreadable` (never re-throws into the setInterval/stop path); the write
    // stays deferred within the grace so on-disk history is never overwritten.
    expect(() => controller.stop()).not.toThrow();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: 'pv_forecast_persist_skipped_grace' }));
    expect(written).not.toContain(PV_FORECAST_STATE);
  });

  it('a proven fresh install waits one confirming tick, then persists — not the full grace window', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => radiationOk));
    // No blob, no marker, and a healthy key list without the blob's key: a
    // proven fresh install. `absent` rests partly on the key list, so ONE
    // persist tick of suspicion buys a confirming re-read before the first
    // write; after that tick the write lands — well inside the 15-minute
    // window an `unreadable` read would still be deferring through.
    const stored = new Map<string, unknown>();
    const info = vi.fn();
    let now = 0;
    const controller = new PvForecastController(makeCtx({
      homey: {
        settings: {
          get: (key) => (stored.has(key) ? stored.get(key) : null),
          set: (key, value) => { stored.set(key, value); },
          getKeys: () => ['pels_status'],
        },
      },
      getNowMs: () => now,
      logger: { info, warn: vi.fn() },
    }));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: 'pv_forecast_boot_read', result: 'absent' }));
    controller.recordSample(500, 1000); // arms + marks dirty
    controller.stop(); // at now=0 — inside the one-tick confirm window ⇒ deferred
    expect(stored.has(PV_FORECAST_STATE)).toBe(false);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: 'pv_forecast_persist_skipped_grace' }));

    now = 6 * 60 * 1000; // past the confirm tick, far inside LOAD_GRACE_MS
    controller.stop(); // confirming re-read still absent ⇒ the write lands now
    expect(stored.has(PV_FORECAST_STATE)).toBe(true);
    expect(stored.get(PV_FORECAST_STATE_INITIALIZED)).toBe(true); // marker rides the first persist
    await flushMicro(); // let the arming refresh settle before teardown
  });

  it('an unreadable stretch discards absence confirmation — the window restarts at the transition', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => radiationOk));
    // Boot misclassifies a transient miss as `absent` (correlated lie across
    // blob get, marker get, and getKeys). The confirming re-read then comes
    // back `unreadable` because the SDK is sick again — ambiguity discards all
    // confirmation progress, and a SINGLE clean absent afterwards must not
    // open the write gate on the expired boot window: its own window starts at
    // the transition and needs a further spaced clean re-read.
    const written: string[] = [];
    const info = vi.fn();
    let now = 0;
    let blobReadThrows = false;
    const controller = new PvForecastController(makeCtx({
      homey: {
        settings: {
          get: (key) => {
            if (key === PV_FORECAST_STATE && blobReadThrows) throw new Error('sick again');
            return null; // blob, marker: absent
          },
          set: (key) => { written.push(key); },
          getKeys: () => ['pels_status'], // healthy list without the blob's key ⇒ boot classifies absent
        },
      },
      getNowMs: () => now,
      logger: { info, warn: vi.fn() },
    }));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: 'pv_forecast_boot_read', result: 'absent' }));
    controller.recordSample(500, 1000); // arms + marks dirty

    now = 6 * 60 * 1000; // PAST the 5-minute confirm window
    blobReadThrows = true; // …but the confirming re-read is ambiguous (read_threw)
    controller.stop();
    expect(written).not.toContain(PV_FORECAST_STATE); // deferred — ambiguity discards confirmation
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: 'pv_forecast_persist_skipped_grace' }));

    now = 7 * 60 * 1000;
    blobReadThrows = false; // a SINGLE clean absent right after the unreadable stretch
    controller.stop();
    expect(written).not.toContain(PV_FORECAST_STATE); // still deferred — its window starts HERE, not at boot

    now = 16 * 60 * 1000; // the clean absence has now outlasted its own window
    controller.stop(); // re-observed clean ⇒ confirmed ⇒ the write proceeds
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'pv_forecast_absence_confirmed',
      observed: 'absent',
    }));
    expect(written).toContain(PV_FORECAST_STATE);
    await flushMicro(); // let the arming refresh settle before teardown
  });

  it('a marker-only half-persist resolves writable after spaced confirming re-reads (un-wedge)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => radiationOk));
    // Marker landed, blob write crashed before landing, OOM before the retry:
    // every later boot sees marker-present + blob cleanly missing. This must
    // NOT defer forever (nothing recorded exists to protect), and must NOT
    // write on one glance either (a correlated get/getKeys lie fakes the same
    // shape) — it confirms across spaced re-reads, then writes.
    const written: string[] = [];
    const info = vi.fn();
    let now = 0;
    const controller = new PvForecastController(makeCtx({
      homey: {
        settings: {
          get: (key) => (key === PV_FORECAST_STATE_INITIALIZED ? true : null),
          set: (key) => { written.push(key); },
          getKeys: () => ['pels_status', PV_FORECAST_STATE_INITIALIZED], // healthy, blob key missing
        },
      },
      getNowMs: () => now,
      logger: { info, warn: vi.fn() },
    }));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'pv_forecast_boot_read',
      result: 'marker_only',
    }));
    controller.recordSample(500, 1000); // arms + marks dirty

    controller.stop(); // first re-observation at t=0 — window far from lapsed
    expect(written).not.toContain(PV_FORECAST_STATE);
    now = 8 * 60 * 1000;
    controller.stop(); // second spaced re-observation — still inside the window
    expect(written).not.toContain(PV_FORECAST_STATE);

    now = 16 * 60 * 1000; // consistently observed past the marker-only window
    controller.stop(); // confirmed ⇒ recoverable fresh start ⇒ the blob finally lands
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'pv_forecast_absence_confirmed',
      observed: 'marker_only',
    }));
    expect(written).toContain(PV_FORECAST_STATE);
    await flushMicro(); // let the arming refresh settle before teardown
  });

  it('a suspect boot read recovers on a persist tick even before any sample arrives (dirty=false)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => radiationOk);
    vi.stubGlobal('fetch', fetchMock);
    // Night restart: the boot read misses, and no generation sample sets the
    // dirty flag for hours. Recovery must not wait for dirtiness — every tick
    // re-reads while suspect, so the store heals long before the first write.
    const startMs = Date.UTC(2026, 5, 1, 8, 0, 0);
    const hourly: Record<string, { kwh: number; coveredMs: number }> = {};
    for (let h = 0; h < 30; h += 1) hourly[String(startMs + h * HOUR_MS)] = { kwh: 0.3, coveredMs: HOUR_MS };
    const persisted = { history: { hourly }, irradianceByHour: {} };
    let reads = 0;
    const written: string[] = [];
    const info = vi.fn();
    const controller = new PvForecastController(makeCtx({
      homey: {
        settings: {
          get: (key) => {
            if (key === PV_FORECAST_STATE_INITIALIZED) return true;
            if (key !== PV_FORECAST_STATE) return undefined;
            reads += 1;
            return reads === 1 ? undefined : persisted; // boot read misses, then heals
          },
          set: (key) => { written.push(key); },
          getKeys: () => [PV_FORECAST_STATE, PV_FORECAST_STATE_INITIALIZED],
        },
      },
      logger: { info, warn: vi.fn() },
    }));
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

  it('a healed re-read with a genuinely EMPTY blob clears the suspicion — the store proved readable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => radiationOk));
    // Marker present, boot read misses, and the re-read answers with a real
    // but empty blob (a young install that persisted before any sun). There is
    // nothing to protect, so the write proceeds immediately — inside what the
    // grace window would otherwise defer through.
    const emptyBlob = { history: { hourly: {} }, irradianceByHour: {} };
    let reads = 0;
    const written: unknown[] = [];
    const info = vi.fn();
    const controller = new PvForecastController(makeCtx({
      homey: {
        settings: {
          get: (key) => {
            if (key === PV_FORECAST_STATE_INITIALIZED) return true;
            if (key !== PV_FORECAST_STATE) return undefined;
            reads += 1;
            return reads === 1 ? undefined : emptyBlob; // boot read misses, then heals empty
          },
          set: (key, value) => { if (key === PV_FORECAST_STATE) written.push(value); },
          getKeys: () => [PV_FORECAST_STATE, PV_FORECAST_STATE_INITIALIZED],
        },
      },
      logger: { info, warn: vi.fn() },
    }));
    controller.recordSample(500, 1000); // arms + marks dirty
    controller.stop(); // at now=0: recovery trusts the loaded-empty blob ⇒ write proceeds
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'pv_forecast_state_recovered',
      recoveredHours: 0,
    }));
    expect(written).toHaveLength(1);
    await flushMicro(); // let the arming refresh settle before teardown
  });

  it('a marker-vouched miss defers writes for the PROCESS LIFETIME until the store answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => radiationOk));
    // The blob read stays `unreadable` (marker vouches, blob missing) far past
    // every window: no clock may open the write gate — a time-bounded
    // abandonment would overwrite up to 90 days at the exact moment the SDK
    // heals. Only the store ANSWERING (here: healing into `loaded`) does.
    const startMs = Date.UTC(2026, 5, 1, 8, 0, 0);
    const hourly: Record<string, { kwh: number; coveredMs: number }> = {};
    for (let h = 0; h < 30; h += 1) hourly[String(startMs + h * HOUR_MS)] = { kwh: 0.3, coveredMs: HOUR_MS };
    const persisted = { history: { hourly }, irradianceByHour: {} };
    let healed = false;
    const written: unknown[] = [];
    const info = vi.fn();
    let now = 0;
    const controller = new PvForecastController(makeCtx({
      homey: {
        settings: {
          get: (key) => {
            if (key === PV_FORECAST_STATE_INITIALIZED) return true;
            if (key !== PV_FORECAST_STATE) return undefined;
            return healed ? persisted : null; // unreadable (marker-vouched miss) until healed
          },
          set: (key, value) => { if (key === PV_FORECAST_STATE) written.push(value); },
          getKeys: () => [PV_FORECAST_STATE, PV_FORECAST_STATE_INITIALIZED],
        },
      },
      getNowMs: () => now,
      logger: { info, warn: vi.fn() },
    }));
    controller.recordSample(500, startMs + 40 * HOUR_MS); // arms + marks dirty
    controller.stop(); // inside the window ⇒ deferred
    expect(written).toHaveLength(0);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: 'pv_forecast_persist_skipped_grace' }));

    now = 20 * 60 * 1000; // far past LOAD_GRACE_MS; the store is STILL unreadable
    controller.stop(); // >15 min of unreadable re-reads must not lapse into a wipe
    expect(written).toHaveLength(0);

    now = 21 * 60 * 1000;
    healed = true; // the SDK recovers exactly when a bounded window would have clobbered
    controller.stop(); // heals into `loaded` ⇒ merge + the write proceeds
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'pv_forecast_state_recovered',
      recoveredHours: 30,
    }));
    expect(written).toHaveLength(1);
    const finalWrite = written[0] as { history: { hourly: Record<string, unknown> } };
    expect(Object.keys(finalWrite.history.hourly).length).toBeGreaterThanOrEqual(30);
    await flushMicro(); // let the arming refresh settle before teardown
  });

  it('pre-marker upgrade: the key list vouches for the blob, so a boot miss heals into a merge', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => radiationOk));
    // An install that persisted history BEFORE the marker existed: no marker,
    // but `getKeys()` lists the blob's key. A transient boot miss must classify
    // `unreadable` (not fresh) so the recovery re-read can still merge the
    // history instead of overwriting it.
    const startMs = Date.UTC(2026, 5, 1, 8, 0, 0);
    const hourly: Record<string, { kwh: number; coveredMs: number }> = {};
    for (let h = 0; h < 30; h += 1) hourly[String(startMs + h * HOUR_MS)] = { kwh: 0.3, coveredMs: HOUR_MS };
    const persisted = { history: { lastSampleMs: startMs + 30 * HOUR_MS, hourly }, irradianceByHour: {} };
    let reads = 0;
    let lastWritten: unknown;
    const info = vi.fn();
    const controller = new PvForecastController(makeCtx({
      homey: {
        settings: {
          get: (key) => {
            if (key !== PV_FORECAST_STATE) return null; // marker genuinely absent (pre-marker install)
            reads += 1;
            return reads === 1 ? null : persisted; // boot read misses, then heals
          },
          set: (key, value) => { if (key === PV_FORECAST_STATE) lastWritten = value; },
          getKeys: () => [PV_FORECAST_STATE], // the key list still vouches for the blob
        },
      },
      logger: { info, warn: vi.fn() },
    }));
    controller.recordSample(600, startMs + 31 * HOUR_MS); // arms + marks dirty
    await flushMicro(); // let the arming refresh settle
    controller.stop(); // stop ⇒ persist ⇒ re-read heals ⇒ merge, never clobber

    const written = lastWritten as { history: { hourly: Record<string, unknown> } };
    expect(Object.keys(written.history.hourly).length).toBeGreaterThanOrEqual(30);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: 'pv_forecast_state_recovered' }));
  });
});
