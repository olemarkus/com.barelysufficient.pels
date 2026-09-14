import { buildDeviceActuator } from '../../setup/appInit/buildDeviceActuator';
import { drainPending, drainUntil } from '../utils/asyncDrain';
/** Live-feed injection is the same integration seam as externalOffHoldRealtime. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';

const deviceId = 'heater-1';
const capabilities = ['onoff', 'measure_power', 'measure_temperature', 'target_temperature'];
const update = (temperature: number) => ({
  id: deviceId, name: 'Heat pump', class: 'heater', capabilities,
  capabilitiesObj: {
    onoff: { id: 'onoff', value: true },
    measure_power: { id: 'measure_power', value: 1000 },
    measure_temperature: { id: 'measure_temperature', value: 20 },
    target_temperature: { id: 'target_temperature', value: temperature, units: '°C' },
  },
});

async function start(policy: string, hasBinary = true, seedOperatingMode = true) {
  const device = new MockDevice(deviceId, 'Heat pump', hasBinary ? capabilities : capabilities.filter((id) => id !== 'onoff'), 'heater');
  if (hasBinary) await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('measure_power', 1000);
  await device.setCapabilityValue('measure_temperature', 20);
  await device.setCapabilityValue('target_temperature', 23.5);
  setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
  for (const [key, value] of Object.entries({
    power_source: 'flow', capacity_limit_kw: 10, capacity_margin_kw: 0,
    capacity_dry_run: false,
    // A home whose owner has never switched mode has NO `operating_mode` key:
    // it is written only by an explicit mode change. See the fresh-install case.
    ...(seedOperatingMode ? { operating_mode: 'Home' } : {}),
    controllable_devices: { [deviceId]: true }, managed_devices: { [deviceId]: true },
    mode_device_targets: { Home: { [deviceId]: 23.5 }, Away: { [deviceId]: 16 } },
    temperature_control_modes: { [deviceId]: policy },
  })) mockHomeyInstance.settings.set(key, value);
  const app = createApp({ preserveStartupRestoreStabilization: true });
  await app.onInit();
  await vi.advanceTimersByTimeAsync(30_000);
  return app;
}

describe('external temperature changes reach the mode through observation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'] });
    vi.setSystemTime(Date.UTC(2026, 8, 8, 12));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
  });
  afterEach(async () => { await cleanupApps(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('saves the new target synchronously without scheduling a rebuild or writing a device', async () => {
    const app = await start('update_mode');
    const rebuild = vi.spyOn(app.planService!, 'rebuildPlanFromCache');
    const put = vi.spyOn(mockHomeyInstance.api, 'put');
    app.deviceManager!.injectDeviceUpdateForTest(update(22));
    expect(mockHomeyInstance.settings.get('mode_device_targets')).toEqual({
      Home: { [deviceId]: 22 }, Away: { [deviceId]: 16 },
    });
    expect(app.modeDeviceTargets.Home?.[deviceId]).toBe(22);
    await drainPending();
    expect(rebuild).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('the next meter-driven plan reads the adopted target, and the configured limit still applies', async () => {
    // "Save as current mode target" switches off the offsets, not the limit:
    // the owner's limited temperature is what PELS lowers the device to under
    // pressure, and the target it saved is what it comes back to.
    const app = await start('update_mode');
    mockHomeyInstance.settings.set('overshoot_behaviors', { [deviceId]: { action: 'set_temperature', temperature: 16 } });
    await drainPending();
    app.deviceManager!.injectDeviceUpdateForTest(update(22));
    const report = mockHomeyInstance.flow._actionCardListeners.report_power_usage;
    await report({ power: 1000 });
    await vi.advanceTimersByTimeAsync(2000);
    await drainUntil(() => app.planService!.getLatestPlanSnapshot()?.devices.some(
      (device) => device.id === deviceId && 'plannedTarget' in device && device.plannedTarget === 22,
    ) === true);
    await vi.advanceTimersByTimeAsync(60_000);
    await report({ power: 15_000 });
    await vi.advanceTimersByTimeAsync(2000);
    await drainUntil(() => app.planService!.getLatestPlanSnapshot()?.devices.some(
      (device) => device.id === deviceId && device.plannedState === 'shed',
    ) === true);
    const limited = app.planService!.getLatestPlanSnapshot()?.devices.find((device) => device.id === deviceId);
    expect(limited).toMatchObject({ plannedTarget: 16, shedAction: 'set_temperature' });
    expect(mockHomeyInstance.settings.get('mode_device_targets')).toMatchObject({ Home: { [deviceId]: 22 } });
  });

  it('does not save a change made while the device is limited', async () => {
    // A nudge during a peak is a reaction to the limit, not a preference. The
    // saved target stays what the owner chose while unlimited; the executor
    // reconciles the nudge back onto the limit as ordinary drift.
    const app = await start('update_mode');
    mockHomeyInstance.settings.set('overshoot_behaviors', { [deviceId]: { action: 'set_temperature', temperature: 16 } });
    await drainPending();
    app.deviceManager!.injectDeviceUpdateForTest(update(22));
    const report = mockHomeyInstance.flow._actionCardListeners.report_power_usage;
    await report({ power: 15_000 });
    await vi.advanceTimersByTimeAsync(2000);
    await drainUntil(() => app.planService!.getLatestPlanSnapshot()?.devices.some(
      (device) => device.id === deviceId && device.plannedState === 'shed',
    ) === true);

    app.deviceManager!.injectDeviceUpdateForTest(update(23));
    await drainPending();

    expect(mockHomeyInstance.settings.get('mode_device_targets')).toMatchObject({ Home: { [deviceId]: 22 } });
    expect(app.modeDeviceTargets.Home?.[deviceId]).toBe(22);
  });

  it('keeps saved price and solar settings without applying their offsets', async () => {
    const app = await start('update_mode');
    const config = { enabled: true, cheapDelta: 2, expensiveDelta: -2, surplusWilling: true, surplusDelta: 3 };
    mockHomeyInstance.settings.set('price_optimization_settings', { [deviceId]: config });
    await drainPending();
    expect(app.priceOptimizationSettings[deviceId]).toMatchObject({ enabled: false, surplusWilling: false });
    expect(mockHomeyInstance.settings.get('price_optimization_settings')).toEqual({ [deviceId]: config });
    mockHomeyInstance.settings.set('temperature_control_modes', { [deviceId]: 'mode' });
    await drainPending();
    expect(app.priceOptimizationSettings[deviceId]).toMatchObject(config);
  });

  it('blocks old adjusted commands but applies the saved target when the mode changes', async () => {
    const app = await start('update_mode');
    app.deviceManager!.injectDeviceUpdateForTest(update(22));
    const actuator = buildDeviceActuator(app)!;
    expect(await actuator.apply({ kind: 'target', target: 'temperature', deviceId, value: 16 }))
      .toEqual({ requested: false });
    mockHomeyInstance.settings.set('operating_mode', 'Away');
    await drainPending();
    expect(await actuator.apply({ kind: 'target', target: 'temperature', deviceId, value: 16 }))
      .toMatchObject({ requested: true, requestedTargetValue: 16 });
    expect(mockHomeyInstance.settings.get('mode_device_targets')).toMatchObject({ Home: { [deviceId]: 22 } });
  });

  it('still limits a device whose only control is temperature, by setpoint', async () => {
    // "Save as current mode target" switches off the offsets, not the limit. A
    // device with nothing but a setpoint to limit on keeps its authority and is
    // lowered to its limited temperature under pressure — this is the
    // auto-seeded air-conditioner shape, so a `commandAuthority: false` here
    // would leave exactly those devices unlimited while the UI says otherwise.
    const app = await start('update_mode', false);
    mockHomeyInstance.settings.set('overshoot_behaviors', { [deviceId]: { action: 'set_temperature', temperature: 16 } });
    await drainPending();
    await mockHomeyInstance.flow._actionCardListeners.report_power_usage({ power: 15_000 });
    await vi.advanceTimersByTimeAsync(2000);
    await drainUntil(() => app.planService!.getLatestPlanSnapshot()?.devices.some(
      (device) => device.id === deviceId && device.plannedState === 'shed',
    ) === true);
    const device = app.planService!.getLatestPlanSnapshot()?.devices.find((candidate) => candidate.id === deviceId);
    expect(device).toMatchObject({
      control: expect.objectContaining({ commandAuthority: true }),
      plannedState: 'shed',
      shedAction: 'set_temperature',
      plannedTarget: 16,
    });
  });

  it('resolves a retained Main mode alias before saving an external adjustment', async () => {
    const app = await start('update_mode');
    mockHomeyInstance.settings.set('mode_device_targets', { Comfort: { [deviceId]: 23.5 }, Away: { [deviceId]: 16 } });
    mockHomeyInstance.settings.set('mode_aliases', { home: 'Comfort' });
    await drainPending();
    app.deviceManager!.injectDeviceUpdateForTest(update(22));
    expect(mockHomeyInstance.settings.get('mode_device_targets')).toMatchObject({ Comfort: { [deviceId]: 22 } });
    expect(mockHomeyInstance.settings.get('mode_device_targets')).not.toHaveProperty('Home');
  });

  it.each(['mode', 'external'])('does not edit mode targets under %s authority', async (policy) => {
    const app = await start(policy);
    app.deviceManager!.injectDeviceUpdateForTest(update(22));
    expect(mockHomeyInstance.settings.get('mode_device_targets')).toMatchObject({ Home: { [deviceId]: 23.5 } });
  });

  it('saves the target on a home whose owner has never switched mode', async () => {
    // The fresh-install shape. `operating_mode` is written only by an explicit
    // mode change, so a new home does not have the key at all — while the app has
    // been running in the default mode since boot. Reading that proven absence as
    // "no mode" silently disabled the whole feature: the owner chose Save as
    // current mode target, adjusted the thermostat, and nothing was saved, with no
    // log and no UI signal, until the first mode switch.
    const app = await start('update_mode', true, false);
    // Absent, and PROVEN absent: the key list is healthy and does not contain it,
    // which is what separates a fresh install from a transient read miss.
    expect(mockHomeyInstance.settings.get('operating_mode')).toBeNull();
    expect(mockHomeyInstance.settings.getKeys()).not.toContain('operating_mode');
    expect(app.operatingMode).toBe('Home');

    app.deviceManager!.injectDeviceUpdateForTest(update(22));

    expect(mockHomeyInstance.settings.get('mode_device_targets')).toEqual({
      Home: { [deviceId]: 22 }, Away: { [deviceId]: 16 },
    });
  });

  it('applies the saved target on a never-switched home instead of fencing every write', async () => {
    // The other half of the same absence: `allowsTarget` is the live write fence,
    // and it also read the mode. With no mode it refused every setpoint command,
    // so the target the owner had just saved could never be applied either.
    const app = await start('update_mode', true, false);
    app.deviceManager!.injectDeviceUpdateForTest(update(22));
    const actuator = buildDeviceActuator(app)!;

    expect(await actuator.apply({ kind: 'target', target: 'temperature', deviceId, value: 22 }))
      .toMatchObject({ requested: true });
  });

  it('never adopts a delayed echo of its own temperature write', async () => {
    const app = await start('update_mode');
    await app.deviceManager!.requestTemperatureTarget(deviceId, 18);
    await vi.advanceTimersByTimeAsync(6000);
    app.deviceManager!.injectDeviceUpdateForTest(update(18));
    expect(mockHomeyInstance.settings.get('mode_device_targets')).toMatchObject({ Home: { [deviceId]: 23.5 } });
    app.deviceManager!.injectDeviceUpdateForTest(update(22));
    expect(mockHomeyInstance.settings.get('mode_device_targets')).toMatchObject({ Home: { [deviceId]: 22 } });
  });
});
