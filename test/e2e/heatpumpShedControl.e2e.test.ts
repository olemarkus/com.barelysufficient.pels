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
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  TEMPERATURE_CONTROL_DISABLED_DEVICES,
} from '../../lib/utils/settingsKeys';
import { drainUntilCalledWith } from '../utils/asyncDrain';

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

const enableCapacity = (limitKw: number) => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, limitKw);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set('controllable_devices', { 'heatpump-a': true });
  mockHomeyInstance.settings.set('managed_devices', { 'heatpump-a': true });
};

describe('Heatpump capacity control (SDK-boundary e2e)', () => {
  beforeEach(() => {
    // 'Date' MUST be faked here: under NODE_ENV=test the plan-rebuild scheduler reads
    // its clock via Date.now() (setup/planRebuildIntentPolicy.ts getAppPlanRebuildNowMs). Without a faked Date it
    // runs on real wall-clock while the test drives fake timers — a real-vs-fake split
    // that intermittently strands the rebuild under CI load (the drainUntil flake).
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
    await drainUntilCalledWith(putSpy, cap('heatpump-a', 'target_temperature'), { value: 15 });

    expect(putSpy).toHaveBeenCalledWith(cap('heatpump-a', 'target_temperature'), { value: 15 });
    const turnedOff = putSpy.mock.calls.some(
      ([path]) => typeof path === 'string' && path.endsWith('/capability/onoff'),
    );
    expect(turnedOff).toBe(false);
  });

  it('limits a cooling unit by RAISING its target to the cooling limit, and resumes it back down', async () => {
    // Handing a cooling unit its heating limit (16) would make the compressor
    // work harder. While it reports that it is cooling, PELS raises it to the
    // cooling limit instead, and resuming is the move back DOWN to the mode
    // target — the move a heater-shaped reading would take for a deeper limit.
    const device = await buildHeatpumpDevice(22, 2000);
    await device.setCapabilityValue('thermostat_mode', 'cool');
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    enableCapacity(1);
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'heatpump-a': 22 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      'heatpump-a': { action: 'set_temperature', temperature: 16, coolingTemperature: 28 },
    });
    const setHomePower = reportHomePower(5000);
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntilCalledWith(putSpy, cap('heatpump-a', 'target_temperature'), { value: 28 });

    expect(putSpy).not.toHaveBeenCalledWith(cap('heatpump-a', 'target_temperature'), { value: 16 });
    expect(putSpy).not.toHaveBeenCalledWith(cap('heatpump-a', 'onoff'), { value: false });
    putSpy.mockClear();

    // Past the 60 s limit cooldown before relieving, as the heater scenario
    // below is: the resume is now recorded as one, and a resume this
    // soon after a limit is limited again, for a heater and a cooling unit alike.
    await vi.advanceTimersByTimeAsync(70_000);
    setHomePower(100);
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
    await vi.advanceTimersByTimeAsync(90_000);

    expect(putSpy).toHaveBeenCalledWith(cap('heatpump-a', 'target_temperature'), { value: 22 });
    await expect(device.getCapabilityValue('target_temperature')).resolves.toBe(22);
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
    await drainUntilCalledWith(putSpy, cap('heatpump-a', 'target_temperature'), { value: 20 });

    expect(putSpy).toHaveBeenCalledWith(cap('heatpump-a', 'target_temperature'), { value: 20 });
  });

  it('uses only on/off capacity control when temperature control is disabled', async () => {
    const device = await buildHeatpumpDevice(22, 2000);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    enableCapacity(1);
    mockHomeyInstance.settings.set(TEMPERATURE_CONTROL_DISABLED_DEVICES, { 'heatpump-a': true });
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'heatpump-a': 20 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      'heatpump-a': { action: 'set_temperature', temperature: 15 },
    });
    reportHomePower(5000);
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntilCalledWith(putSpy, cap('heatpump-a', 'onoff'), { value: false });

    const targetWrites = putSpy.mock.calls.filter(
      ([path]) => typeof path === 'string' && path.includes('/capability/target_temperature'),
    );
    expect(targetWrites).toEqual([]);
    await expect(device.getCapabilityValue('target_temperature')).resolves.toBe(22);
  });

  it('revokes temperature writes immediately when disabled while the app is running', async () => {
    const device = await buildHeatpumpDevice(22, 2000);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    enableCapacity(1);
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'heatpump-a': 20 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      'heatpump-a': { action: 'set_temperature', temperature: 15 },
    });
    const setHomePower = reportHomePower(0);
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await drainUntilCalledWith(putSpy, cap('heatpump-a', 'target_temperature'), { value: 20 });
    putSpy.mockClear();

    mockHomeyInstance.settings.set(TEMPERATURE_CONTROL_DISABLED_DEVICES, { 'heatpump-a': true });
    setHomePower(5000);
    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntilCalledWith(putSpy, cap('heatpump-a', 'onoff'), { value: false });

    expect(putSpy.mock.calls.some(
      ([path]) => typeof path === 'string' && path.includes('/capability/target_temperature'),
    )).toBe(false);
    await expect(device.getCapabilityValue('target_temperature')).resolves.toBe(20);
  });

  it('keeps limiting by setpoint under manual saving, and does not save a nudge made while limited', async () => {
    // "Save as current mode target" switches off the offsets, not the limit. So
    // under pressure PELS lowers the heater to its limited temperature rather
    // than turning it off — and a temperature the owner sets by hand WHILE it is
    // limited is a reaction to the limit, not a preference: it is not saved, and
    // the executor brings the heater back onto its limit as ordinary drift.
    const device = await buildHeatpumpDevice(24, 2000);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    enableCapacity(1);
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('temperature_control_modes', { 'heatpump-a': 'update_mode' });
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'heatpump-a': 24 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      'heatpump-a': { action: 'set_temperature', temperature: 16 },
    });
    const setHomePower = reportHomePower(5000);
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntilCalledWith(putSpy, cap('heatpump-a', 'target_temperature'), { value: 16 });
    expect(putSpy).not.toHaveBeenCalledWith(cap('heatpump-a', 'onoff'), { value: false });
    putSpy.mockClear();

    // The owner nudges the limited heater up. The live feed is off in tests, so
    // the change arrives the way it does in production: as a `device.update`
    // carrying the new target. Not saved; written back on the next cycle the
    // limit cooldown allows (60 s between limit operations).
    await device.setCapabilityValue('target_temperature', 20);
    app.deviceManager!.injectDeviceUpdateForTest({
      id: 'heatpump-a', name: 'Hallway Heatpump', class: 'heatpump',
      capabilities: ['onoff', 'target_temperature', 'measure_temperature', 'measure_power', 'meter_power', 'thermostat_mode'],
      capabilitiesObj: {
        onoff: { id: 'onoff', value: true },
        measure_power: { id: 'measure_power', value: 2000 },
        measure_temperature: { id: 'measure_temperature', value: 21 },
        target_temperature: { id: 'target_temperature', value: 20, units: '°C' },
      },
    });
    await vi.advanceTimersByTimeAsync(70_000);
    await drainUntilCalledWith(putSpy, cap('heatpump-a', 'target_temperature'), { value: 16 });
    expect(mockHomeyInstance.settings.get('mode_device_targets')).toEqual({ Home: { 'heatpump-a': 24 } });
    putSpy.mockClear();

    setHomePower(100);
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
    await vi.advanceTimersByTimeAsync(90_000);

    expect(putSpy).toHaveBeenCalledWith(cap('heatpump-a', 'target_temperature'), { value: 24 });
    await expect(device.getCapabilityValue('target_temperature')).resolves.toBe(24);
    expect(mockHomeyInstance.settings.get('mode_device_targets')).toEqual({ Home: { 'heatpump-a': 24 } });
  });
});
