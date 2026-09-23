// SDK-boundary e2e for the PV-forecast SOURCE SELECTION: the app boots against
// the real wired stack (price coordinator, budget-price inputs, both forecast
// controllers, settings handler) and only the Homey SDK boundary is simulated —
// the solar-forecast route (`manager/energy/forecast/solar`), Homey Energy
// dynamic prices, the persisted-settings store, and the clock. Behaviour is
// observed through STRUCTURED LOGS only (`pv_forecast_homey*`,
// `pv_forecast_source_selected`), per test/AGENTS.md.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { drainPending, drainUntil } from '../utils/asyncDrain';
import {
  CAPACITY_LIMIT_KW,
  OPERATING_MODE_SETTING,
  PRICE_SCHEME,
  PV_FORECAST_SOURCE,
  PV_FORECAST_STATE,
} from '../../lib/utils/settingsKeys';
import type { HomeyEnergyApi } from '../../lib/utils/homeyEnergy';

const HOUR_MS = 3_600_000;
// 2026-08-25T10:00:00Z = 12:00 in Europe/Oslo (the mock clock's timezone).
const NOW_MS = Date.UTC(2026, 7, 25, 10);
const TODAY = '2026-08-25';
const TOMORROW = '2026-08-26';

// A Homey solar-forecast day: 24 hourly points at `watts` (00:00Z..23:00Z).
const forecastDay = (dateKey: string, watts: number): unknown => ({
  resolution: 15,
  points: Array.from({ length: 24 }, (_, hour) => ({
    t: `${dateKey}T${String(hour).padStart(2, '0')}:00:00.000Z`,
    watts,
  })),
  totalWh: (watts * 24) / 4,
});

// Homey Energy dynamic prices for whichever date the app asks about, so the
// combined-prices build has real hourly entries to layer the planning price on.
const setEnergyPrices = (): void => {
  const energy: HomeyEnergyApi = {
    fetchDynamicElectricityPrices: async ({ date }) => ({
      interval: 60,
      priceUnit: 'NOK',
      pricesPerInterval: Array.from({ length: 24 }, (_, hour) => ({
        periodStart: new Date(Date.parse(`${date}T00:00:00.000Z`) + hour * HOUR_MS).toISOString(),
        value: 1,
      })),
    }),
  };
  mockHomeyInstance.api._dynamicElectricityPrices = energy.fetchDynamicElectricityPrices;
};

// One recorded generation hour: enough for PvForecastController.isActive()
// (the auto-probe arm signal) without pretending a learned fit exists.
const seedSolarActiveHome = (): void => {
  const hourKey = String(NOW_MS - 24 * HOUR_MS);
  mockHomeyInstance.settings.set(PV_FORECAST_STATE, {
    history: { lastSampleMs: NOW_MS - 23 * HOUR_MS, hourly: { [hourKey]: { kwh: 1, coveredMs: HOUR_MS } } },
    irradianceByHour: { [hourKey]: 500 },
  });
};

// Conforming device reads: every declared capability PELS models reports a
// value, as a real Homey device does. An idle heater, and a PV array that is
// producing nothing at the moment of the read.
const buildHeater = async (): Promise<MockDevice> => {
  const heater = new MockDevice('h', 'Heater', ['onoff', 'measure_power']);
  await heater.setCapabilityValue('onoff', false);
  await heater.setCapabilityValue('measure_power', 0);
  return heater;
};

const buildSolar = async (): Promise<MockDevice> => {
  const solar = new MockDevice('pv', 'Solar roof', ['measure_power', 'meter_power'], 'solarpanel');
  await solar.setCapabilityValue('measure_power', 0);
  await solar.setCapabilityValue('meter_power', 100);
  return solar;
};

type Structured = Record<string, unknown> & { event?: string };

// Boot the real app with structured-log capture (emitted as JSON through app.log).
const bootApp = async (): Promise<{ app: ReturnType<typeof createApp>; events: Structured[] }> => {
  const app = createApp();
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
  return { app, events };
};

// Deterministically drive one combined-prices build (invokes the budget-price
// surplus getter per hour, which reads the selected source).
const buildCombinedPrices = async (app: ReturnType<typeof createApp>): Promise<void> => {
  await app.priceCoordinator.refreshSpotPrices(true);
  app.priceCoordinator.updateCombinedPrices();
  await drainPending();
};

const selections = (events: Structured[]): Structured[] => (
  events.filter((event) => event.event === 'pv_forecast_source_selected')
);

describe('PV-forecast source selection (SDK-boundary e2e)', () => {
  beforeEach(async () => {
    // 'Date' and 'performance' MUST be faked: the plan-rebuild scheduler reads
    // the monotonic clock and the rest of the app reads Date. Either left real
    // runs on real time against the fake timers and strands the rebuild.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(NOW_MS);
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    // Open-Meteo stub: an empty-but-valid radiation payload keeps the learned
    // lane's network seam deterministic (its refresh parses to no data).
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ hourly: { time: [], shortwave_radiation: [] } }),
    })));
    setMockDrivers({
      d: new MockDriver('d', [await buildHeater(), await buildSolar()]),
    });
    setEnergyPrices();
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
    seedSolarActiveHome();
  });

  afterEach(async () => {
    await cleanupApps();
    mockHomeyInstance.api._solarForecastByDate = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('serves Homey forecast data under auto: probe succeeds, source selected, data logged', async () => {
    mockHomeyInstance.api._solarForecastByDate = {
      [TODAY]: forecastDay(TODAY, 2000),
      [TOMORROW]: forecastDay(TOMORROW, 1000),
    };
    const { app, events } = await bootApp();
    await drainPending();

    const homeyRefresh = events.find((event) => event.event === 'pv_forecast_homey');
    expect(homeyRefresh).toMatchObject({ totalWhReported: { kind: 'reported', wh: 18_000 } });
    expect(homeyRefresh?.hourCount).toBe(48);

    await buildCombinedPrices(app);
    expect(selections(events)).toContainEqual(expect.objectContaining({
      sourceId: 'homey_energy',
      setting: 'auto',
    }));
  });

  it('tracks solar-forecast applicability from committed device snapshots', async () => {
    const heater = await buildHeater();
    const solar = await buildSolar();
    // Model a boot whose first full device read had no trustworthy devices.
    // With no known ids, the production targeted poll falls back to a full read.
    setMockDrivers({});
    mockHomeyInstance.api._solarForecastByDate = {
      [TODAY]: forecastDay(TODAY, 2000),
      [TOMORROW]: forecastDay(TOMORROW, 1000),
    };
    const apiGet = vi.spyOn(mockHomeyInstance.api, 'get');
    const { events } = await bootApp();
    await drainPending();

    const solarForecastRequestCount = (): number => apiGet.mock.calls.filter(
      ([path]) => typeof path === 'string' && path.startsWith('manager/energy/forecast/solar?'),
    ).length;
    expect(solarForecastRequestCount()).toBe(0);
    expect(events.some((event) => event.event?.startsWith('pv_forecast_homey'))).toBe(false);

    // The committed snapshot event, not the 3 h forecast timer, discovers a
    // newly eligible solar device and probes immediately.
    setMockDrivers({ d: new MockDriver('d', [heater, solar]) });
    await vi.advanceTimersByTimeAsync(5 * 60_000); // production device-poll cadence
    await drainUntil(() => solarForecastRequestCount() === 2);
    expect(solarForecastRequestCount()).toBe(2);
    expect(events.some((event) => event.event === 'pv_forecast_homey')).toBe(true);

    // The reverse transition immediately drops the cached Homey forecast. A
    // later source read therefore falls back to learned without another API
    // request.
    const formerSolar = new MockDevice('pv', 'Former solar', ['onoff'], 'heater');
    await formerSolar.setCapabilityValue('onoff', false);
    await formerSolar.setCapabilityValue('measure_power', 0);
    setMockDrivers({ d: new MockDriver('d', [heater, formerSolar]) });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await drainUntil(() => selections(events).at(-1)?.sourceId === 'learned');
    expect(solarForecastRequestCount()).toBe(2);
    expect(selections(events).at(-1)).toMatchObject({ sourceId: 'learned', setting: 'auto' });
  });

  it('stays on the learned model when the route is missing (pre-13.4.0 firmware)', async () => {
    // _solarForecastByDate stays null ⇒ the route rejects like old firmware.
    const { app, events } = await bootApp();
    await drainPending();

    expect(events.some((event) => event.event === 'pv_forecast_homey')).toBe(false);
    expect(events.some((event) => event.event === 'pv_forecast_homey_unavailable')).toBe(true);

    await buildCombinedPrices(app);
    expect(selections(events)).toContainEqual(expect.objectContaining({
      sourceId: 'learned',
      setting: 'auto',
    }));
    expect(selections(events).some((event) => event.sourceId === 'homey_energy')).toBe(false);
  });

  it('re-probes and re-selects immediately on a pv_forecast_source settings flip', async () => {
    const { app, events } = await bootApp();
    await buildCombinedPrices(app);
    expect(selections(events).at(-1)).toMatchObject({ sourceId: 'learned' });

    // The forecast appears (e.g. firmware upgraded) but the 3 h tick is far
    // away; the settings flip must kick the probe and re-selection itself.
    mockHomeyInstance.api._solarForecastByDate = { [TODAY]: forecastDay(TODAY, 2000) };
    mockHomeyInstance.settings.set(PV_FORECAST_SOURCE, 'homey_energy');
    await drainPending();

    expect(events.some((event) => event.event === 'pv_forecast_homey')).toBe(true);
    expect(selections(events).at(-1)).toMatchObject({
      sourceId: 'homey_energy',
      setting: 'homey_energy',
    });
  });
});
