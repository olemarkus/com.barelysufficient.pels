// SDK-boundary e2e for a Stiebel Eltron heat pump read as two devices: room
// heating under the Homey id, and the hot-water tank as its own temperature
// device. Prices and home power enter through the real SDK seams (the
// published Flow prices, Homey Energy's live report), the real planner and
// executor run, and the only thing asserted is what PELS writes back through
// the SDK: the hot-water setpoint lands on the heat pump's own warm-water
// capability, and the room setpoint is left alone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainUntilCalledWith } from '../utils/asyncDrain';
import { pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';
import { seedHourlyFlowPricesForTests } from '../helpers/smartTaskPriceSourceFixture';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';

const DAY_MS = Date.UTC(2026, 10, 12);
const ROOM = 'stiebel';
const HOT_WATER = 'stiebel~hot_water';
const cap = (capability: string) => `manager/devices/device/${ROOM}/capability/${capability}`;

const buildHeatPump = async (): Promise<MockDevice> => {
  const device = new MockDevice(ROOM, 'Heat pump', [
    'target_temperature', 'measure_temperature',
    'target_temperature.warmwater_temp', 'measure_temperature.warmwater_temp',
    'measure_power', 'measure_power.heating', 'measure_power.warmwater',
  ], 'heatpump');
  device.setDriverIdentity({ ownerUri: 'homey:app:Stiebel.heatpump', driverId: 'homey:app:Stiebel.heatpump:heatpump' });
  await device.setCapabilityValue('target_temperature', 21);
  await device.setCapabilityValue('measure_temperature', 20.5);
  await device.setCapabilityValue('target_temperature.warmwater_temp', 48);
  await device.setCapabilityValue('measure_temperature.warmwater_temp', 46);
  await device.setCapabilityValue('measure_power', 2400);
  await device.setCapabilityValue('measure_power.heating', 900);
  await device.setCapabilityValue('measure_power.warmwater', 1500);
  return device;
};

const reportHomePower = (totalW: number): void => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => (
    path === 'manager/energy/live'
      ? { items: [{ type: 'cumulative', id: 'meter-main', values: { W: totalW } }] }
      : originalGet(path)
  ));
};

const seedSettings = (capacityLimitKw: number): void => {
  const both = { [ROOM]: true, [HOT_WATER]: true };
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, capacityLimitKw);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set('daily_budget_enabled', false);
  mockHomeyInstance.settings.set(MANAGED_DEVICES, both);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set('mode_device_targets', { Home: { [ROOM]: 21, [HOT_WATER]: 48 } });
};

describe('Stiebel Eltron hot water (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(DAY_MS);
    resetMockHomey();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('raises only the hot-water setpoint in a cheap hour', async () => {
    seedSettings(10);
    mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { [ROOM]: false, [HOT_WATER]: false });
    mockHomeyInstance.settings.set('price_optimization_enabled', true);
    mockHomeyInstance.settings.set('price_optimization_settings', {
      [HOT_WATER]: { enabled: true, cheapDelta: 7, expensiveDelta: -5 },
    });
    seedHourlyFlowPricesForTests(DAY_MS, Array.from({ length: 24 }, (_, hour) => (hour === 0 ? 20 : 100)));
    setMockDrivers({ stiebel: new MockDriver('stiebel', [await buildHeatPump()]) });
    reportHomePower(2400);
    const put = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntilCalledWith(put, cap('target_temperature.warmwater_temp'), pelsCapabilityWrite(55));

    expect(put).not.toHaveBeenCalledWith(cap('target_temperature'), expect.anything());
  });

  it('lowers only the hot-water setpoint when home power is over the capacity limit', async () => {
    seedSettings(1);
    mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { [ROOM]: false, [HOT_WATER]: true });
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      [HOT_WATER]: { action: 'set_temperature', temperature: 40 },
    });
    setMockDrivers({ stiebel: new MockDriver('stiebel', [await buildHeatPump()]) });
    reportHomePower(5000);
    const put = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntilCalledWith(put, cap('target_temperature.warmwater_temp'), pelsCapabilityWrite(40));

    expect(put).not.toHaveBeenCalledWith(cap('target_temperature'), expect.anything());
  });
});
