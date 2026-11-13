import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CONTROLLABLE_DEVICES, DEVICE_TARGET_POWER_CONFIGS,
  MANAGED_DEVICES, OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainUntil } from '../utils/asyncDrain';
import { connectLiveFeed } from '../helpers/liveFeedSocketHarness';

const ID = 'amina';
const pathFor = (capability: string) => `manager/devices/device/${ID}/capability/${capability}`;
const SET_CURRENT_CARD = 'homey:app:com.aminacharging:set_charging_current';
const MAX_LEVEL_A = 32;

type LoggedEvent = { event?: unknown };

/**
 * The amina app (`com.aminacharging` 2.6.2), as the app behaves:
 * - `onoff`: off disables charging, on enables it at the level the charger
 *   holds.
 * - The charger reports connected, charging enabled, power delivered and
 *   paused as separate states, at most every 10 s.
 * - The app card `set_charging_current` moves the charger's level (6 A to
 *   its maximum) and saves it to the `maxCurrent` setting.
 * - Electrical measurement reports `measure_power` (minimum interval 10 s).
 */
function simulateAmina(charger: MockDevice, initialA: number) {
  let backgroundW = 1000;
  let levelA = initialA;
  let enabled = true;
  const currentActions: number[] = [];
  const order: string[] = [];
  const chargingW = (): number => (enabled ? levelA * 230 : 0);
  const reportStatus = (): void => {
    charger.setActualCapabilityValue('charging_enabled', enabled);
    charger.setActualCapabilityValue('power_delivered', enabled);
    charger.setActualCapabilityValue('charging_paused', false);
  };
  const reportPower = (): void => {
    charger.setActualCapabilityValue('measure_power', chargingW());
  };
  setInterval(reportPower, 10_000);
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  const put = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    await originalPut(path, body);
    const value: unknown = body && typeof body === 'object' && 'value' in body ? body.value : undefined;
    if (path === pathFor('onoff') && typeof value === 'boolean') {
      order.push(`onoff:${value}`);
      enabled = value;
      setTimeout(reportStatus, 10_000);
    }
  });
  const responseHeaders: Record<string, string> = { 'content-type': 'application/json', 'x-homey-id': 'mock-homey-id' };
  const response = (body: unknown) => ({
    ok: true, status: 200,
    headers: { get: (name: string) => responseHeaders[name.toLowerCase()] ?? null },
    json: async () => body,
  });
  const fetch = vi.fn(async (url: unknown, options?: { method?: string; body?: string }) => {
    if (options?.method === 'POST' && String(url).includes(encodeURIComponent(SET_CURRENT_CARD))) {
      const { args } = JSON.parse(options.body ?? '{}') as { args: { max: number; device: { id: string } } };
      if (args.device.id !== ID || args.max < 6 || args.max > MAX_LEVEL_A) throw new Error('bad action');
      currentActions.push(args.max);
      order.push(`current:${args.max}`);
      levelA = Math.round(args.max);
      charger.setSettings({ ...await charger.getSettings(), maxCurrent: levelA });
      // The saved setting reaches PELS with the next device update.
      charger.setActualCapabilityValue('measure_power', chargingW(), { emitDeviceUpdate: true });
      return response({ error: null });
    }
    return response({ intersectedScopes: ['homey.flow'] });
  });
  vi.stubGlobal('fetch', fetch);
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') return {
      items: [{ type: 'cumulative', id: 'meter-main', values: { W: backgroundW + chargingW() } }],
    };
    if (path === 'manager/flow/flow/' || path === 'manager/flow/advancedflow/') return {};
    if (path === 'manager/flow/flowcardaction') return [{ id: SET_CURRENT_CARD }];
    return originalGet(path);
  });
  return {
    currentActions,
    order,
    levelA: () => levelA,
    enabled: () => enabled,
    switchWrites: () => put.mock.calls.filter(([path]) => path === pathFor('onoff'))
      .map(([, body]) => (body as { value: boolean }).value),
    setBackground: (watts: number) => { backgroundW = watts; },
  };
}

async function buildAmina(currentA: number): Promise<MockDevice> {
  const device = new MockDevice(ID, 'amina S', [
    'onoff', 'ev_connected', 'charging_enabled', 'power_delivered', 'charging_paused', 'measure_power',
    'total_energy', 'last_session_energy',
    'measure_current.phase_a', 'measure_current.phase_b', 'measure_current.phase_c',
  ], 'evcharger');
  device.setDriverIdentity({ ownerUri: 'homey:app:com.aminacharging', driverId: 'homey:app:com.aminacharging:amina-s' });
  device.setSettings({ maxCurrent: currentA, singlePhase: true });
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('ev_connected', true);
  await device.setCapabilityValue('charging_enabled', true);
  await device.setCapabilityValue('power_delivered', true);
  await device.setCapabilityValue('charging_paused', false);
  await device.setCapabilityValue('measure_power', currentA * 230);
  await device.setCapabilityValue('measure_current.phase_a', currentA);
  await device.setCapabilityValue('measure_current.phase_b', 0);
  await device.setCapabilityValue('measure_current.phase_c', 0);
  setMockDrivers({ chargers: new MockDriver('chargers', [device]) });
  return device;
}

function configureRuntime(limitW: number): void {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, limitW / 1000);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { [ID]: true });
  mockHomeyInstance.settings.set(MANAGED_DEVICES, { [ID]: true });
}

function recordingLog(events: LoggedEvent[], log: (...args: unknown[]) => void): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg !== 'string') continue;
      try {
        events.push(JSON.parse(arg) as LoggedEvent);
      } catch { /* not a structured line */ }
    }
    log(...args);
  };
}

describe('amina S (com.aminacharging) at the SDK boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [
      'Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate',
      'clearTimeout', 'clearInterval', 'clearImmediate',
    ] });
    vi.setSystemTime(Date.UTC(2026, 10, 10, 8, 2));
    resetMockHomey();
    setMockDrivers({});
    connectLiveFeed();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('stops through onoff under pressure and starts it again when there is room', async () => {
    const charger = await buildAmina(16);
    const simulation = simulateAmina(charger, 16);
    configureRuntime(1000 + 17 * 230);
    mockHomeyInstance.settings.set('overshoot_behaviors', { [ID]: { action: 'turn_off' } });
    simulation.setBackground(1000 + 18 * 230);
    const app = createApp();
    const loggedEvents: LoggedEvent[] = [];
    app.log = recordingLog(loggedEvents, app.log.bind(app));
    await app.onInit();
    await vi.advanceTimersByTimeAsync(95_000);
    expect(simulation.enabled()).toBe(false);
    simulation.setBackground(1000);
    await vi.advanceTimersByTimeAsync(900_000);
    expect(simulation.enabled()).toBe(true);
    expect(simulation.switchWrites()).toEqual([false, true]);
    const events = loggedEvents.map(({ event }) => event);
    expect(events).toContain('binary_command_succeeded');
    expect(events).not.toContain('binary_command_reachability_backoff_armed');
  });

  it('lowers the current through the app\'s set_charging_current card and reads it back from maxCurrent', async () => {
    const charger = await buildAmina(32);
    const simulation = simulateAmina(charger, 32);
    configureRuntime(1000 + 20.5 * 230);
    mockHomeyInstance.settings.set('overshoot_behaviors', { [ID]: { action: 'set_step' } });
    mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_CONFIGS, { [ID]: { enabled: true, preset: 'ev_charger_1_phase' } });
    mockHomeyInstance.settings.set('charging_current_control', { [ID]: { method: 'built_in', confirmation: 'none' } });
    mockHomeyInstance.settings.set('_homey_flow_api_key', 'test-key');
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(125_000);
    await drainUntil(() => simulation.currentActions.length > 0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(simulation.currentActions.length).toBeGreaterThan(0);
    for (const amps of simulation.currentActions) {
      expect(Number.isInteger(amps)).toBe(true);
      expect(amps).toBeGreaterThanOrEqual(6);
      expect(amps).toBeLessThanOrEqual(32);
    }
    expect(simulation.levelA()).toBeLessThanOrEqual(20);
    expect(simulation.levelA()).toBeGreaterThanOrEqual(6);
    expect(simulation.enabled()).toBe(true);
  });
});
