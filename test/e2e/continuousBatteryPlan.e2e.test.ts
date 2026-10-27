import type Homey from 'homey';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import api from '../../api';
import type { ContinuousBatteryPlanConfig } from '../../packages/contracts/src/continuousBatteryPlan';
import { CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY } from '../../packages/shared-domain/src/settings/continuousBatteryPlan';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { drainPending } from '../utils/asyncDrain';
import { buildSetpointBatteryDevice } from '../helpers/homeBatteryMock';
import type { HomeyEnergyApi } from '../../lib/utils/homeyEnergy';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, OPERATING_MODE_SETTING, PRICE_SCHEME,
} from '../../lib/utils/settingsKeys';

const BATTERY = 'home-battery';
const HOUR_MS = 3_600_000;
const CONFIG: ContinuousBatteryPlanConfig = {
  enabled: true, usableCapacityKWh: 10, minimumReservePercent: 20,
  roundTripEfficiency: 0.9, wearCostPerKWh: 0.03,
  priceUnit: 'EUR',
};
const context = () => ({ homey: mockHomeyInstance as unknown as Homey.App['homey'] });

function importPrice(hour: number, cheapLater: boolean): number {
  if (cheapLater) return hour >= 4 && hour < 7 ? 0.05 : 0.3;
  return hour < 4 ? 0.05 : 0.5;
}

type Home = {
  battery: MockDevice;
  put: MockInstance<typeof mockHomeyInstance.api.put>;
  advance(polls: number): Promise<void>;
  setHouseW(watts: number): void;
};

async function startHome(cheapLater = false, initialPercent = 20, solar?: MockDevice): Promise<Home> {
  const battery = buildSetpointBatteryDevice({ id: BATTERY, claimValue: 'anti_feed', stepW: 5 });
  battery.setActualCapabilityValue('measure_battery', initialPercent);
  const heater = new MockDevice('heater', 'Heater', ['onoff', 'measure_power'], 'socket');
  await heater.setCapabilityValue('onoff', true);
  await heater.setCapabilityValue('measure_power', 1000);
  setMockDrivers({ home: new MockDriver('home', [battery, heater, ...(solar ? [solar] : [])]) });
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(PRICE_SCHEME, 'homey');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 5);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set('managed_devices', { heater: true });
  mockHomeyInstance.settings.set('controllable_devices', { heater: true });
  mockHomeyInstance.settings.set('capacity_priorities', { Home: { heater: 1, [BATTERY]: 2 } });
  mockHomeyInstance.settings.set(CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY, { [BATTERY]: CONFIG });
  const prices: HomeyEnergyApi = {
    fetchDynamicElectricityPrices: async ({ date }) => ({
      interval: 60, priceUnit: 'EUR', pricesPerInterval: Array.from({ length: 24 }, (_, hour) => ({
        periodStart: new Date(Date.parse(`${date}T00:00:00Z`) + hour * HOUR_MS).toISOString(),
        value: importPrice(hour, cheapLater),
      })),
    }),
  };
  mockHomeyInstance.api._dynamicElectricityPrices = prices.fetchDynamicElectricityPrices;
  let houseW = 1800;
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      const batteryW = battery.getActualCapabilityValue('measure_power');
      const solarW = Number(solar?.getActualCapabilityValue('measure_power') ?? 0);
      return {
        items: [{ type: 'cumulative', id: 'meter-main', values: { W: houseW + Number(batteryW) - solarW } }],
        ...(solar ? { totalGenerated: { W: solarW } } : {}),
      };
    }
    return originalGet(path);
  });
  const put = vi.spyOn(mockHomeyInstance.api, 'put');
  const app = createApp();
  await app.onInit();
  return {
    battery, put,
    setHouseW: watts => { houseW = watts; },
    advance: async polls => {
      for (let poll = 0; poll < polls; poll += 1) {
        await vi.advanceTimersByTimeAsync(10_000);
        await drainPending();
        if (battery.getActualCapabilityValue('target_power_mode') === 'homey') {
          const target = battery.getActualCapabilityValue('target_power');
          battery.setActualCapabilityValue('measure_power', target);
          // The real UI refresh route publishes the simulated device's new observation.
          await api.ui_refresh_devices(context());
        }
      }
    },
  };
}

function setpoints(home: Home): number[] {
  return home.put.mock.calls.flatMap(([path, body]) => (
    path === `manager/devices/device/${BATTERY}/capability/target_power`
      && typeof (body as { value: unknown }).value === 'number'
      ? [(body as { value: number }).value] : []
  ));
}

describe('continuous battery plan through the Homey SDK', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'] });
    vi.setSystemTime(Date.UTC(2026, 9, 27, 0, 5));
    resetMockHomey();
  });

  afterEach(async () => {
    await cleanupApps();
    mockHomeyInstance.api._solarForecastByDate = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('plans from real prices and observed demand, claims and charges through the existing actuator', async () => {
    const home = await startHome();
    await home.advance(8);
    const read = (await api.ui_devices(context())).continuousBatteryPlans[BATTERY];
    expect(read.status).toBe('planned');
    expect(home.battery.getActualCapabilityValue('target_power_mode')).toBe('homey');
    expect(setpoints(home).some(watts => watts > 0)).toBe(true);
    expect(setpoints(home).every(watts => watts <= 2500)).toBe(true);
  });

  it('holds control at zero while waiting for cheaper prices, without the native schedule taking over', async () => {
    const home = await startHome(true);
    await home.advance(8);
    expect(((await api.ui_devices(context())).continuousBatteryPlans[BATTERY]).status).toBe('planned');
    expect(home.battery.getActualCapabilityValue('target_power_mode')).toBe('homey');
    expect(setpoints(home)).toContain(0);
    expect(setpoints(home).every(watts => watts === 0)).toBe(true);
  });

  it('hands back after the owner disables continuous planning through the settings channel', async () => {
    const home = await startHome(true);
    await home.advance(8);
    expect(home.battery.getActualCapabilityValue('target_power_mode')).toBe('homey');
    mockHomeyInstance.settings.set(CONTINUOUS_BATTERY_PLAN_SETTINGS_KEY, { [BATTERY]: { ...CONFIG, enabled: false } });
    await home.advance(4);
    expect(((await api.ui_devices(context())).continuousBatteryPlans[BATTERY]).status).toBe('disabled');
    expect(home.battery.getActualCapabilityValue('target_power_mode')).toBe('anti_feed');
  });

  it('protects the minimum reserve when capacity pressure asks for battery relief', async () => {
    const home = await startHome(true);
    await home.advance(8);
    home.put.mockClear();
    home.setHouseW(6500);
    await home.advance(8);
    expect(setpoints(home).every(watts => watts >= 0)).toBe(true);
  });

  it('releases the claim when Power-limit control is switched off', async () => {
    const home = await startHome(true);
    await home.advance(8);
    expect(home.battery.getActualCapabilityValue('target_power_mode')).toBe('homey');
    mockHomeyInstance.settings.set('controllable_devices', { heater: true, [BATTERY]: false });
    await home.advance(4);
    expect(home.battery.getActualCapabilityValue('target_power_mode')).toBe('anti_feed');
    expect((await api.ui_devices(context())).continuousBatteryPlans[BATTERY]).toMatchObject({ status: 'waiting', reason: 'control_unavailable' });
  });

  it('stops economic discharge when the house starts exporting', async () => {
    const home = await startHome(true, 80);
    await home.advance(8);
    expect(setpoints(home).some(watts => watts < 0)).toBe(true);
    home.put.mockClear();
    home.setHouseW(-1000);
    await home.advance(5);
    expect(setpoints(home)).toContain(0);
    expect(setpoints(home).every(watts => watts >= 0)).toBe(true);
  });

  it('waits for battery charging to be measured before curtailing the remaining solar export', async () => {
    const solar = new MockDevice('pv', 'Roof inverter', ['measure_power', 'meter_power', 'target_power'], 'solarpanel');
    for (const [capability, value] of [['measure_power', 5000], ['meter_power', 42], ['target_power', 6000]] as const) {
      await solar.setCapabilityValue(capability, value);
    }
    solar.setCapabilityMetadata('target_power', { min: 0, max: 6000, step: 1, setable: true });
    mockHomeyInstance.api._solarForecastByDate = Object.fromEntries(['2026-10-27', '2026-10-28'].map(date => [date, {
      resolution: 60, points: Array.from({ length: 24 }, (_, hour) => ({
        t: new Date(Date.parse(`${date}T00:00:00Z`) + hour * HOUR_MS).toISOString(), watts: 5000,
      })),
    }]));
    mockHomeyInstance.settings.set('export_price_enabled', true);
    mockHomeyInstance.settings.set('export_price_source', 'manual');
    mockHomeyInstance.settings.set('export_spot_factor', 0);
    mockHomeyInstance.settings.set('export_fixed', -0.05);
    const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
    const home = await startHome(false, 20, solar);
    await home.advance(8);
    const read = (await api.ui_devices(context())).continuousBatteryPlans[BATTERY];
    expect(read.status, JSON.stringify(read)).toBe('planned');
    expect(setpoints(home).some(watts => watts > 0)).toBe(true);
    const batteryReadingsAtCurtail: number[] = [];
    home.put.mockImplementation(async (path, body) => {
      if (path === 'manager/devices/device/pv/capability/target_power') {
        batteryReadingsAtCurtail.push(Number(home.battery.getActualCapabilityValue('measure_power')));
      }
      return originalPut(path, body);
    });
    // The battery reports a temporary pause. Its target remains a request,
    // and the next meter sample must let charging land before reducing PV.
    home.battery.setActualCapabilityValue('measure_power', 0);
    await api.ui_refresh_devices(context());
    mockHomeyInstance.settings.set('inverter_curtailment_devices', { pv: true });
    await home.advance(1);
    expect(batteryReadingsAtCurtail).toEqual([]);
    await home.advance(6);
    expect(batteryReadingsAtCurtail.length).toBeGreaterThan(0);
    expect(batteryReadingsAtCurtail.every(watts => watts > 0)).toBe(true);
  });

  it('respects a manual mode change in the battery app', async () => {
    const home = await startHome(true);
    await home.advance(8);
    expect(home.battery.getActualCapabilityValue('target_power_mode')).toBe('homey');
    home.put.mockClear();
    home.battery.setActualCapabilityValue('target_power_mode', 'trade_mode');
    await api.ui_refresh_devices(context());
    await home.advance(4);
    expect(home.battery.getActualCapabilityValue('target_power_mode')).toBe('trade_mode');
    expect(home.put.mock.calls.some(([path, body]) => path === `manager/devices/device/${BATTERY}/capability/target_power_mode`
      && (body as { value: unknown }).value === 'homey')).toBe(false);
  });
});
