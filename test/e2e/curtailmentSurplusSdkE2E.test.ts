// SDK-boundary e2e for the CURTAILMENT-INFERENCE surplus lane (zero-export homes):
// a home whose inverter throttles production so net grid power pins ~0 gets its
// willing thermostat raised on the INFERRED surplus, and the outcome-based
// verification loop confirms/refutes against what the meter then shows.
//
// Nothing internal is mocked. The inputs enter through external seams only:
// whole-home net power + gross generation through the real Homey Energy poll
// (`api.get('manager/energy/live')`), the learned PV history through the real
// persisted-state seam (`pv_forecast_state` settings, seeded — a learning run
// needs weeks of daylight), and the irradiance forecast through the real
// Open-Meteo fetch (global `fetch`, stubbed). The whole wired stack runs — the
// estimator, the surplus allocator, the eligibility gate, planner, executor —
// and it is observed only through the SDK (`api.put` writes) and the
// `curtailment_verify_*` STRUCTURED LOGS the app emits (per test/AGENTS.md).
//
// Counterparts: test/e2e/solarSurplusAbsorb.e2e.test.ts (measured-export lane),
// test/unit/curtailmentSurplus.test.ts (producer math), and the
// planner-prep integration in test/integration/solarSurplusAbsorb.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mockHomeyInstance,
  setMockDrivers,
  setMockGeolocation,
  MockDevice,
  MockDriver,
} from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  OPERATING_MODE_SETTING,
  PV_FORECAST_STATE,
} from '../../lib/utils/settingsKeys';
import { drainPending, drainUntilCalledWith } from '../utils/asyncDrain';

const cap = (deviceId: string, capability: string) =>
  `manager/devices/device/${deviceId}/capability/${capability}`;

const HOUR_MS = 3_600_000;
const OSLO = { latitude: 59.91, longitude: 10.75 };

const DEVICE = 'tank-a';
const MODE_C = 20;
const SURPLUS_DELTA = 2;
const BOOSTED_C = MODE_C + SURPLUS_DELTA; // 22
const ELEMENT_W = 2000; // 2 kW element → engage bar = 2 + 0.25 reserve = 2.25 kW

// The learned gain: noon potential = GAIN × 900 W/m² ≈ 3.87 kW; the estimator's
// term at 0.5 kW actual generation = 0.9 × 3.87 − 0.5 ≈ 2.98 kW ≥ the 2.25 kW bar.
const GAIN = 0.0043;

// History runs June 1 → June 19 00:00; the test clock boots at June 19 12:00 noon.
const HISTORY_START_MS = Date.UTC(2026, 5, 1, 0, 0, 0);
const HISTORY_DAYS = 18;
const NOW_MS = Date.UTC(2026, 5, 19, 12, 0, 0);

const irradianceAt = (hourStartMs: number): number => {
  const hourOfDay = Math.floor(hourStartMs / HOUR_MS) % 24;
  const x = (hourOfDay - 12) / 6;
  return Math.max(0, 1 - x * x) * 900; // daytime bell, zero at night
};

// Persisted PV state: 18 days of complete daylight hours (generation = GAIN ×
// irradiance) — enough trained hours for a fit on boot. With `clampEvidence`,
// every hour carries full net coverage but NO import/export evidence — exactly
// what a zero-export clamp records post-net-evidence: every hour classifies
// 'suspect', suspect dominance forces the clamp-aware quantile fit with
// forced-low confidence, i.e. the 0.8-discount lane a real zero-export home
// runs. Without it, hours carry no net fields ('unknown') and the fit falls
// back to the legacy unsegmented median (high confidence, 0.9 discount).
const seedPvState = (options: { clampEvidence?: boolean } = {}): unknown => {
  const hourly: Record<string, Record<string, number>> = {};
  const irradianceByHour: Record<string, number> = {};
  for (let h = 0; h < HISTORY_DAYS * 24; h += 1) {
    const hourStart = HISTORY_START_MS + h * HOUR_MS;
    const irradiance = irradianceAt(hourStart);
    if (irradiance <= 0) continue;
    hourly[String(hourStart)] = {
      kwh: GAIN * irradiance,
      coveredMs: HOUR_MS,
      ...(options.clampEvidence ? { netMs: HOUR_MS, importMs: 0, exportMs: 0 } : {}),
    };
    irradianceByHour[String(hourStart)] = irradiance;
  }
  return {
    history: { lastSampleMs: HISTORY_START_MS + HISTORY_DAYS * 24 * HOUR_MS, hourly },
    irradianceByHour,
  };
};

// Open-Meteo radiation for the boot day (preceding-hour mean ⇒ stamped at interval END).
const radiationResponse = (): unknown => {
  const dayStartMs = HISTORY_START_MS + HISTORY_DAYS * 24 * HOUR_MS; // June 19 00:00
  const time: number[] = [];
  const shortwave_radiation: number[] = [];
  for (let h = 0; h < 24; h += 1) {
    time.push((dayStartMs + (h + 1) * HOUR_MS) / 1000);
    shortwave_radiation.push(irradianceAt(dayStartMs + h * HOUR_MS));
  }
  return { hourly: { time, shortwave_radiation } };
};

const buildTank = async (): Promise<MockDevice> => {
  const device = new MockDevice(
    DEVICE,
    'Water tank',
    ['onoff', 'target_temperature', 'measure_temperature', 'measure_power', 'meter_power', 'thermostat_mode'],
    'heatpump',
  );
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('measure_power', ELEMENT_W);
  await device.setCapabilityValue('target_temperature', MODE_C);
  await device.setCapabilityValue('measure_temperature', 50);
  return device;
};

// Mutable whole-home energy report the real Homey Energy poll reads: SIGNED net
// (cumulative.W) plus the co-sampled gross generation (totalGenerated.W).
type EnergyReport = { netW: number; generationW: number };

const mockEnergyLive = (energy: EnergyReport): void => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return {
        items: [{ type: 'cumulative', values: { W: energy.netW } }],
        totalGenerated: { W: energy.generationW },
      };
    }
    return originalGet(path);
  });
};

const seedSettings = (options: { clampEvidence?: boolean } = {}): void => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set('controllable_devices', { [DEVICE]: true });
  mockHomeyInstance.settings.set('managed_devices', { [DEVICE]: true });
  mockHomeyInstance.settings.set('mode_device_targets', { Home: { [DEVICE]: MODE_C } });
  mockHomeyInstance.settings.set('price_optimization_settings', {
    [DEVICE]: {
      enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusWilling: true, surplusDelta: SURPLUS_DELTA,
    },
  });
  mockHomeyInstance.settings.set(PV_FORECAST_STATE, seedPvState(options));
};

type Structured = Record<string, unknown> & { event?: string };

// Boot the real app with structured-log capture (emitted as JSON through app.log).
const bootApp = async (): Promise<{ app: ReturnType<typeof createApp>; events: Structured[] }> => {
  const app = createApp({ preserveStartupRestoreStabilization: true });
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

// Drive `count` 10 s Homey Energy polls.
const polls = async (count: number): Promise<void> => {
  for (let i = 0; i < count; i += 1) {
    await vi.advanceTimersByTimeAsync(10_000);
  }
};

const eventNames = (events: Structured[]): string[] => events.map((e) => String(e.event));

const countBoostRaises = (putSpy: { mock: { calls: unknown[][] } }): number => (
  putSpy.mock.calls.filter(
    ([path, body]) => path === cap(DEVICE, 'target_temperature')
      && (body as { value?: number } | undefined)?.value === BOOSTED_C,
  ).length
);

describe('Curtailment-inferred surplus (SDK-boundary e2e, zero-export home)', () => {
  beforeEach(() => {
    // 'Date' MUST be faked — under NODE_ENV=test the plan-rebuild scheduler reads
    // its clock via Date.now(); a real-vs-fake split intermittently strands the
    // rebuild under CI load.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    vi.setSystemTime(NOW_MS);
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    setMockGeolocation(OSLO.latitude, OSLO.longitude);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => radiationResponse() })));
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('TRUE curtailment: engages on the inferred surplus, production follows, verification CONFIRMS', async () => {
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildTank()]) });
    seedSettings();
    // Zero-export posture: net pins ~0 (a 50 W standing draw), generation far
    // below the ~3.9 kW learned potential — the meter never shows export.
    const energy: EnergyReport = { netW: 50, generationW: 500 };
    mockEnergyLive(energy);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const { events } = await bootApp();
    // Past the 60 s startup stabilization + 90 s surplus settle window.
    await polls(20);
    await drainUntilCalledWith(putSpy, cap(DEVICE, 'target_temperature'), { value: BOOSTED_C });

    // The inverter un-throttles to cover the element: production rises, net stays ~0.
    energy.generationW = 2500;
    // Ride out the full 5-min verify window with no import.
    await polls(34);
    await drainPending();

    expect(eventNames(events)).toContain('curtailment_verify_started');
    expect(eventNames(events)).toContain('curtailment_verify_confirmed');
    expect(eventNames(events)).not.toContain('curtailment_verify_refuted');
    // The lift held: no release write back to the mode setpoint.
    const released = putSpy.mock.calls.some(
      ([path, body]) => path === cap(DEVICE, 'target_temperature')
        && (body as { value?: number } | undefined)?.value === MODE_C,
    );
    expect(released).toBe(false);
  });

  it('FALSE inference: production does not follow, verification REFUTES, lift releases, hold blocks re-engage', async () => {
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildTank()]) });
    seedSettings();
    const energy: EnergyReport = { netW: 50, generationW: 500 };
    mockEnergyLive(energy);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const { events } = await bootApp();
    await polls(20);
    await drainUntilCalledWith(putSpy, cap(DEVICE, 'target_temperature'), { value: BOOSTED_C });

    // The inference was wrong: generation stays flat, so the raised element pulls
    // its 2 kW straight from the grid.
    energy.netW = 2000;
    // Producer latch + refute land on the next poll; the sustained import then
    // hard-offs the gate release after a settle window (~90 s) — no 5-min dwell.
    await polls(14);
    await drainUntilCalledWith(putSpy, cap(DEVICE, 'target_temperature'), { value: MODE_C });

    expect(eventNames(events)).toContain('curtailment_verify_refuted');
    expect(eventNames(events)).not.toContain('curtailment_verify_confirmed');
    const refuted = events.find((e) => e.event === 'curtailment_verify_refuted');
    expect(refuted).toMatchObject({ holdLevel: 1, holdMs: 15 * 60 * 1000 });

    // Back to the zero-export posture — but the refuted-inference hold keeps the
    // term at zero, so the lift must NOT re-engage.
    const raisesAtRelease = countBoostRaises(putSpy);
    energy.netW = 50;
    await polls(24); // 4 min — well past settle, well inside the 15-min hold
    await drainPending();
    expect(countBoostRaises(putSpy)).toBe(raisesAtRelease);
  });

  it('battery home: the inferred term never arms — no raise, no verification', async () => {
    const battery = new MockDevice('bat-1', 'Home Battery', ['measure_battery', 'measure_power'], 'battery');
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildTank(), battery]) });
    seedSettings();
    mockEnergyLive({ netW: 50, generationW: 500 });

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const { events } = await bootApp();
    await polls(30);
    await drainPending();

    expect(countBoostRaises(putSpy)).toBe(0);
    expect(eventNames(events)).not.toContain('curtailment_verify_started');
  });

  it('clamp-suspect history (real zero-export home): learns the clamp-aware low-confidence fit and engages via the 0.8 lane', async () => {
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildTank()]) });
    // Net-evidence-bearing history: every hour 'suspect' (full net coverage, no
    // import/export evidence) — the fit lane a post-net-evidence zero-export
    // home actually runs, not the legacy unknown-evidence median.
    seedSettings({ clampEvidence: true });
    const energy: EnergyReport = { netW: 50, generationW: 500 };
    mockEnergyLive(energy);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const { events } = await bootApp();
    await polls(20);
    await drainUntilCalledWith(putSpy, cap(DEVICE, 'target_temperature'), { value: BOOSTED_C });

    // The fit came from the clamp-aware quantile with forced-low confidence —
    // so the engage above cleared the bar through the 0.8 discount lane.
    const learned = events.filter((e) => e.event === 'pv_forecast_learned');
    expect(learned.length).toBeGreaterThan(0);
    expect(learned.at(-1)).toMatchObject({ trainingMode: 'clamp_aware_quantile', confidence: 'low' });
  });

  it('cap subordination: a capacity shortfall DURING an active inferred lift sheds the lifted device normally', async () => {
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildTank()]) });
    seedSettings();
    const energy: EnergyReport = { netW: 50, generationW: 500 };
    mockEnergyLive(energy);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    await bootApp();
    await polls(20);
    await drainUntilCalledWith(putSpy, cap(DEVICE, 'target_temperature'), { value: BOOSTED_C });

    // A big background load lands: 12 kW against the 10 kW hard cap. The lifted
    // device must remain an ordinary capacity-shed candidate — the untouched
    // capacity layer turns it off on the normal path (default shed = turn_off).
    energy.netW = 12_000;
    await polls(8);
    await drainUntilCalledWith(putSpy, cap(DEVICE, 'onoff'), { value: false });

    expect(putSpy).toHaveBeenCalledWith(cap(DEVICE, 'onoff'), { value: false });
  });
});
