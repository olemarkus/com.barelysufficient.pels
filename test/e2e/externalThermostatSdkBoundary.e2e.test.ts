import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CONTROLLABLE_DEVICES, DEVICE_EXTERNAL_THERMOSTATS,
  MANAGED_DEVICES, OVERSHOOT_BEHAVIORS,
} from '../../lib/utils/settingsKeys';
import { connectLiveFeed } from '../helpers/liveFeedSocketHarness';
import { pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { drainUntilCalledWith } from '../utils/asyncDrain';

const thermostatTarget = 'manager/devices/device/thermostat/capability/target_temperature';
const relaySwitch = 'manager/devices/device/load/capability/onoff';

async function configureExternalThermostat(waitForManualOn: boolean): Promise<MockDevice> {
  const { settings, api } = mockHomeyInstance;
  settings.set('power_source', 'homey_energy');
  settings.set('homey_energy_meter_device_id', 'meter-main');
  settings.set(CAPACITY_LIMIT_KW, 1);
  settings.set(CAPACITY_MARGIN_KW, 0);
  settings.set(CAPACITY_DRY_RUN, false);
  settings.set(MANAGED_DEVICES, { load: true });
  settings.set(CONTROLLABLE_DEVICES, { load: true });
  settings.set(OVERSHOOT_BEHAVIORS, { load: { action: 'set_temperature', temperature: 16 } });
  settings.set(DEVICE_EXTERNAL_THERMOSTATS, {
    load: { thermostatId: 'thermostat', ...(waitForManualOn ? { waitForManualOn: true } : {}) },
  });

  const load = new MockDevice('load', 'Heater load', ['onoff', 'measure_power'], 'socket');
  await load.setCapabilityValue('onoff', !waitForManualOn);
  await load.setCapabilityValue('measure_power', 2300);
  const thermostat = new MockDevice('thermostat', 'Room thermostat', ['measure_temperature', 'target_temperature'], 'thermostat');
  thermostat.removeCapability('measure_power');
  thermostat.setCapabilityMetadata('target_temperature', { setable: true });
  setMockDrivers({ fixtures: new MockDriver('fixtures', [load, thermostat]) });

  const get = api.get.bind(api);
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => (
    path === 'manager/energy/live'
      ? { items: [{ type: 'cumulative', id: 'meter-main', values: { W: 5000 } }] }
      : get(path)
  ));
  return load;
}

describe('External thermostat at the Homey SDK boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval',
        'clearImmediate', 'performance'],
    });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 0));
    resetMockHomey();
    setMockDrivers({});
    connectLiveFeed();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('limits the metered load by writing only to the thermostat setpoint', async () => {
    await configureExternalThermostat(false);
    const put = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(90_000);

    await drainUntilCalledWith(put, thermostatTarget, pelsCapabilityWrite(16));
    expect(put).toHaveBeenCalledWith(thermostatTarget, pelsCapabilityWrite(16));
    expect(put.mock.calls.map(([path]) => path)).not.toContain(relaySwitch);
  });

  it('reports a refused setpoint request without sending a capability write', async () => {
    await configureExternalThermostat(false);
    const app = createApp();
    await app.onInit();
    const put = vi.spyOn(mockHomeyInstance.api, 'put');

    await expect(app.deviceManager.setCapability('load', 'target_temperature', 18)).resolves.toEqual(expect.any(Symbol));
    await expect(app.deviceManager.requestTemperatureTarget('load', 18)).resolves.toBe(false);
    expect(put.mock.calls.map(([path]) => path)).not.toContain(thermostatTarget);
  });

  it('keeps a held relay off until Homey observes its switch on', async () => {
    const load = await configureExternalThermostat(true);
    const put = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(put.mock.calls.map(([path]) => path)).not.toContain(thermostatTarget);
    expect(put.mock.calls.map(([path]) => path)).not.toContain(relaySwitch);

    load.tapTile({ emitCapabilityEvent: true, emitDeviceUpdate: true });
    await vi.advanceTimersByTimeAsync(90_000);
    await drainUntilCalledWith(put, thermostatTarget, pelsCapabilityWrite(16));
    expect(put).toHaveBeenCalledWith(thermostatTarget, pelsCapabilityWrite(16));
    expect(put.mock.calls.map(([path]) => path)).not.toContain(relaySwitch);
  });
});
