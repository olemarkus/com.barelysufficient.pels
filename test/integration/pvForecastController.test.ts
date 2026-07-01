import { afterEach, describe, expect, it, vi } from 'vitest';
import { PvForecastController, type PvForecastControllerCtx } from '../../setup/appInit/createPvForecastService';
import { PV_FORECAST_STATE } from '../../lib/utils/settingsKeys';

const HOUR_MS = 3_600_000;

const flushMicro = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const radiationOk = { ok: true, json: async () => ({ hourly: { time: [], shortwave_radiation: [] } }) };

const makeCtx = (overrides: Partial<PvForecastControllerCtx> = {}): PvForecastControllerCtx => ({
  homey: {
    settings: { get: () => undefined, set: () => {} },
    geolocation: { getLatitude: () => 59.91, getLongitude: () => 10.75 },
  },
  userAgent: 'pels-test',
  getNowMs: () => 0,
  logger: { info: vi.fn(), warn: vi.fn() },
  ...overrides,
});

describe('PvForecastController', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
    const controller = new PvForecastController(makeCtx({
      homey: {
        settings: { get: (key) => stored.get(key), set: (key, value) => { stored.set(key, value); } },
        geolocation: {},
      },
    }));
    type PersistedHistory = { history?: { lastNetW?: number } } | undefined;

    controller.recordSample(500, 1000, Number.NaN); // junk net must not anchor
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
      homey: { settings: { get: () => seeded, set: () => {} }, geolocation: {} },
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
    const controller = new PvForecastController(makeCtx({
      homey: {
        settings: { get: () => undefined, set: () => { throw new Error('quota exceeded'); } },
        geolocation: {},
      },
      logger: { info: vi.fn(), warn },
    }));
    controller.recordSample(500, 1000); // marks the state dirty
    expect(() => controller.stop()).not.toThrow(); // stop ⇒ persist ⇒ set throws ⇒ caught
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'pv_forecast_persist_failed' }));
  });
});
