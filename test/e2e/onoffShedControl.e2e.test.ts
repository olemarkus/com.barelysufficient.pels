// SDK-boundary e2e for on/off capacity shedding.
//
// THE RULE THIS TEST ENFORCES: nothing internal is mocked. Power enters through the
// real Homey Energy poll (`getEnergyLiveReport` — the SDK seam), drives the real
// capacity guard + planner + executor, and the only thing asserted is what PELS
// writes back through the SDK (`api.put` device-capability commands). No plan/target
// snapshot reads, no `computeDynamicSoftLimit` override — the control decision is
// observed purely by its effect on the device.
//
// This is the e2e counterpart to test/integration/onoffDevices.integration.test.ts:
// the integration spec characterises power-estimation classification (which has no
// external effect to observe); this spec characterises the *control* behaviour, which
// does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW } from '../../lib/utils/settingsKeys';

const flushPromises = () => new Promise((resolve) => process.nextTick(resolve));

const ONOFF_CAP = (deviceId: string) => `manager/devices/device/${deviceId}/capability/onoff`;

const buildOnOffDevice = async (powerW: number) => {
  const device = new MockDevice(
    'device-a',
    'On/Off Socket',
    ['onoff', 'measure_power', 'meter_power', 'rms_voltage', 'rms_current'],
    'socket',
  );
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('measure_power', powerW);
  return device;
};

// Drive total home power through the real Homey Energy poll. We stub at the SDK
// boundary — `api.get('manager/energy/live')`, the wire path the REST client hits —
// not the `getEnergyLiveReport` transport helper, so the real query path is exercised.
// The app ingests the report on its 10 s interval.
const reportHomePower = (totalW: number) => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', values: { W: totalW } }] };
    }
    return originalGet(path);
  });
};

const configureCapacity = (limitKw: number) => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, limitKw);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set('controllable_devices', { 'device-a': true });
  mockHomeyInstance.settings.set('managed_devices', { 'device-a': true });
};

describe('On/off capacity shedding (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
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

  it('turns the device off when home power exceeds the capacity limit', async () => {
    const device = await buildOnOffDevice(2000);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    configureCapacity(1);
    reportHomePower(5000);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    expect(putSpy).toHaveBeenCalledWith(ONOFF_CAP('device-a'), { value: false });
  });

  it('sheds via turn_off only — never writes a temperature target — even when misconfigured with a set_temperature overshoot', async () => {
    const device = await buildOnOffDevice(2000);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    configureCapacity(1);
    // A user misconfiguration: a set_temperature overshoot on a device with no
    // temperature capability. The executor must ignore it and fall back to turn_off.
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      'device-a': { action: 'set_temperature', temperature: 40 },
    });
    reportHomePower(5000);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    expect(putSpy).toHaveBeenCalledWith(ONOFF_CAP('device-a'), { value: false });
    const wroteTemperatureTarget = putSpy.mock.calls.some(([path]) =>
      typeof path === 'string' && path.includes('capability/target_temperature'),
    );
    expect(wroteTemperatureTarget).toBe(false);
  });
});
