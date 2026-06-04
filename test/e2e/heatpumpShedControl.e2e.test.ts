// SDK-boundary e2e for heatpump (thermostat-class) capacity control.
//
// Nothing internal is mocked. Power enters through the real Homey Energy poll
// (`api.get('manager/energy/live')` — the SDK seam), drives the real capacity guard +
// planner + executor, and the only thing asserted is what PELS writes back through the
// SDK (`api.put` device-capability commands). No plan/target snapshot reads, no
// `computeDynamicSoftLimit` override.
//
// Counterpart to test/integration/heatpumpDevices.integration.test.ts, which keeps the
// power-estimation classification cases (no externally observable effect).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW } from '../../lib/utils/settingsKeys';

const flushPromises = () => new Promise((resolve) => process.nextTick(resolve));

const cap = (deviceId: string, capability: string) =>
  `manager/devices/device/${deviceId}/capability/${capability}`;

const buildHeatpumpDevice = async (targetTemperature: number, powerW: number) => {
  const device = new MockDevice(
    'heatpump-a',
    'Hallway Heatpump',
    ['onoff', 'target_temperature', 'measure_temperature', 'measure_power', 'meter_power', 'thermostat_mode'],
    'heatpump',
  );
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('measure_power', powerW);
  await device.setCapabilityValue('target_temperature', targetTemperature);
  await device.setCapabilityValue('measure_temperature', 21);
  return device;
};

// Drive total home power through the real Homey Energy poll: stub the SDK wire path
// (`manager/energy/live`), not the transport helper, so the real query path runs.
const reportHomePower = (totalW: number) => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', values: { W: totalW } }] };
    }
    return originalGet(path);
  });
};

const enableCapacity = (limitKw: number) => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, limitKw);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set('controllable_devices', { 'heatpump-a': true });
  mockHomeyInstance.settings.set('managed_devices', { 'heatpump-a': true });
};

describe('Heatpump capacity control (SDK-boundary e2e)', () => {
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

  it('sheds by lowering target_temperature — never turning the device off — when home power exceeds the limit', async () => {
    const device = await buildHeatpumpDevice(22, 2000);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    enableCapacity(1);
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      'heatpump-a': { action: 'set_temperature', temperature: 15 },
    });
    reportHomePower(5000);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    expect(putSpy).toHaveBeenCalledWith(cap('heatpump-a', 'target_temperature'), { value: 15 });
    const turnedOff = putSpy.mock.calls.some(
      ([path]) => typeof path === 'string' && path.endsWith('/capability/onoff'),
    );
    expect(turnedOff).toBe(false);
  });

  it('applies the mode setpoint by writing target_temperature on the configured operating mode', async () => {
    const device = await buildHeatpumpDevice(22, 0);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('controllable_devices', { 'heatpump-a': true });
    mockHomeyInstance.settings.set('managed_devices', { 'heatpump-a': true });
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'heatpump-a': 20 } });

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await flushPromises();

    expect(putSpy).toHaveBeenCalledWith(cap('heatpump-a', 'target_temperature'), { value: 20 });
  });
});
