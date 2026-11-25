import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CONTROLLABLE_DEVICES, DAILY_BUDGET_ENABLED,
  DEVICE_EXPECTED_POWER_OVERRIDES, DEVICE_START_POLICIES, MANAGED_DEVICES, OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { seedHourlyFlowPricesForTests } from '../helpers/smartTaskPriceSourceFixture';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainPending } from '../utils/asyncDrain';

const DEVICE_ID = 'laundry-relay';
const START_MS = Date.UTC(2026, 0, 1, 17);
const DEADLINE_MS = Date.UTC(2026, 0, 1, 21);
const STARTED = 'smart_task_device_started';
const FINISHED = 'smart_task_device_finished';

const pump = async (minutes: number): Promise<void> => {
  for (let minute = 0; minute < minutes; minute += 1) {
    await vi.advanceTimersByTimeAsync(60_000);
    await drainPending();
  }
};

const triggers = (id: string) => mockHomeyInstance.flow._triggerCardTriggers[id] ?? [];

const startApplianceTask = async (simulation: boolean, initiallyOn = false) => {
  const device = new MockDevice(DEVICE_ID, 'Laundry relay', ['onoff', 'measure_power'], 'socket');
  await device.setCapabilityValue('onoff', initiallyOn);
  await device.setCapabilityValue('measure_power', initiallyOn ? 1_000 : 0);
  setMockDrivers({ relays: new MockDriver('relays', [device]) });
  const { settings } = mockHomeyInstance;
  settings.set('power_source', 'homey_energy');
  settings.set('homey_energy_meter_device_id', 'meter-main');
  settings.set(CAPACITY_LIMIT_KW, 10);
  settings.set(CAPACITY_MARGIN_KW, 0);
  settings.set(CAPACITY_DRY_RUN, simulation);
  settings.set(DAILY_BUDGET_ENABLED, false);
  settings.set(OPERATING_MODE_SETTING, 'Home');
  settings.set(MANAGED_DEVICES, { [DEVICE_ID]: true });
  settings.set(CONTROLLABLE_DEVICES, { [DEVICE_ID]: false });
  settings.set(DEVICE_START_POLICIES, { [DEVICE_ID]: initiallyOn ? 'unrestricted' : 'pels_only' });
  settings.set(DEVICE_EXPECTED_POWER_OVERRIDES, { [DEVICE_ID]: 1 });
  settings.set('price_optimization_enabled', true);
  seedHourlyFlowPricesForTests(Date.UTC(2026, 0, 1), Array.from({ length: 24 }, () => 10));
  settings.set(`deferred_objective.${DEVICE_ID}`, {
    enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 3, deadlineAtMs: DEADLINE_MS,
  });

  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => (
    path === 'manager/energy/live'
      ? { items: [{ type: 'cumulative', id: 'meter-main', values: { W: 1_500 } }] }
      : originalGet(path)
  ));
  await createApp().onInit();
  await pump(4);
  return device;
};

const reportDraw = async (device: MockDevice, watts: number): Promise<void> => {
  await device.setCapabilityValue('measure_power', watts);
  await api.ui_refresh_devices({ homey: mockHomeyInstance as never });
};

describe('Smart task device-run Flow cards through Homey SDK', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(START_MS);
    resetMockHomey();
    setMockDrivers({});
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reports one confirmed start and one sustained stop with the task and device tokens', async () => {
    const device = await startApplianceTask(false);
    expect(await device.getCapabilityValue('onoff')).toBe(true);
    expect(triggers(STARTED)).toEqual([]);

    const expected = [{
      tokens: { device_name: 'Laundry relay', target_kwh: 3, ready_by: '22:00' },
      state: { deviceId: DEVICE_ID },
    }];
    await reportDraw(device, 1_000);
    await pump(2);
    expect(triggers(STARTED)).toEqual(expected);
    expect(triggers(FINISHED)).toEqual([]);

    await reportDraw(device, 0);
    await pump(5);
    expect(triggers(FINISHED)).toEqual([]);
    await pump(15);
    expect(await device.getCapabilityValue('onoff')).toBe(true);
    expect(triggers(STARTED)).toEqual(expected);
    expect(triggers(FINISHED)).toEqual(expected);
    const listener = mockHomeyInstance.flow._triggerCardRunListeners[FINISHED];
    await expect(listener({ device: { id: DEVICE_ID } }, expected[0].state)).resolves.toBe(true);
    await expect(listener({ device: { id: 'other-device' } }, expected[0].state)).resolves.toBe(false);
  });

  it.each([false, true])('stays quiet for an already running device with simulation=%s', async (simulation) => {
    const device = await startApplianceTask(simulation, true);
    await reportDraw(device, 0);
    await pump(20);
    expect(triggers(STARTED)).toEqual([]);
    expect(triggers(FINISHED)).toEqual([]);
  });

  it('keeps a capacity switch-off out of the device-finished card', async () => {
    const device = await startApplianceTask(false);
    await reportDraw(device, 1_000);
    await pump(2);
    expect(triggers(STARTED)).toHaveLength(1);

    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 1);
    await pump(5);
    expect(await device.getCapabilityValue('onoff')).toBe(false);
    await reportDraw(device, 0);
    await pump(20);
    expect(triggers(STARTED)).toHaveLength(1);
    expect(triggers(FINISHED)).toEqual([]);
  });

  it('does not treat a manual power cycle between lifecycle ticks as finishing the owned run', async () => {
    const device = await startApplianceTask(false);
    await reportDraw(device, 1_000);
    await pump(2);
    expect(triggers(STARTED)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await device.setCapabilityValue('onoff', false);
    await reportDraw(device, 0);
    await vi.advanceTimersByTimeAsync(1_000);
    await device.setCapabilityValue('onoff', true);
    await reportDraw(device, 0);
    await pump(20);

    expect(await device.getCapabilityValue('onoff')).toBe(true);
    expect(triggers(STARTED)).toHaveLength(1);
    expect(triggers(FINISHED)).toEqual([]);
  });

  it('does not switch on or emit start/finish in Simulation even if the device later draws', async () => {
    const device = await startApplianceTask(true);
    expect(await device.getCapabilityValue('onoff')).toBe(false);
    await device.setCapabilityValue('onoff', true);
    await reportDraw(device, 1_000);
    await pump(3);
    await reportDraw(device, 0);
    await pump(20);
    expect(triggers(STARTED)).toEqual([]);
    expect(triggers(FINISHED)).toEqual([]);
  });
});
