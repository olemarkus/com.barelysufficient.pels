/** Car-specific ranges through real settings, car confirmation, meter input and SDK writes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW,
  CONTROLLABLE_DEVICES, DEVICE_TARGET_POWER_CONFIGS, EV_CAR_ASSOCIATIONS,
  EV_CAR_CURRENT_LIMITS, EV_CHARGER_CURRENT_LIMITS, MANAGED_DEVICES, NATIVE_EV_WIRING_DEVICES, OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';

const currentPath = (id: string) => `manager/devices/device/${id}/capability/target_charger_current`;

async function car(id: string): Promise<MockDevice> {
  const device = new MockDevice(id, id, ['ev_charging_state', 'measure_battery'], 'car');
  await device.setCapabilityValue('ev_charging_state', 'plugged_in');
  await device.setCapabilityValue('measure_battery', 40);
  return device;
}

async function charger(id: string): Promise<MockDevice> {
  const device = new MockDevice(id, id, [
    'onoff', 'measure_power', 'target_charger_current', 'evcharger_charging', 'evcharger_charging_state',
  ], 'evcharger');
  device.setDriverIdentity({ ownerUri: 'homey:app:no.easee', driverId: 'homey:app:no.easee:charger' });
  device.setCapabilityMetadata('target_charger_current', { units: 'A', min: 0, max: 32, step: 1, setable: true });
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('measure_power', 32 * 230);
  await device.setCapabilityValue('target_charger_current', 32);
  await device.setCapabilityValue('evcharger_charging', true);
  await device.setCapabilityValue('evcharger_charging_state', 'plugged_in_charging');
  return device;
}

function configure(): void {
  const settings = mockHomeyInstance.settings;
  const enabled = { first: true, second: true };
  settings.set('power_source', 'homey_energy');
  settings.set('homey_energy_meter_device_id', 'meter');
  settings.set(CAPACITY_LIMIT_KW, 30);
  settings.set(CAPACITY_MARGIN_KW, 0);
  settings.set(CAPACITY_DRY_RUN, false);
  settings.set(OPERATING_MODE_SETTING, 'Home');
  settings.set(CONTROLLABLE_DEVICES, enabled);
  settings.set(MANAGED_DEVICES, enabled);
  settings.set(NATIVE_EV_WIRING_DEVICES, enabled);
  settings.set('capacity_priorities', { Home: { first: 1, second: 2 } });
  settings.set(DEVICE_TARGET_POWER_CONFIGS, {
    first: { enabled: true, preset: 'ev_charger_1_phase', max: 7360 },
    second: { enabled: true, preset: 'ev_charger_1_phase', max: 7360 },
  });
  settings.set(EV_CAR_ASSOCIATIONS, {
    first: { carIds: ['car-a', 'car-b'] }, second: { carIds: ['car-a', 'car-b'] },
  });
  settings.set(EV_CHARGER_CURRENT_LIMITS, {
    first: { minA: 9, maxA: 9 }, second: { minA: 16, maxA: 16 },
  });
  settings.set(EV_CAR_CURRENT_LIMITS, {
    'car-a': { minA: 25, maxA: 25 }, 'car-b': { minA: 16, maxA: 16 },
  });
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  let reading = 0;
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => (
    path === 'manager/energy/live'
      ? { items: [{ type: 'cumulative', id: 'meter', values: { W: 15_000 + (++reading % 5) } }] }
      : originalGet(path)
  ));
}

describe('car-specific current limits at the SDK boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [
      'Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance',
    ] });
    vi.setSystemTime(Date.UTC(2026, 10, 4, 10, 15));
    resetMockHomey();
    setMockDrivers({});
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('uses charger defaults until a car override is identified, then follows that car across chargers', async () => {
    const devices = await Promise.all([car('car-a'), car('car-b'), charger('first'), charger('second')]);
    setMockDrivers({ driver: new MockDriver('driver', devices) });
    configure();
    const writes = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(60_000);

    // Selection alone has not identified either connected car.
    const initial = await api.ui_devices({ homey: mockHomeyInstance as never });
    expect(initial.devices.find((device) => device.id === 'first')?.associatedCar).toBeUndefined();
    expect(writes).toHaveBeenCalledWith(currentPath('first'), pelsCapabilityWrite(9));
    expect(writes).toHaveBeenCalledWith(currentPath('second'), pelsCapabilityWrite(16));

    await api.ui_car_association_confirm({
      homey: mockHomeyInstance as never, body: { chargerId: 'first', carId: 'car-a' },
    });
    writes.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writes).toHaveBeenCalledWith(currentPath('first'), pelsCapabilityWrite(25));

    await api.ui_car_association_confirm({
      homey: mockHomeyInstance as never, body: { chargerId: 'first', carId: 'car-b' },
    });
    writes.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writes).toHaveBeenCalledWith(currentPath('first'), pelsCapabilityWrite(16));

    await api.ui_car_association_confirm({
      homey: mockHomeyInstance as never, body: { chargerId: 'second', carId: 'car-a' },
    });
    writes.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writes).toHaveBeenCalledWith(currentPath('second'), pelsCapabilityWrite(25));

    mockHomeyInstance.settings.set(EV_CAR_CURRENT_LIMITS, {
      'car-a': { minA: 12, maxA: 12 }, 'car-b': { minA: 16, maxA: 16 },
    });
    writes.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writes).toHaveBeenCalledWith(currentPath('second'), pelsCapabilityWrite(12));

    await api.ui_car_association_clear({
      homey: mockHomeyInstance as never, body: { chargerId: 'second' },
    });
    writes.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writes).toHaveBeenCalledWith(currentPath('second'), pelsCapabilityWrite(16));
    expect(mockHomeyInstance.settings.get(DEVICE_TARGET_POWER_CONFIGS)).toEqual({
      first: { enabled: true, preset: 'ev_charger_1_phase', max: 7360 },
      second: { enabled: true, preset: 'ev_charger_1_phase', max: 7360 },
    });
  });
});
