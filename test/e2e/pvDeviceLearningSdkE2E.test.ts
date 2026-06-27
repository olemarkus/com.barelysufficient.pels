// SDK-boundary e2e: the app learns a PV device end-to-end, Open-Meteo mocked.
//
// Nothing internal is mocked. Recorded generation+irradiance history enters through
// the real persisted-state seam (`pv_forecast_state` settings); the irradiance
// forecast enters through the real Open-Meteo fetch (global `fetch`, stubbed); and a
// live generation sample is driven through the REAL power-sample pipeline. The whole
// wired stack runs in the app, and it is observed ONLY through external seams — the
// `pv_forecast_learned` STRUCTURED LOG the app emits, and the persisted state — never
// by reaching into app internals (per test/AGENTS.md).
//
// A learning run needs weeks of daylight hours, which can't be polled in real time,
// so the history is seeded (the SDK persisted-state seam) and the app learns the
// device's gain on boot. The live power-pipeline sample proves the recording path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { PV_FORECAST_STATE } from '../../lib/utils/settingsKeys';

const HOUR_MS = 3_600_000;
const OSLO = { latitude: 59.91, longitude: 10.75 };
const TRUE_GAIN = 0.00045; // kWh per (W/m²·h) — the device the app must learn

const irradianceAt = (hourStartMs: number): number => {
  const hourOfDay = Math.floor(hourStartMs / HOUR_MS) % 24;
  const x = (hourOfDay - 12) / 6;
  return Math.max(0, 1 - x * x) * 900; // daytime bell, zero at night
};

// Persisted state with `days` of complete daylight hours recorded (generation =
// trueGain × irradiance), so the wired app learns trueGain on boot.
const seedState = (startMs: number, days: number): unknown => {
  const hourly: Record<string, { kwh: number; coveredMs: number }> = {};
  const irradianceByHour: Record<string, number> = {};
  for (let h = 0; h < days * 24; h += 1) {
    const hourStart = startMs + h * HOUR_MS;
    const irradiance = irradianceAt(hourStart);
    if (irradiance <= 0) continue;
    hourly[String(hourStart)] = { kwh: TRUE_GAIN * irradiance, coveredMs: HOUR_MS };
    irradianceByHour[String(hourStart)] = irradiance;
  }
  return { history: { lastSampleMs: startMs + days * 24 * HOUR_MS + HOUR_MS, hourly }, irradianceByHour };
};

// Open-Meteo radiation for a forward day (preceding-hour mean ⇒ stamped at interval END).
const radiationResponse = (dayStartMs: number): unknown => {
  const time: number[] = [];
  const shortwave_radiation: number[] = [];
  for (let h = 0; h < 24; h += 1) {
    time.push((dayStartMs + (h + 1) * HOUR_MS) / 1000);
    shortwave_radiation.push(irradianceAt(dayStartMs + h * HOUR_MS));
  }
  return { hourly: { time, shortwave_radiation } };
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => { process.nextTick(resolve); });
  }
};

type Structured = { event?: string; gainKwhPerWm2?: number };

describe('Learning a PV device through the app (SDK-boundary e2e, Open-Meteo mocked)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    vi.setSystemTime(Date.UTC(2026, 5, 19, 12, 0, 0));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    mockHomeyInstance.geolocation._latitude = OSLO.latitude;
    mockHomeyInstance.geolocation._longitude = OSLO.longitude;
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('learns the device gain on boot (structured log) and records a live sample (persisted)', async () => {
    const startMs = Date.UTC(2026, 5, 1, 0);
    const days = 18;
    mockHomeyInstance.settings.set(PV_FORECAST_STATE, seedState(startMs, days));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => radiationResponse(startMs + days * 24 * HOUR_MS),
    })));

    setMockDrivers({ d: new MockDriver('d', []) });
    const app = createApp();
    // Observe the app's structured logs (emitted as JSON strings through app.log).
    const events: Structured[] = [];
    const originalLog = app.log.bind(app);
    app.log = (...args: unknown[]) => {
      for (const arg of args) {
        if (typeof arg !== 'string') continue;
        try {
          const parsed = JSON.parse(arg) as Structured;
          if (parsed.event) events.push(parsed);
        } catch { /* non-JSON line */ }
      }
      return originalLog(...args);
    };
    await app.onInit();
    await flush(); // let the dormancy-armed boot refresh resolve and emit

    // LEARNED — observed through the structured log the app emits, not its internals.
    const learned = events.filter((e) => e.event === 'pv_forecast_learned');
    expect(learned.length).toBeGreaterThan(0);
    expect(learned.at(-1)!.gainKwhPerWm2).toBeCloseTo(TRUE_GAIN, 6);

    // RECORDED — a live generation sample through the real power pipeline, observed
    // through the persisted state once the persist timer fires.
    const liveNowMs = Date.UTC(2026, 5, 19, 12, 0, 0);
    await (app as { powerSamplePipeline: { recordPowerSample: (w: number, ms: number, o: { generationW: number }) => Promise<void> } })
      .powerSamplePipeline.recordPowerSample(1500, liveNowMs, { generationW: 800 });
    await vi.advanceTimersByTimeAsync(5 * 60_000); // fire the persist timer
    await flush();
    const persisted = mockHomeyInstance.settings.get(PV_FORECAST_STATE) as { history?: { lastSampleMs?: number } };
    expect(persisted.history?.lastSampleMs).toBe(liveNowMs);
  });
});
