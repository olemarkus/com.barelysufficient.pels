import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CONTROLLABLE_DEVICES, DEVICE_TARGET_POWER_CONFIGS,
  MANAGED_DEVICES, OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainUntil } from '../utils/asyncDrain';
import { connectLiveFeed } from '../helpers/liveFeedSocketHarness';

const ID = 'warp';
const pathFor = (capability: string) => `manager/devices/device/${ID}/capability/${capability}`;
const SET_CURRENT_CARD = 'homey:app:com.glumpf.warp:wb_set_current';
const MAX_CURRENT_A = 32;

type LoggedEvent = { event?: unknown };
type Car = 'drawing' | 'full';

/**
 * The WARP Charger app (`com.glumpf.warp` 1.1.0), as the app behaves:
 * - `evcharger_charging` starts or stops charging; the app card
 *   `wb_set_current` sets the charger's external current limit (6-32 A).
 * - Its 5 s poll publishes `evcharger_charging_state` (`plugged_in_charging`,
 *   `plugged_in` for a car that takes nothing, `plugged_in_paused` for a
 *   stopped session), `evcharger_charging` as current flowing, and the
 *   external limit on `warp_current_limit`.
 */
function simulateWarp(charger: MockDevice, initialA: number, initialCar: Car) {
  let car = initialCar;
  let backgroundW = 1000;
  let maxA = initialA;
  let paused = false;
  const currentActions: number[] = [];
  const state = (): string => {
    if (paused) return 'plugged_in_paused';
    return car === 'drawing' ? 'plugged_in_charging' : 'plugged_in';
  };
  const chargingW = (): number => (state() === 'plugged_in_charging' ? maxA * 230 : 0);
  const poll = (): void => {
    charger.setActualCapabilityValue('evcharger_charging_state', state());
    charger.setActualCapabilityValue('evcharger_charging', state() === 'plugged_in_charging');
    charger.setActualCapabilityValue('warp_current_limit', maxA);
    charger.setActualCapabilityValue('measure_power', chargingW());
  };
  setInterval(poll, 5_000);
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  const put = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    await originalPut(path, body);
    const value: unknown = body && typeof body === 'object' && 'value' in body ? body.value : undefined;
    if (path === pathFor('evcharger_charging') && typeof value === 'boolean') paused = !value;
  });
  const responseHeaders: Record<string, string> = { 'content-type': 'application/json', 'x-homey-id': 'mock-homey-id' };
  const response = (body: unknown) => ({
    ok: true, status: 200,
    headers: { get: (name: string) => responseHeaders[name.toLowerCase()] ?? null },
    json: async () => body,
  });
  const fetch = vi.fn(async (url: unknown, options?: { method?: string; body?: string }) => {
    if (options?.method === 'POST' && String(url).includes(encodeURIComponent(SET_CURRENT_CARD))) {
      const { args } = JSON.parse(options.body ?? '{}') as { args: { current: number; device: { id: string } } };
      if (args.device.id !== ID || args.current < 6 || args.current > MAX_CURRENT_A) throw new Error('bad action');
      currentActions.push(args.current);
      maxA = args.current;
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
    maxA: () => maxA,
    paused: () => paused,
    chargingW,
    switchWrites: () => put.mock.calls.filter(([path]) => path === pathFor('evcharger_charging'))
      .map(([, body]) => (body as { value: boolean }).value),
    setBackground: (watts: number) => { backgroundW = watts; },
    setCar: (next: Car) => { car = next; },
  };
}

async function buildWarp(currentA: number, car: Car): Promise<MockDevice> {
  const device = new MockDevice(ID, 'WARP3 Charger', [
    'evcharger_charging', 'evcharger_charging_state', 'measure_power', 'meter_power', 'warp_status',
    'warp_current_limit', 'warp_charge_time', 'alarm_generic',
  ], 'evcharger');
  device.setDriverIdentity({ ownerUri: 'homey:app:com.glumpf.warp', driverId: 'homey:app:com.glumpf.warp:wallbox' });
  device.setCapabilityMetadata('warp_current_limit', { setable: true, min: 6, max: 32, units: 'A' });
  const charging = car === 'drawing';
  await device.setCapabilityValue('evcharger_charging', charging);
  await device.setCapabilityValue('evcharger_charging_state', charging ? 'plugged_in_charging' : 'plugged_in');
  await device.setCapabilityValue('warp_status', charging ? 'charging' : 'ready');
  await device.setCapabilityValue('warp_current_limit', currentA);
  await device.setCapabilityValue('measure_power', charging ? currentA * 230 : 0);
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

describe('WARP Charger (com.glumpf.warp) at the SDK boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [
      'Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate',
      'clearTimeout', 'clearInterval', 'clearImmediate',
    ] });
    vi.setSystemTime(Date.UTC(2026, 10, 6, 8, 2));
    resetMockHomey();
    setMockDrivers({});
    connectLiveFeed();
  });
  afterEach(async () => {
    await cleanupApps();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('stops under pressure, and confirms a start for a full car that only waits', async () => {
    const charger = await buildWarp(16, 'drawing');
    const simulation = simulateWarp(charger, 16, 'drawing');
    configureRuntime(1000 + 17 * 230);
    mockHomeyInstance.settings.set('overshoot_behaviors', { [ID]: { action: 'turn_off' } });
    simulation.setBackground(1000 + 18 * 230);
    const app = createApp();
    const loggedEvents: LoggedEvent[] = [];
    app.log = recordingLog(loggedEvents, app.log.bind(app));
    await app.onInit();
    await vi.advanceTimersByTimeAsync(95_000);
    expect(simulation.paused()).toBe(true);
    // The car finishes while paused: a resume finds it waiting, drawing nothing.
    simulation.setCar('full');
    simulation.setBackground(1000);
    await vi.advanceTimersByTimeAsync(900_000);
    expect(simulation.paused()).toBe(false);
    expect(simulation.switchWrites().filter((value) => value)).toEqual([true]);
    const events = loggedEvents.map(({ event }) => event);
    expect(events).toContain('binary_command_succeeded');
    expect(events).not.toContain('binary_command_reachability_backoff_armed');
  });

  it('lowers the current through the wb_set_current card and reads it back from warp_current_limit', async () => {
    const charger = await buildWarp(32, 'drawing');
    const simulation = simulateWarp(charger, 32, 'drawing');
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
    expect(simulation.maxA()).toBeLessThanOrEqual(20);
    expect(simulation.maxA()).toBeGreaterThanOrEqual(6);
    expect(simulation.paused()).toBe(false);
  });
});
