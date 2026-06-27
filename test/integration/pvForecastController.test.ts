import { afterEach, describe, expect, it, vi } from 'vitest';
import { PvForecastController, type PvForecastControllerCtx } from '../../setup/appInit/createPvForecastService';

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
