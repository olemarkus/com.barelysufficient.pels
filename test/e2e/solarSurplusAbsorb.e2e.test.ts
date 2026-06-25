// SDK-boundary e2e for SURPLUS-ABSORB: a willing thermostat raises its mode
// setpoint to self-consume exported solar.
//
// Nothing internal is mocked. Power enters through the real Homey Energy poll
// (`api.get('manager/energy/live')` — the SDK seam) as a NEGATIVE cumulative.W
// (the home exporting), drives the real surplus allocator + eligibility gate +
// planner + executor, and the only thing asserted is what PELS writes back through
// the SDK (`api.put` of `target_temperature`). The device's `measure_power` is its
// element draw — the gate's overshoot-fit bar — so export must cover it.
//
// Counterpart to test/integration/solarSurplusAbsorb.test.ts (the planner-prep
// integration test that drives `buildInitialPlanDevices` directly).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { drainPending, drainUntilCalledWith } from '../utils/asyncDrain';

const cap = (deviceId: string, capability: string) =>
  `manager/devices/device/${deviceId}/capability/${capability}`;

const DEVICE = 'tank-a';
const MODE_C = 20;
const SURPLUS_DELTA = 2;
const BOOSTED_C = MODE_C + SURPLUS_DELTA; // 22
const ELEMENT_W = 2000; // 2 kW element → engage bar = 2 + 0.25 reserve = 2.25 kW

const buildTank = async (targetTemperature: number) => {
  const device = new MockDevice(
    DEVICE,
    'Water tank',
    ['onoff', 'target_temperature', 'measure_temperature', 'measure_power', 'meter_power', 'thermostat_mode'],
    'heatpump',
  );
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('measure_power', ELEMENT_W);
  await device.setCapabilityValue('target_temperature', targetTemperature);
  await device.setCapabilityValue('measure_temperature', 50);
  return device;
};

// Drive whole-home net power through the real Homey Energy poll. Negative = export.
const reportHomePower = (totalW: number) => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', values: { W: totalW } }] };
    }
    return originalGet(path);
  });
};

const seedSettings = (surplusWilling: boolean) => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  // Cap far above any draw here — export means huge headroom, so capacity never sheds.
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set('controllable_devices', { [DEVICE]: true });
  mockHomeyInstance.settings.set('managed_devices', { [DEVICE]: true });
  mockHomeyInstance.settings.set('mode_device_targets', { Home: { [DEVICE]: MODE_C } });
  mockHomeyInstance.settings.set('price_optimization_settings', {
    [DEVICE]: { enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusWilling, surplusDelta: SURPLUS_DELTA },
  });
};

// Drive ~200 s of 10 s Homey Energy polls past BOTH the 60 s startup
// restore-stabilization window AND the 90 s surplus settle window — the app keeps
// its real startup stabilization (createApp preserves it below), so the lift can
// only land after both windows elapse.
const advancePastSettle = async () => {
  for (let i = 0; i < 20; i += 1) {
    await vi.advanceTimersByTimeAsync(10_000);
  }
};

describe('Surplus-absorb setpoint raise (SDK-boundary e2e)', () => {
  beforeEach(() => {
    // 'Date' MUST be faked — under NODE_ENV=test the plan-rebuild scheduler reads
    // its clock via Date.now() (app.ts getAppPlanRebuildNowMs); a real-vs-fake split
    // intermittently strands the rebuild under CI load.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 0));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('raises a willing thermostat to mode + surplusDelta once export persists past the settle window', async () => {
    const device = await buildTank(MODE_C);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    seedSettings(true);
    reportHomePower(-3000); // exporting 3 kW — covers the 2 kW element + reserve

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp({ preserveStartupRestoreStabilization: true });
    await app.onInit();
    await advancePastSettle();
    await drainUntilCalledWith(putSpy, cap(DEVICE, 'target_temperature'), { value: BOOSTED_C });

    expect(putSpy).toHaveBeenCalledWith(cap(DEVICE, 'target_temperature'), { value: BOOSTED_C });
  });

  it('never raises a non-willing thermostat, even while exporting', async () => {
    const device = await buildTank(MODE_C);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    seedSettings(false);
    reportHomePower(-3000);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp({ preserveStartupRestoreStabilization: true });
    await app.onInit();
    await advancePastSettle();
    // Flush the detached poll → rebuild → executor chain before scanning, so a
    // boost write queued on the final poll cannot land after the assertion.
    await drainPending();

    const raisedToBoost = putSpy.mock.calls.some(
      ([path, body]) => path === cap(DEVICE, 'target_temperature')
        && (body as { value?: number } | undefined)?.value === BOOSTED_C,
    );
    expect(raisedToBoost).toBe(false);
  });
});
