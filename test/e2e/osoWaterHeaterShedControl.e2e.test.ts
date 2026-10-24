// SDK-boundary e2e for an OSO inCharge water heater.
//
// Nothing internal is mocked. Power enters through the real Homey Energy poll,
// the heater's readings through its Homey capabilities, and the only thing
// asserted is what PELS writes back through the SDK (`api.put`).
//
// OSO's `onoff` is the "element is heating" flag, and a write to it is a timed
// force command, so PELS limits the heater through `target_temperature` alone.
// A force-on from outside PELS (the device tile's button, or OSO's own Flow
// card) makes the element heat while PELS limits it. PELS cannot cancel that
// force, so it leaves the heater at its limit and limits the next device.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, resetMockHomey, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { connectLiveFeed } from '../helpers/liveFeedSocketHarness';
import { CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW } from '../../lib/utils/settingsKeys';
import { drainUntilCalledWith } from '../utils/asyncDrain';

const cap = (deviceId: string, capability: string) =>
  `manager/devices/device/${deviceId}/capability/${capability}`;

const buildOsoHeater = async () => {
  const device = new MockDevice(
    'oso-a',
    'Water Heater',
    ['onoff', 'measure_power', 'meter_power', 'measure_temperature', 'target_temperature', 'water_heater_heating'],
    'other',
  );
  device.setDriverIdentity({ ownerUri: 'homey:app:no.osoincharge', driverId: 'homey:app:no.osoincharge:water-heater' });
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('water_heater_heating', 'on');
  await device.setCapabilityValue('measure_power', 3000);
  await device.setCapabilityValue('meter_power', 100);
  await device.setCapabilityValue('measure_temperature', 58);
  await device.setCapabilityValue('target_temperature', 65);
  device.setCapabilityMetadata('target_temperature', { min: 20, max: 75, step: 1 });
  return device;
};

const buildPlug = async () => {
  const device = new MockDevice('plug-a', 'Plug', ['onoff', 'measure_power'], 'socket');
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('measure_power', 1000);
  return device;
};

const reportHomePower = (initialTotalW: number): ((totalW: number) => void) => {
  let totalW = initialTotalW;
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: totalW } }] };
    }
    return originalGet(path);
  });
  return (nextTotalW) => {
    totalW = nextTotalW;
  };
};

const writesTo = (putSpy: { mock: { calls: unknown[][] } }, deviceId: string, capability: string) => (
  putSpy.mock.calls.filter(([path]) => path === cap(deviceId, capability))
);

describe('OSO water heater capacity control (SDK-boundary e2e)', () => {
  beforeEach(() => {
    // 'Date' and 'performance' MUST be faked: the plan-rebuild scheduler reads
    // the monotonic clock and the rest of the app reads Date.
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

  it('writes a saved limited temperature up to the tank\'s own maximum', async () => {
    const heater = await buildOsoHeater();
    setMockDrivers({ driverA: new MockDriver('driverA', [heater]) });
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 2);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('controllable_devices', { 'oso-a': true });
    mockHomeyInstance.settings.set('managed_devices', { 'oso-a': true });
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'oso-a': 65 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      'oso-a': { action: 'set_temperature', temperature: 55, coolingTemperature: 28 },
    });
    reportHomePower(4000);
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    connectLiveFeed();
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntilCalledWith(putSpy, cap('oso-a', 'target_temperature'), { value: 55 });

    expect(writesTo(putSpy, 'oso-a', 'onoff')).toEqual([]);
  });

  it('limits through the target, never onoff, and limits the next device when a force-on keeps it heating', async () => {
    const heater = await buildOsoHeater();
    const plug = await buildPlug();
    setMockDrivers({ driverA: new MockDriver('driverA', [heater, plug]) });
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 4);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('controllable_devices', { 'oso-a': true, 'plug-a': true });
    mockHomeyInstance.settings.set('managed_devices', { 'oso-a': true, 'plug-a': true });
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'oso-a': 65 } });
    // The heater is limited first, the plug only after it.
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'plug-a': 1, 'oso-a': 2 } });
    const setHomePower = reportHomePower(5000);
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    // The tank is heating and has pushed the house over its limit: PELS limits
    // the heater to its configured minimum target of 20 °C, and leaves the plug on.
    connectLiveFeed();
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntilCalledWith(putSpy, cap('oso-a', 'target_temperature'), { value: 20 });
    expect(writesTo(putSpy, 'plug-a', 'onoff')).toEqual([]);

    // The 58 °C tank is above its 20 °C limit, so the element stops.
    await heater.setCapabilityValue('onoff', false);
    await heater.setCapabilityValue('water_heater_heating', 'off');
    await heater.setCapabilityValue('measure_power', 0);
    setHomePower(2000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writesTo(putSpy, 'plug-a', 'onoff')).toEqual([]);

    // Someone presses the heater's on button: OSO forces the element on for
    // an hour, whatever its target, and the house is over its limit again.
    // PELS never answers with an on/off write of its own; it limits the plug.
    await heater.setCapabilityValue('onoff', true);
    await heater.setCapabilityValue('water_heater_heating', 'on');
    await heater.setCapabilityValue('measure_power', 3000);
    setHomePower(5000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await drainUntilCalledWith(putSpy, cap('plug-a', 'onoff'), { value: false });

    expect(writesTo(putSpy, 'oso-a', 'onoff')).toEqual([]);
    expect(writesTo(putSpy, 'oso-a', 'target_temperature')).toEqual([
      [cap('oso-a', 'target_temperature'), { value: 20 }],
    ]);
  });
});
