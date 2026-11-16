// SDK-boundary e2e: a device override written the way the settings UI writes it.
//
// The settings UI stores `device_override.<deviceId>` through the settings
// bridge; nothing else tells the app. This drives that one write through the
// real settings listener, planner and executor, and asserts only what PELS
// writes back through the SDK (`api.put` of `target_temperature`): the override
// takes effect at once, a mode change does not move it, and when its end time
// passes the device goes to the target of the mode then in force.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, resetMockHomey, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { drainUntilCalledWith } from '../utils/asyncDrain';
import { pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';

const DEVICE = 'guest-room';
const TARGET = `manager/devices/device/${DEVICE}/capability/target_temperature`;
const HOME_C = 20;
const AWAY_C = 16;
const OVERRIDE_C = 24;
const HOUR_MS = 60 * 60_000;

const buildHeater = async () => {
  const device = new MockDevice(
    DEVICE,
    'Guest room',
    ['onoff', 'target_temperature', 'measure_temperature', 'measure_power', 'meter_power', 'thermostat_mode'],
    'heater',
  );
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('measure_power', 800);
  await device.setCapabilityValue('meter_power', 100);
  await device.setCapabilityValue('thermostat_mode', 'heat');
  await device.setCapabilityValue('target_temperature', HOME_C);
  await device.setCapabilityValue('measure_temperature', 19);
  return device;
};

const seedSettings = () => {
  mockHomeyInstance.settings.set('power_source', 'flow');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set('controllable_devices', { [DEVICE]: true });
  mockHomeyInstance.settings.set('managed_devices', { [DEVICE]: true });
  mockHomeyInstance.settings.set('mode_device_targets', { Home: { [DEVICE]: HOME_C }, Away: { [DEVICE]: AWAY_C } });
};

const flushDetached = async (rounds = 20): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => { process.nextTick(resolve); });
  }
};

/** Report a steady whole-home reading every 10 s for `seconds`. */
const reportPowerFor = async (seconds: number): Promise<void> => {
  const reportPowerUsage = mockHomeyInstance.flow._actionCardListeners.report_power_usage;
  for (let elapsed = 0; elapsed < seconds; elapsed += 10) {
    await reportPowerUsage({ power: 1500 });
    await flushDetached();
    await vi.advanceTimersByTimeAsync(10_000);
  }
};

const targetWrites = (putSpy: { mock: { calls: unknown[][] } }): unknown[] => (
  putSpy.mock.calls.filter(([path]) => path === TARGET).map(([, body]) => (body as { value?: unknown }).value)
);

describe('A device override written by the settings UI (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 0));
    resetMockHomey();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('holds the temperature through a mode change and returns to the mode in force when it ends', async () => {
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildHeater()]) });
    seedSettings();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp({ preserveStartupRestoreStabilization: true });
    await app.onInit();
    await reportPowerFor(120);

    mockHomeyInstance.settings.set(`device_override.${DEVICE}`, {
      untilMs: Date.now() + HOUR_MS, setting: { type: 'temperature', targetC: OVERRIDE_C },
    });
    await drainUntilCalledWith(putSpy, TARGET, pelsCapabilityWrite(OVERRIDE_C));

    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Away');
    await reportPowerFor(120);
    expect(targetWrites(putSpy)).not.toContain(AWAY_C);
    expect(targetWrites(putSpy).at(-1)).toBe(OVERRIDE_C);

    // The meter keeps reporting until the end time has passed.
    await reportPowerFor(58 * 60);
    expect(targetWrites(putSpy).at(-1)).toBe(OVERRIDE_C);
    await reportPowerFor(3 * 60);
    await drainUntilCalledWith(putSpy, TARGET, pelsCapabilityWrite(AWAY_C));
    expect(targetWrites(putSpy).at(-1)).toBe(AWAY_C);
  });
});
