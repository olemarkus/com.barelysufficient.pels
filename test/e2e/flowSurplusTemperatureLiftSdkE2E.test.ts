// SDK-boundary e2e: the SURPLUS-ABSORB temperature lift on the `flow` power source.
//
// WHY THIS EXISTS: the lift was never gated on the power source. Its candidacy is
// `willingWithLift(config) && supportsTemperatureLift(dev)` plus surplus
// eligibility, and the surplus pool is `measuredExportKw = -signedNetKw`
// (`composeSurplusPool`) — no production reading anywhere in that path. The ONLY
// thing keeping it off the flow source was the `report_power_usage` card
// rejecting negative watts. Admitting signed watts therefore switches this
// feature on for flow homes as a CONSEQUENCE, not as a choice, and that is
// exactly why it needs a test at the SDK boundary rather than an assumption.
//
// Nothing internal is mocked. Power enters through the real Flow action card,
// drives the real surplus allocator + eligibility gate + planner + executor, and
// the only thing asserted is what PELS writes back through the SDK
// (`api.put` of `target_temperature`).
//
// Counterpart to test/e2e/solarSurplusAbsorb.e2e.test.ts, which proves the same
// behaviour through the Homey Energy poll.
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
const EXPORT_W = -3000; // exporting 3 kW — clears the element + reserve

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

const seedSettings = (surplusWilling: boolean) => {
  mockHomeyInstance.settings.set('power_source', 'flow');
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

const flushDetached = async (rounds = 20): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => { process.nextTick(resolve); });
  }
};

// The flow source has no 10 s poll to piggyback on, so the sample is re-reported
// on the same cadence the Homey Energy counterpart polls at. ~200 s clears BOTH
// the 60 s startup restore-stabilization window AND the 90 s surplus settle
// window, so the lift can only land once export has genuinely persisted.
const reportExportPastSettle = async (powerW: number): Promise<void> => {
  const reportPowerUsage = mockHomeyInstance.flow._actionCardListeners.report_power_usage;
  for (let i = 0; i < 20; i += 1) {
    await reportPowerUsage({ power: powerW });
    await flushDetached();
    await vi.advanceTimersByTimeAsync(10_000);
  }
};

describe('Surplus-absorb temperature lift on the flow power source (SDK-boundary e2e)', () => {
  beforeEach(() => {
    // 'Date' MUST be faked — under NODE_ENV=test the plan-rebuild scheduler reads
    // its clock via Date.now(); a real-vs-fake split strands the rebuild.
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

  it('raises a willing thermostat once Flow-reported export persists past the settle window', async () => {
    const device = await buildTank(MODE_C);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    seedSettings(true);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp({ preserveStartupRestoreStabilization: true });
    await app.onInit();

    await reportExportPastSettle(EXPORT_W);
    await drainUntilCalledWith(putSpy, cap(DEVICE, 'target_temperature'), { value: BOOSTED_C });

    expect(putSpy).toHaveBeenCalledWith(cap(DEVICE, 'target_temperature'), { value: BOOSTED_C });
  });

  it('never raises a non-willing thermostat, even while exporting', async () => {
    const device = await buildTank(MODE_C);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    seedSettings(false);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp({ preserveStartupRestoreStabilization: true });
    await app.onInit();

    await reportExportPastSettle(EXPORT_W);
    // Flush the detached report → rebuild → executor chain before scanning, so a
    // boost write queued on the final report cannot land after the assertion.
    await drainPending();

    const raisedToBoost = putSpy.mock.calls.some(
      ([path, body]) => path === cap(DEVICE, 'target_temperature')
        && (body as { value?: number } | undefined)?.value === BOOSTED_C,
    );
    expect(raisedToBoost).toBe(false);
  });

  it('does not raise on sustained import, so the lift tracks the surplus and not the source', async () => {
    const device = await buildTank(MODE_C);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    seedSettings(true);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp({ preserveStartupRestoreStabilization: true });
    await app.onInit();

    // Same willing device, same duration — only the sign differs.
    await reportExportPastSettle(2500);
    await drainPending();

    const raisedToBoost = putSpy.mock.calls.some(
      ([path, body]) => path === cap(DEVICE, 'target_temperature')
        && (body as { value?: number } | undefined)?.value === BOOSTED_C,
    );
    expect(raisedToBoost).toBe(false);
  });
});
