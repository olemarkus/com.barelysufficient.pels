import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, LAST_RESORT_DEVICES, RESPECT_EXTERNAL_OFF_DEVICES,
} from '../../lib/utils/settingsKeys';
import { pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { drainUntilCalledWith } from '../utils/asyncDrain';

describe('Last-resort relay (SDK boundary)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval',
        'clearImmediate', 'performance'],
    });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 0));
    resetMockHomey();
    setMockDrivers({});
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('cuts an unmetered relay and waits for room for its full maximum before resuming', async () => {
    const { settings, api } = mockHomeyInstance;
    settings.set('power_source', 'homey_energy');
    settings.set('homey_energy_meter_device_id', 'meter-main');
    settings.set(CAPACITY_LIMIT_KW, 10);
    settings.set(CAPACITY_MARGIN_KW, 0);
    settings.set(CAPACITY_DRY_RUN, false);
    settings.set('managed_devices', { relay: true });
    settings.set(LAST_RESORT_DEVICES, { relay: 6000 });

    const relay = new MockDevice('relay', 'Unmetered relay', ['onoff'], 'socket');
    relay.removeCapability('measure_power');
    await relay.setCapabilityValue('onoff', true);
    setMockDrivers({ relays: new MockDriver('relays', [relay]) });

    let householdW = 18_000;
    const get = api.get.bind(api);
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === 'manager/energy/live') {
        return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: householdW } }] };
      }
      return get(path);
    });
    const put = vi.spyOn(api, 'put');
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(90_000);

    const endpoint = 'manager/devices/device/relay/capability/onoff';
    await drainUntilCalledWith(put, endpoint, pelsCapabilityWrite(false));
    expect(put).toHaveBeenCalledWith(endpoint, pelsCapabilityWrite(false));

    householdW = 7000;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(put).not.toHaveBeenCalledWith(endpoint, pelsCapabilityWrite(true));

    householdW = 1000;
    await vi.advanceTimersByTimeAsync(60_000);
    await drainUntilCalledWith(put, endpoint, pelsCapabilityWrite(true));
    expect(put).toHaveBeenCalledWith(endpoint, pelsCapabilityWrite(true));
  });

  it('keeps an already-off relay off through upgrade, then starts it when the hold is disabled', async () => {
    const { settings, api } = mockHomeyInstance;
    settings.set('power_source', 'homey_energy');
    settings.set('homey_energy_meter_device_id', 'meter-main');
    settings.set(CAPACITY_LIMIT_KW, 10);
    settings.set(CAPACITY_MARGIN_KW, 0);
    settings.set(CAPACITY_DRY_RUN, false);
    settings.set('managed_devices', { relay: true });
    settings.set(LAST_RESORT_DEVICES, { relay: 6000 });

    const relay = new MockDevice('relay', 'Unmetered relay', ['onoff'], 'socket');
    relay.removeCapability('measure_power');
    await relay.setCapabilityValue('onoff', false);
    setMockDrivers({ relays: new MockDriver('relays', [relay]) });

    const get = api.get.bind(api);
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => (
      path === 'manager/energy/live'
        ? { items: [{ type: 'cumulative', id: 'meter-main', values: { W: 1000 } }] }
        : get(path)
    ));
    const put = vi.spyOn(api, 'put');
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(90_000);

    const endpoint = 'manager/devices/device/relay/capability/onoff';
    expect(settings.get(RESPECT_EXTERNAL_OFF_DEVICES)).toEqual({ relay: true });
    expect(put).not.toHaveBeenCalledWith(endpoint, pelsCapabilityWrite(true));

    settings.set(RESPECT_EXTERNAL_OFF_DEVICES, {});
    await vi.advanceTimersByTimeAsync(60_000);
    await drainUntilCalledWith(put, endpoint, pelsCapabilityWrite(true));
    expect(put).toHaveBeenCalledWith(endpoint, pelsCapabilityWrite(true));
  });

  it('lets other devices resume when the relay maximum can never fit under the hard cap', async () => {
    const { settings, api } = mockHomeyInstance;
    settings.set('power_source', 'homey_energy');
    settings.set('homey_energy_meter_device_id', 'meter-main');
    settings.set(CAPACITY_LIMIT_KW, 5);
    settings.set(CAPACITY_MARGIN_KW, 0);
    settings.set(CAPACITY_DRY_RUN, false);
    settings.set('managed_devices', { relay: true, heater: true });
    settings.set('controllable_devices', { relay: true, heater: true });
    settings.set(LAST_RESORT_DEVICES, { relay: 6000 });

    const relay = new MockDevice('relay', 'Unmetered relay', ['onoff'], 'socket');
    relay.removeCapability('measure_power');
    await relay.setCapabilityValue('onoff', true);
    const heater = new MockDevice('heater', 'Heater', ['onoff', 'measure_power'], 'heater');
    await heater.setCapabilityValue('onoff', true);
    await heater.setCapabilityValue('measure_power', 1500);
    setMockDrivers({ devices: new MockDriver('devices', [relay, heater]) });

    let householdW = 18_000;
    const get = api.get.bind(api);
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => (
      path === 'manager/energy/live'
        ? { items: [{ type: 'cumulative', id: 'meter-main', values: { W: householdW } }] }
        : get(path)
    ));
    const put = vi.spyOn(api, 'put');
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(90_000);

    const relayEndpoint = 'manager/devices/device/relay/capability/onoff';
    const heaterEndpoint = 'manager/devices/device/heater/capability/onoff';
    await drainUntilCalledWith(put, relayEndpoint, pelsCapabilityWrite(false));
    expect(put).toHaveBeenCalledWith(heaterEndpoint, pelsCapabilityWrite(false));

    householdW = 1000;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await drainUntilCalledWith(put, heaterEndpoint, pelsCapabilityWrite(true));
    expect(put).toHaveBeenCalledWith(heaterEndpoint, pelsCapabilityWrite(true));
    expect(put).not.toHaveBeenCalledWith(relayEndpoint, pelsCapabilityWrite(true));
  });
});
