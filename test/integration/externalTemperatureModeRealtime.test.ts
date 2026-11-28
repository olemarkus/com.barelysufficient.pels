import { PriceLevel } from '../../lib/price/priceLevels';
import { writeObjectiveForDevice } from '../../lib/objectives/deferredObjectives/objectiveStore';
import { ownWriteTransactionId, pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';
import { buildDeviceActuator } from '../../setup/appInit/buildDeviceActuator';
import { drainPending, drainUntil } from '../utils/asyncDrain';
/** Realtime `device.update` frames arrive on the live feed's socket, as in externalOffHoldRealtime. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, resetMockHomey, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { connectLiveFeed, emitCapability, emitDeviceUpdate } from '../helpers/liveFeedSocketHarness';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';

const deviceId = 'heater-1';
const capabilities = ['onoff', 'measure_power', 'measure_temperature', 'target_temperature'];
// A realtime `device.update` as Homey sends it: every value dated, here at the
// moment of the update.
const update = (temperature: number) => {
  const lastUpdated = new Date().toISOString();
  return { ...HOMEY_DEVICE_FIELDS,
    id: deviceId, name: 'Heat pump', class: 'heater', capabilities,
    capabilitiesObj: {
      onoff: { id: 'onoff', value: true, lastUpdated },
      measure_power: { id: 'measure_power', value: 1000, lastUpdated },
      measure_temperature: { id: 'measure_temperature', value: 20, lastUpdated },
      target_temperature: { id: 'target_temperature', value: temperature, units: '°C', lastUpdated },
    },
  };
};

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
  connectLiveFeed();
  const app = createApp({ preserveStartupRestoreStabilization: true });
  await app.onInit();
  await vi.advanceTimersByTimeAsync(30_000);
  return app;
}

describe('external temperature changes reach the mode through observation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'] });
    vi.setSystemTime(Date.UTC(2026, 8, 8, 12));
    resetMockHomey();
  });
  afterEach(async () => { await cleanupApps(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('saves the new target synchronously without scheduling a rebuild or writing a device', async () => {
    const app = await start('update_mode');
    const rebuild = vi.spyOn(app.planService!, 'rebuildPlanFromCache');
    const put = vi.spyOn(mockHomeyInstance.api, 'put');
    emitDeviceUpdate(update(22));
    expect(mockHomeyInstance.settings.get('mode_device_targets')).toEqual({
      Home: { [deviceId]: 22 }, Away: { [deviceId]: 16 },
    });
    expect(app.homeModeCatalog.getSnapshot().targets.Home?.[deviceId]).toBe(22);
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
    emitDeviceUpdate(update(22));
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
    emitDeviceUpdate(update(22));
    const report = mockHomeyInstance.flow._actionCardListeners.report_power_usage;
    await report({ power: 15_000 });
    await vi.advanceTimersByTimeAsync(2000);
    await drainUntil(() => app.planService!.getLatestPlanSnapshot()?.devices.some(
      (device) => device.id === deviceId && device.plannedState === 'shed',
    ) === true);

    emitDeviceUpdate(update(23));
    await drainPending();

    expect(mockHomeyInstance.settings.get('mode_device_targets')).toMatchObject({ Home: { [deviceId]: 22 } });
    expect(app.homeModeCatalog.getSnapshot().targets.Home?.[deviceId]).toBe(22);
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
    emitDeviceUpdate(update(22));
    const actuator = buildDeviceActuator(app)!;
    expect(await actuator.apply({ kind: 'target', target: 'temperature', purpose: 'plan', deviceId, value: 16 }))
      .toEqual({ requested: false });
    mockHomeyInstance.settings.set('operating_mode', 'Away');
    await drainPending();
    expect(await actuator.apply({ kind: 'target', target: 'temperature', purpose: 'plan', deviceId, value: 16 }))
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
    await start('update_mode');
    mockHomeyInstance.settings.set('mode_device_targets', { Comfort: { [deviceId]: 23.5 }, Away: { [deviceId]: 16 } });
    mockHomeyInstance.settings.set('mode_aliases', { home: 'Comfort' });
    await drainPending();
    emitDeviceUpdate(update(22));
    expect(mockHomeyInstance.settings.get('mode_device_targets')).toMatchObject({ Comfort: { [deviceId]: 22 } });
    expect(mockHomeyInstance.settings.get('mode_device_targets')).not.toHaveProperty('Home');
  });

  it.each(['mode', 'external'])('does not edit mode targets under %s authority', async (policy) => {
    await start(policy);
    emitDeviceUpdate(update(22));
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
    // Absent, and PROVEN absent: the key list does not contain it, which is what
    // separates a never-written key from a listed one that reads empty.
    expect(mockHomeyInstance.settings.get('operating_mode')).toBeNull();
    expect(mockHomeyInstance.settings.getKeys()).not.toContain('operating_mode');
    expect(app.homeModeCatalog.getSnapshot().operatingMode).toBe('Home');

    emitDeviceUpdate(update(22));

    expect(mockHomeyInstance.settings.get('mode_device_targets')).toEqual({
      Home: { [deviceId]: 22 }, Away: { [deviceId]: 16 },
    });
  });

  it('applies the saved target on a never-switched home instead of fencing every write', async () => {
    // The other half of the same absence: `allowsTarget` is the live write fence,
    // and it also read the mode. With no mode it refused every setpoint command,
    // so the target the owner had just saved could never be applied either.
    const app = await start('update_mode', true, false);
    emitDeviceUpdate(update(22));
    const actuator = buildDeviceActuator(app)!;

    expect(await actuator.apply({ kind: 'target', target: 'temperature', purpose: 'plan', deviceId, value: 22 }))
      .toMatchObject({ requested: true });
  });

  describe('Keep until the next change', () => {
    const startHoldPolicy = () => start('hold_until_change');
    const targetFor = (app: Awaited<ReturnType<typeof start>>) => (
      app.planService!.getLatestPlanSnapshot()?.devices.find((device) => device.id === deviceId)
    );
    const rebuildWithPower = async (app: Awaited<ReturnType<typeof start>>, power: number) => {
      await vi.advanceTimersByTimeAsync(60_000);
      const before = app.planService!.getLatestPlanSnapshot();
      await mockHomeyInstance.flow._actionCardListeners.report_power_usage({ power });
      await vi.advanceTimersByTimeAsync(2000);
      await drainUntil(() => app.planService!.getLatestPlanSnapshot() !== before);
      return targetFor(app);
    };

    it('keeps the outside change through the same price level and resumes at the next level', async () => {
      const app = await startHoldPolicy();
      const priceLevel = vi.spyOn(app.priceCoordinator, 'getCurrentHourPriceLevel').mockReturnValue(PriceLevel.EXPENSIVE);
      mockHomeyInstance.settings.set('price_optimization_enabled', true);
      mockHomeyInstance.settings.set('price_optimization_settings', {
        [deviceId]: { enabled: true, cheapDelta: 2, expensiveDelta: -2, surplusWilling: true, surplusDelta: 3 },
      });
      await drainPending();
      expect(await rebuildWithPower(app, 1000)).toMatchObject({ plannedTarget: 21.5 });

      const put = vi.spyOn(mockHomeyInstance.api, 'put');
      const rebuild = vi.spyOn(app.planService!, 'rebuildPlanFromCache');
      emitDeviceUpdate(update(25));
      await drainPending();
      expect(rebuild).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(await rebuildWithPower(app, 1000)).toMatchObject({
        plannedTarget: 25,
        manualTemperatureHold: { targetC: 25, releasesOnPriceLevelChange: true },
      });
      expect(put).not.toHaveBeenCalled();

      priceLevel.mockReturnValue(PriceLevel.NORMAL);
      const resumed = await rebuildWithPower(app, 1000);
      expect(resumed).toMatchObject({ plannedTarget: 23.5 });
      expect(resumed?.manualTemperatureHold).toBeUndefined();
      expect(mockHomeyInstance.settings.get('mode_device_targets')).toMatchObject({ Home: { [deviceId]: 23.5 } });
    });

    it('does not hold a transaction echo or a reported value matching a PELS write', async () => {
      const app = await startHoldPolicy();
      const put = vi.spyOn(mockHomeyInstance.api, 'put');
      await app.deviceManager!.requestTemperatureTarget(deviceId, 18);
      const transactionId = ownWriteTransactionId(put, deviceId, 'target_temperature');
      await emitCapability(deviceId, 'target_temperature', 18, transactionId);
      emitDeviceUpdate(update(18));
      expect(await rebuildWithPower(app, 1000)).toMatchObject({ plannedTarget: 23.5 });
      expect(targetFor(app)?.manualTemperatureHold).toBeUndefined();
    });

    it('releases when the operating mode changes', async () => {
      const app = await startHoldPolicy();
      await rebuildWithPower(app, 1000);
      emitDeviceUpdate(update(26));
      expect(await rebuildWithPower(app, 1000)).toMatchObject({ plannedTarget: 26 });
      mockHomeyInstance.settings.set('operating_mode', 'Away');
      await drainPending();
      expect(await rebuildWithPower(app, 1000)).toMatchObject({ plannedTarget: 16 });
      expect(targetFor(app)?.manualTemperatureHold).toBeUndefined();
    });

    it('accepts a second change during scheduled preparation and lets preparation resume at release', async () => {
      const app = await startHoldPolicy();
      const priceLevel = vi.spyOn(app.priceCoordinator, 'getCurrentHourPriceLevel').mockReturnValue(PriceLevel.EXPENSIVE);
      mockHomeyInstance.settings.set('price_optimization_settings', {
        [deviceId]: { enabled: true, cheapDelta: 0, expensiveDelta: 0 },
      });
      mockHomeyInstance.settings.set('mode_device_targets', { Home: { [deviceId]: 23.5 }, Morning: { [deviceId]: 29 } });
      await drainPending();
      await rebuildWithPower(app, 1000);
      emitDeviceUpdate(update(25));
      expect(await rebuildWithPower(app, 1000)).toMatchObject({ plannedTarget: 25 });
      await mockHomeyInstance.flow._actionCardListeners.prepare_operating_mode({ mode: 'Morning', ready_by: '14:12' });
      expect(await rebuildWithPower(app, 1000)).toMatchObject({ plannedTarget: 25 });
      expect(app.readSchedules(true)).toMatchObject({
        ok: true,
        data: { preparationPlan: { devices: [{ deviceId, state: 'manual_temperature_hold' }] } },
      });

      emitDeviceUpdate(update(27));
      expect(await rebuildWithPower(app, 1000)).toMatchObject({
        plannedTarget: 27, manualTemperatureHold: { targetC: 27 },
      });
      priceLevel.mockReturnValue(PriceLevel.NORMAL);
      expect(await rebuildWithPower(app, 1000)).toMatchObject({
        plannedTarget: 29, modePreparation: { mode: 'Morning' },
      });
      expect(targetFor(app)?.manualTemperatureHold).toBeUndefined();
    });

    it('releases when a Smart task is set and does not re-arm during it', async () => {
      const app = await startHoldPolicy();
      emitDeviceUpdate(update(26));
      expect(await rebuildWithPower(app, 1000)).toMatchObject({ plannedTarget: 26 });
      writeObjectiveForDevice(mockHomeyInstance.settings, deviceId, {
        enabled: true, kind: 'temperature', enforcement: 'soft',
        targetTemperatureC: 24, deadlineAtMs: Date.now() + 6 * 60 * 60_000,
      });
      await rebuildWithPower(app, 1000);
      expect(targetFor(app)?.manualTemperatureHold).toBeUndefined();
      emitDeviceUpdate(update(29));
      await rebuildWithPower(app, 1000);
      expect(targetFor(app)?.manualTemperatureHold).toBeUndefined();
    });

    it('blocks a stale normal write to the limit value and still lowers the target to limit power', async () => {
      const app = await start('hold_until_change', false);
      mockHomeyInstance.settings.set('overshoot_behaviors', { [deviceId]: { action: 'set_temperature', temperature: 16 } });
      await drainPending();
      await rebuildWithPower(app, 1000);
      await emitCapability(deviceId, 'target_temperature', 26);
      const actuator = buildDeviceActuator(app)!;
      expect(await actuator.apply({
        kind: 'target', target: 'temperature', deviceId, purpose: 'plan', value: 16,
      })).toEqual({ requested: false });

      const put = vi.spyOn(mockHomeyInstance.api, 'put');
      expect(await rebuildWithPower(app, 15_000)).toMatchObject({
        plannedState: 'shed', shedAction: 'set_temperature', plannedTarget: 16,
        manualTemperatureHold: { targetC: 26 },
      });
      expect(put).toHaveBeenCalledWith(
        `manager/devices/device/${deviceId}/capability/target_temperature`, pelsCapabilityWrite(16),
      );
      // A clamped limit report must not replace the hold.
      await emitCapability(deviceId, 'target_temperature', 18);
      expect(await rebuildWithPower(app, 15_000)).toMatchObject({ manualTemperatureHold: { targetC: 26 } });
    });
  });

  it('never adopts a delayed echo of its own temperature write', async () => {
    const app = await start('update_mode');
    await app.deviceManager!.requestTemperatureTarget(deviceId, 18);
    await vi.advanceTimersByTimeAsync(6000);
    emitDeviceUpdate(update(18));
    expect(mockHomeyInstance.settings.get('mode_device_targets')).toMatchObject({ Home: { [deviceId]: 23.5 } });
    emitDeviceUpdate(update(22));
    expect(mockHomeyInstance.settings.get('mode_device_targets')).toMatchObject({ Home: { [deviceId]: 22 } });
  });
});
