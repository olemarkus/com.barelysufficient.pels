import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CONTROLLABLE_DEVICES, DEVICE_TARGET_POWER_CONFIGS,
  MANAGED_DEVICES, OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { connectLiveFeed } from '../helpers/liveFeedSocketHarness';

const ID = 'victron';
const CARD = 'homey:app:com.victronenergy:set_evcharger_current';

beforeEach(() => {
  vi.useFakeTimers({ toFake: [
    'Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate',
    'clearTimeout', 'clearInterval', 'clearImmediate',
  ] });
  vi.setSystemTime(Date.UTC(2026, 10, 6, 8, 2));
  resetMockHomey();
  connectLiveFeed();
});

afterEach(async () => {
  await cleanupApps();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function setupCharger(
  mode: 'Auto' | 'Manual', hasCurrentFlow: boolean, initiallyCharging = true, rejectsCurrent = false, ceilingA: number | null = 32,
) {
  const device = new MockDevice(ID, 'Victron EV Charging Station', [
    'evcharger_charging', 'evcharger_charging_state', 'measure_power', 'meter_power',
    'sensor_status', 'sensor_status.mode', 'measure_current.max',
  ], 'evcharger');
  device.setDriverIdentity({ ownerUri: 'homey:app:com.victronenergy', driverId: 'homey:app:com.victronenergy:evcharger' });
  let currentA = ceilingA ?? 32;
  let charging = initiallyCharging;
  let backgroundW = 1_000;
  const powerW = () => charging ? currentA * 230 : 0;
  const reads = { evcharger_charging: false, evcharger_charging_state: 'plugged_out',
    sensor_status: charging ? 'Charging' : 'Waiting for start',
    'sensor_status.mode': mode, 'measure_current.max': ceilingA, measure_power: powerW() };
  for (const [capability, value] of Object.entries(reads)) await device.setCapabilityValue(capability, value);
  setMockDrivers({ chargers: new MockDriver('chargers', [device]) });
  const settings = mockHomeyInstance.settings;
  settings.set('power_source', 'homey_energy');
  settings.set('homey_energy_meter_device_id', 'meter-main');
  settings.set(CAPACITY_LIMIT_KW, 5.3);
  settings.set(CAPACITY_MARGIN_KW, 0);
  settings.set(CAPACITY_DRY_RUN, false);
  settings.set(OPERATING_MODE_SETTING, 'Home');
  settings.set(CONTROLLABLE_DEVICES, { [ID]: true });
  settings.set(MANAGED_DEVICES, { [ID]: true });
  settings.set('overshoot_behaviors', { [ID]: { action: 'set_step' } });
  settings.set(DEVICE_TARGET_POWER_CONFIGS, { [ID]: { enabled: true, preset: 'ev_charger_1_phase' } });
  settings.set('charging_current_control', { [ID]: { method: 'built_in', confirmation: 'none' } });
  settings.set('_homey_flow_api_key', 'test-key');

  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') return {
      items: [{ type: 'cumulative', id: 'meter-main', values: { W: backgroundW + powerW() } }],
    };
    if (path === 'manager/flow/flow/') return hasCurrentFlow
      ? { current: { name: 'Change current', actions: [{ id: CARD, args: { device: { id: ID } } }] } } : {};
    if (path === 'manager/flow/advancedflow/') return {};
    if (path === 'manager/flow/flowcardaction') return [{ id: CARD }];
    return originalGet(path);
  });
  const actions: number[] = [];
  const startCurrents: number[] = [];
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    const response = await originalPut(path, body);
    if (path === `manager/devices/device/${ID}/capability/evcharger_charging`
      && body && typeof body === 'object' && 'value' in body && body.value === true) {
      startCurrents.push(currentA);
      charging = true;
      device.setActualCapabilityValue('sensor_status', 'Charging');
      device.setActualCapabilityValue('measure_power', powerW());
    }
    return response;
  });
  const fetch = vi.fn(async (url: unknown, request?: { method?: string; body?: string }) => {
    if (request?.method === 'POST' && String(url).includes(encodeURIComponent(CARD))) {
      const { args } = JSON.parse(request.body ?? '{}') as { args: { current: number; device: { id: string } } };
      expect(args.device.id).toBe(ID);
      actions.push(args.current);
      if (!rejectsCurrent) {
        currentA = args.current;
        device.setActualCapabilityValue('measure_power', powerW());
      }
    }
    return {
      ok: true, status: 200, headers: { get: () => 'mock-homey-id' },
      json: async () => request?.method === 'POST' ? { error: rejectsCurrent ? 'Action failed' : null } : { intersectedScopes: ['homey.flow'] },
    };
  });
  vi.stubGlobal('fetch', fetch);
  return { actions, startCurrents, currentA: () => currentA,
    setBackground: (watts: number) => { backgroundW = watts; } };
}

it('lowers Victron charging current through the app action even when the standard switch reads off', async () => {
  const charger = await setupCharger('Manual', false);
  const app = createApp();
  await app.onInit();
  await vi.advanceTimersByTimeAsync(125_000);
  expect(charger.actions.length).toBeGreaterThan(0);
  const chargerState = app.getPlanInputSnapshot().find((device) => device.id === ID);
  expect(chargerState?.stepCommandStatus).toBe('success');
  expect(chargerState?.reportedStepId).toBeUndefined();
  expect(charger.currentA()).toBeLessThan(32);
  const writes = [...charger.actions];
  await vi.advanceTimersByTimeAsync(60_000);
  expect(charger.actions).toEqual(writes);
});

it('sets the current before starting and does not require a measured current while stopped', async () => {
  const charger = await setupCharger('Manual', false, false);
  await createApp().onInit();
  await vi.advanceTimersByTimeAsync(400_000);
  expect(charger.actions[0]).toBe(6);
  charger.setBackground(1350);
  await vi.advanceTimersByTimeAsync(400_000);
  expect(charger.startCurrents).toEqual([6]);
});

it('keeps the charger stopped if the current action fails', async () => {
  const charger = await setupCharger('Manual', false, false, true);
  await createApp().onInit();
  await vi.advanceTimersByTimeAsync(400_000);
  expect(charger.actions[0]).toBe(6);
  charger.setBackground(1350);
  await vi.advanceTimersByTimeAsync(400_000);
  expect(charger.startCurrents).toEqual([]);
});

it('keeps the charger stopped while its ceiling is unavailable', async () => {
  const charger = await setupCharger('Manual', false, false, false, null);
  await createApp().onInit();
  await vi.advanceTimersByTimeAsync(400_000);
  charger.setBackground(1350);
  await vi.advanceTimersByTimeAsync(400_000);
  expect(charger.actions).toEqual([]);
  expect(charger.startCurrents).toEqual([]);
});

it('ramps above the first higher rung within the charger ceiling after headroom returns', async () => {
  const charger = await setupCharger('Manual', false, true, false, 16);
  charger.setBackground(3650);
  await createApp().onInit();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(charger.actions[0]).toBe(6);
  for (const backgroundW of [500, 550, 600, 650]) {
    charger.setBackground(backgroundW);
    await vi.advanceTimersByTimeAsync(350_000);
  }
  expect(Math.max(...charger.actions)).toBeGreaterThan(8);
  expect(Math.max(...charger.actions)).toBeLessThanOrEqual(16);
});

it.each([['Auto', false], ['Manual', true]] as const)(
  'does not run the built-in action in %s mode with a conflicting Flow: %s',
  async (mode, hasCurrentFlow) => {
    const charger = await setupCharger(mode, hasCurrentFlow);
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(125_000);
    expect(charger.actions).toEqual([]);
    if (mode === 'Auto') {
      const planned = app.planService.getLatestPlanSnapshot()?.devices.find((device) => device.id === ID);
      expect(planned?.control.commandAuthority).toBe(false);
      expect(app.getPlanInputSnapshot().find((device) => device.id === ID)?.measuredPowerKw).toBeCloseTo(7.36);
    }
  },
);
