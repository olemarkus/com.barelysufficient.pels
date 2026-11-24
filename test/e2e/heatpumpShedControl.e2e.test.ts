// SDK-boundary e2e for heatpump (thermostat-class) capacity control.
//
// Nothing internal is mocked. Power enters through the real Homey Energy poll
// (`api.get('manager/energy/live')` — the SDK seam), drives the real capacity guard +
// planner + executor, and the only thing asserted is what PELS writes back through the
// SDK (`api.put` device-capability commands). No plan/target snapshot reads, no
// capacity-pace override.
//
// Counterpart to test/integration/heatpumpDevices.integration.test.ts, which keeps the
// power-estimation classification cases (no externally observable effect).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import { mockHomeyInstance, resetMockHomey, setMockDrivers, setMockZones, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { connectLiveFeed, emitDeviceUpdate } from '../helpers/liveFeedSocketHarness';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  TEMPERATURE_CONTROL_DISABLED_DEVICES,
} from '../../lib/utils/settingsKeys';
import { drainUntilCalledWith } from '../utils/asyncDrain';
import { pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';

const cap = (deviceId: string, capability: string) =>
  `manager/devices/device/${deviceId}/capability/${capability}`;

const buildHeatpumpDevice = async (targetTemperature: number, powerW: number, extraCapabilities: string[] = []) => {
  const device = new MockDevice(
    'heatpump-a',
    'Hallway Heatpump',
    ['onoff', 'target_temperature', 'measure_temperature', 'measure_power', 'meter_power', 'thermostat_mode', ...extraCapabilities],
    'heatpump',
  );
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('measure_power', powerW);
  await device.setCapabilityValue('meter_power', 100);
  await device.setCapabilityValue('thermostat_mode', 'heat');
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
    // 'Date' and 'performance' MUST be faked: the plan-rebuild scheduler reads
    // the monotonic clock and the rest of the app reads Date. Either left real
    // runs on real time against the fake timers and strands the rebuild.
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

  it.each(['device', 'zone'] as const)('holds a heater off through headroom with a %s pause', async (kind) => {
    const device = await buildHeatpumpDevice(17, 1500);
    device.setZone('z-heating');
    setMockZones({ 'z-heating': { id: 'z-heating', name: 'Living room', parent: null } });
    setMockDrivers({ heating: new MockDriver('heating', [device]) });
    enableCapacity(10);
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'heatpump-a': 17 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      'heatpump-a': { action: 'set_temperature', temperature: 15 },
    });
    const setHousePower = reportHomePower(1600);
    const put = vi.spyOn(mockHomeyInstance.api, 'put');
    const onoff = cap('heatpump-a', 'onoff');
    const target = cap('heatpump-a', 'target_temperature');
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(30_000);

    const scope = { id: kind === 'device' ? 'device:heatpump-a' : 'zone:z-heating' };
    const flow = mockHomeyInstance.flow;
    await expect(flow._actionCardAutocompleteListeners.pause_heating_for_open_window.scope(''))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining(scope)]));
    put.mockClear();
    const minutes = kind === 'device' ? 5 : 2;
    await expect(flow._actionCardListeners.pause_heating_for_open_window({ scope, minutes })).resolves.toBe(true);
    expect(put).not.toHaveBeenCalledWith(onoff, pelsCapabilityWrite(false));
    await vi.advanceTimersByTimeAsync(40_000);
    await drainUntilCalledWith(put, onoff, pelsCapabilityWrite(false));

    setHousePower(100);
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'heatpump-a': 22 } });
    put.mockClear();
    await vi.advanceTimersByTimeAsync(40_000);
    const plan = await api.ui_plan({ homey: app.homey });
    expect(plan.plan?.devices?.find(({ id }) => id === 'heatpump-a')?.status).toMatchObject({
      limited: false,
      reason: { text: 'Paused for open window' },
    });
    expect(put).not.toHaveBeenCalledWith(onoff, pelsCapabilityWrite(true));
    expect(put).not.toHaveBeenCalledWith(target, pelsCapabilityWrite(22));

    if (kind === 'device') {
      await expect(flow._actionCardListeners.resume_heating_after_open_window({ scope })).resolves.toBe(true);
      expect(put).not.toHaveBeenCalledWith(onoff, pelsCapabilityWrite(true));
    }
    await vi.advanceTimersByTimeAsync(130_000);
    await drainUntilCalledWith(put, onoff, pelsCapabilityWrite(true));
    await drainUntilCalledWith(put, target, pelsCapabilityWrite(22));
  });

  it.each(['ordinary', 'custom power mode', 'malformed meter'] as const)(
    'keeps temperature capacity control with %s fields when home power exceeds the limit', async (shape) => {
    const device = await buildHeatpumpDevice(22, 2000, shape === 'custom power mode' ? ['target_power_mode'] : []);
    if (shape === 'custom power mode') {
      device.setDriverIdentity({ driverUri: 'homey:app:com.toshiba', driverId: 'ac' });
      await device.setCapabilityValue('target_power_mode', 'Power 100%');
    }
    if (shape === 'malformed meter') await device.setCapabilityValue('meter_power', 'invalid');
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
    await drainUntilCalledWith(putSpy, cap('heatpump-a', 'target_temperature'), pelsCapabilityWrite(15));

    expect(putSpy).toHaveBeenCalledWith(cap('heatpump-a', 'target_temperature'), pelsCapabilityWrite(15));
    const turnedOff = putSpy.mock.calls.some(
      ([path]) => typeof path === 'string' && path.endsWith('/capability/onoff'),
    );
    expect(turnedOff).toBe(false);
  });

  it('prepares a scheduled mode on meter readings and keeps the target through the handoff', async () => {
    vi.setSystemTime(Date.UTC(2026, 0, 15, 9, 59));
    const device = await buildHeatpumpDevice(17, 500);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    enableCapacity(10);
    mockHomeyInstance.settings.set('operating_mode', 'Night');
    mockHomeyInstance.settings.set('temperature_control_modes', { 'heatpump-a': 'update_mode' });
    mockHomeyInstance.settings.set('mode_device_targets', { Night: { 'heatpump-a': 17 }, Home: { 'heatpump-a': 22 } });
    mockHomeyInstance.settings.set('schedule.morning', {
      id: 'morning', name: 'Morning', enabled: true, at: '13:00',
      repeat: { type: 'once', date: '2026-01-15' }, condition: { type: 'include', modes: ['Night'] },
      action: { type: 'mode', mode: 'Home', prepare: true },
    });
    reportHomePower(500);
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const targetPath = cap('heatpump-a', 'target_temperature');

    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(putSpy).not.toHaveBeenCalledWith(targetPath, pelsCapabilityWrite(22));
    const unscoped = await api.ui_devices({ homey: app.homey });
    expect(unscoped.schedules).not.toHaveProperty('data.preparationPlan');
    const ignoredQuery = await api.ui_devices({ homey: app.homey, query: { modePreparation: ['next'] } });
    expect(ignoredQuery).toEqual(unscoped);
    const preview = () => api.ui_devices({ homey: app.homey, query: { modePreparation: 'next' } });
    const initialPreview = await preview();
    expect(Object.keys(initialPreview)).toEqual(['schedules']);
    expect(initialPreview.schedules).toMatchObject({
      ok: true, data: { preparationPlan: {
        state: 'ready', currentMode: 'Night', destinationMode: 'Home',
        devices: [{ deviceId: 'heatpump-a', fromC: 17, targetC: 22, state: 'estimated' }],
      } },
    });

    await vi.advanceTimersByTimeAsync(90_000);
    await drainUntilCalledWith(putSpy, targetPath, pelsCapabilityWrite(22));
    expect(putSpy).toHaveBeenCalledWith(targetPath, pelsCapabilityWrite(22));
    expect(mockHomeyInstance.settings.get('operating_mode')).toBe('Night');
    expect((await preview()).schedules).toMatchObject({
      ok: true, data: { preparationPlan: { devices: [{ deviceId: 'heatpump-a', state: 'preparing' }] } },
    });
    const reason = () => app.planService?.getLatestPlanSnapshotForUi()?.devices
      ?.find((candidate) => candidate.id === 'heatpump-a')?.status.reason?.text;
    expect(reason()).toBe('Getting ready for Home at 13:00');
    expect(mockHomeyInstance.settings.get('mode_device_targets')).toEqual({
      Night: { 'heatpump-a': 17 }, Home: { 'heatpump-a': 22 },
    });
    putSpy.mockClear();

    vi.setSystemTime(Date.UTC(2026, 0, 15, 11, 59, 55));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockHomeyInstance.settings.get('operating_mode')).toBe('Home');
    expect(reason()).not.toBe('Getting ready for Home at 13:00');
    expect(putSpy).not.toHaveBeenCalledWith(targetPath, pelsCapabilityWrite(17));
    expect(app.readSchedules()).toMatchObject({
      ok: true, data: { entries: [{ lastResult: 'Mode changed. The device was below its target.' }] },
    });
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
    await drainUntilCalledWith(putSpy, cap('heatpump-a', 'target_temperature'), pelsCapabilityWrite(28));

    expect(putSpy).not.toHaveBeenCalledWith(cap('heatpump-a', 'target_temperature'), pelsCapabilityWrite(16));
    expect(putSpy).not.toHaveBeenCalledWith(cap('heatpump-a', 'onoff'), pelsCapabilityWrite(false));
    putSpy.mockClear();

    // Past the 60 s limit cooldown before relieving, as the heater scenario
    // below is: the resume is now recorded as one, and a resume this
    // soon after a limit is limited again, for a heater and a cooling unit alike.
    await vi.advanceTimersByTimeAsync(70_000);
    setHomePower(100);
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
    await vi.advanceTimersByTimeAsync(90_000);

    expect(putSpy).toHaveBeenCalledWith(cap('heatpump-a', 'target_temperature'), pelsCapabilityWrite(22));
    await expect(device.getCapabilityValue('target_temperature')).resolves.toBe(22);
  });

  it('holds a cooling unit whose limit would add demand where it is when the meter goes silent', async () => {
    // The owner's cooling limit (20) sits BELOW the unit's cooling target (24):
    // writing it would make the compressor work harder. With the meter silent
    // past the shed timeout, PELS sheds everything it controls — the plug turns
    // off — but the cooling unit is held at 24, never moved to its limit.
    const device = await buildHeatpumpDevice(24, 2000);
    await device.setCapabilityValue('thermostat_mode', 'cool');
    const plug = new MockDevice('plug-a', 'Plug', ['onoff', 'measure_power'], 'socket');
    await plug.setCapabilityValue('onoff', true);
    await plug.setCapabilityValue('measure_power', 500);
    setMockDrivers({ driverA: new MockDriver('driverA', [device, plug]) });
    enableCapacity(10);
    mockHomeyInstance.settings.set('controllable_devices', { 'heatpump-a': true, 'plug-a': true });
    mockHomeyInstance.settings.set('managed_devices', { 'heatpump-a': true, 'plug-a': true });
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'heatpump-a': 24 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      'heatpump-a': { action: 'set_temperature', temperature: 16, coolingTemperature: 20 },
    });
    let meterReports = true;
    const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
      if (path === 'manager/energy/live') {
        return { items: meterReports ? [{ type: 'cumulative', id: 'meter-main', values: { W: 2500 } }] : [] };
      }
      return originalGet(path);
    });
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(putSpy).not.toHaveBeenCalledWith(cap('plug-a', 'onoff'), pelsCapabilityWrite(false));

    meterReports = false;
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await drainUntilCalledWith(putSpy, cap('plug-a', 'onoff'), pelsCapabilityWrite(false));

    expect(putSpy).not.toHaveBeenCalledWith(cap('heatpump-a', 'target_temperature'), pelsCapabilityWrite(20));
    await expect(device.getCapabilityValue('target_temperature')).resolves.toBe(24);
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
    await drainUntilCalledWith(putSpy, cap('heatpump-a', 'target_temperature'), pelsCapabilityWrite(20));

    expect(putSpy).toHaveBeenCalledWith(cap('heatpump-a', 'target_temperature'), pelsCapabilityWrite(20));
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
    await drainUntilCalledWith(putSpy, cap('heatpump-a', 'onoff'), pelsCapabilityWrite(false));

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
    await drainUntilCalledWith(putSpy, cap('heatpump-a', 'target_temperature'), pelsCapabilityWrite(20));
    putSpy.mockClear();

    mockHomeyInstance.settings.set(TEMPERATURE_CONTROL_DISABLED_DEVICES, { 'heatpump-a': true });
    setHomePower(5000);
    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntilCalledWith(putSpy, cap('heatpump-a', 'onoff'), pelsCapabilityWrite(false));

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
    connectLiveFeed();
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntilCalledWith(putSpy, cap('heatpump-a', 'target_temperature'), pelsCapabilityWrite(16));
    expect(putSpy).not.toHaveBeenCalledWith(cap('heatpump-a', 'onoff'), pelsCapabilityWrite(false));
    putSpy.mockClear();

    // The owner nudges the limited heater up. The change arrives the way it does
    // in production: as a `device.update` on the live feed, carrying the new
    // target. Not saved; written back on the next cycle the limit cooldown
    // allows (60 s between limit operations). Homey dates every value in the
    // update; the nudge happens now.
    await device.setCapabilityValue('target_temperature', 20);
    const lastUpdated = new Date().toISOString();
    emitDeviceUpdate({ ...HOMEY_DEVICE_FIELDS,
      id: 'heatpump-a', name: 'Hallway Heatpump', class: 'heatpump',
      capabilities: ['onoff', 'target_temperature', 'measure_temperature', 'measure_power', 'meter_power', 'thermostat_mode'],
      capabilitiesObj: {
        onoff: { id: 'onoff', value: true, lastUpdated },
        measure_power: { id: 'measure_power', value: 2000, lastUpdated },
        measure_temperature: { id: 'measure_temperature', value: 21, lastUpdated },
        target_temperature: { id: 'target_temperature', value: 20, lastUpdated, units: '°C' },
        meter_power: { id: 'meter_power', value: 100, lastUpdated },
        thermostat_mode: { id: 'thermostat_mode', value: 'heat', lastUpdated },
      },
    });
    await vi.advanceTimersByTimeAsync(70_000);
    await drainUntilCalledWith(putSpy, cap('heatpump-a', 'target_temperature'), pelsCapabilityWrite(16));
    expect(mockHomeyInstance.settings.get('mode_device_targets')).toEqual({ Home: { 'heatpump-a': 24 } });
    putSpy.mockClear();

    setHomePower(100);
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
    await vi.advanceTimersByTimeAsync(90_000);

    expect(putSpy).toHaveBeenCalledWith(cap('heatpump-a', 'target_temperature'), pelsCapabilityWrite(24));
    await expect(device.getCapabilityValue('target_temperature')).resolves.toBe(24);
    expect(mockHomeyInstance.settings.get('mode_device_targets')).toEqual({ Home: { 'heatpump-a': 24 } });
  });
});
