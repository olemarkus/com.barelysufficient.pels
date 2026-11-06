import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CONTROLLABLE_DEVICES, DEVICE_TARGET_POWER_CONFIGS,
  MANAGED_DEVICES, OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainUntil } from '../utils/asyncDrain';
import { connectLiveFeed } from '../helpers/liveFeedSocketHarness';

const ID = 'wallbox';
const pathFor = (capability: string) => `manager/devices/device/${ID}/capability/${capability}`;
const CHANGE_AMPERE_CARD = 'homey:app:nl.xseth.wallbox:change_ampere';
const MAX_AVAILABLE_A = 32;

type LoggedEvent = { event?: unknown };
type Car = 'drawing' | 'full';

/**
 * The community Wallbox app (`nl.xseth.wallbox` 1.2.0), as its shipped
 * `drivers/wallbox/device.js` behaves:
 * - `evcharger_charging` pauses (`action: 2`) or resumes (`action: 1`) the
 *   session; the app card `change_ampere` sets the cloud's
 *   `maxChargingCurrent` (1 A to `max_available_current`).
 * - Its poll (123 s, and 10 s after either command) publishes `status`
 *   (`Charging`, `Waiting` for a car that takes nothing, `Paused`),
 *   `evcharger_charging` as status == Charging, and the configured maximum
 *   current on `measure_current`.
 */
function simulateWallbox(charger: MockDevice, initialA: number, initialCar: Car) {
  let car = initialCar;
  let backgroundW = 1000;
  let maxA = initialA;
  let paused = false;
  const ampereActions: number[] = [];
  const status = (): string => {
    if (paused) return 'Paused';
    return car === 'drawing' ? 'Charging' : 'Waiting';
  };
  const chargingW = (): number => (status() === 'Charging' ? maxA * 230 : 0);
  const poll = (): void => {
    charger.setActualCapabilityValue('status', status());
    charger.setActualCapabilityValue('evcharger_charging', status() === 'Charging');
    charger.setActualCapabilityValue('evcharger_charging_state',
      status() === 'Charging' ? 'plugged_in_charging' : 'plugged_in');
    charger.setActualCapabilityValue('measure_current', maxA);
    charger.setActualCapabilityValue('measure_power', chargingW());
  };
  setInterval(poll, 123_000);
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  const put = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    await originalPut(path, body);
    const value: unknown = body && typeof body === 'object' && 'value' in body ? body.value : undefined;
    if (path === pathFor('evcharger_charging') && typeof value === 'boolean') {
      paused = !value;
      setTimeout(poll, 10_000);
    }
  });
  const responseHeaders: Record<string, string> = { 'content-type': 'application/json', 'x-homey-id': 'mock-homey-id' };
  const response = (body: unknown) => ({
    ok: true, status: 200,
    headers: { get: (name: string) => responseHeaders[name.toLowerCase()] ?? null },
    json: async () => body,
  });
  const fetch = vi.fn(async (url: unknown, options?: { method?: string; body?: string }) => {
    if (options?.method === 'POST' && String(url).includes(encodeURIComponent(CHANGE_AMPERE_CARD))) {
      const { args } = JSON.parse(options.body ?? '{}') as { args: { ampere: number; device: { id: string } } };
      if (args.device.id !== ID || args.ampere < 1 || args.ampere > MAX_AVAILABLE_A) throw new Error('bad action');
      ampereActions.push(args.ampere);
      maxA = args.ampere;
      setTimeout(poll, 10_000);
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
    if (path === 'manager/flow/flowcardaction') return [{ id: CHANGE_AMPERE_CARD }];
    return originalGet(path);
  });
  return {
    ampereActions,
    maxA: () => maxA,
    paused: () => paused,
    chargingW,
    switchWrites: () => put.mock.calls.filter(([path]) => path === pathFor('evcharger_charging'))
      .map(([, body]) => (body as { value: boolean }).value),
    setBackground: (watts: number) => { backgroundW = watts; },
    setCar: (next: Car) => { car = next; },
  };
}

async function buildWallbox(currentA: number, car: Car): Promise<MockDevice> {
  const device = new MockDevice(ID, 'Wallbox Pulsar', [
    'locked', 'evcharger_charging_state', 'evcharger_charging', 'meter_power', 'measure_current', 'measure_power', 'status',
  ], 'evcharger');
  device.setDriverIdentity({ ownerUri: 'homey:app:nl.xseth.wallbox', driverId: 'homey:app:nl.xseth.wallbox:wallbox' });
  const charging = car === 'drawing';
  await device.setCapabilityValue('locked', false);
  await device.setCapabilityValue('status', charging ? 'Charging' : 'Waiting');
  await device.setCapabilityValue('evcharger_charging', charging);
  await device.setCapabilityValue('evcharger_charging_state', charging ? 'plugged_in_charging' : 'plugged_in');
  await device.setCapabilityValue('measure_current', currentA);
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

describe('Wallbox (nl.xseth.wallbox) at the SDK boundary', () => {
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

  it('pauses under pressure, and confirms a resume for a full car that only waits', async () => {
    const charger = await buildWallbox(16, 'drawing');
    const simulation = simulateWallbox(charger, 16, 'drawing');
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

  it('lowers the current through the app\'s change_ampere card and reads it back from the next poll', async () => {
    const charger = await buildWallbox(32, 'drawing');
    const simulation = simulateWallbox(charger, 32, 'drawing');
    configureRuntime(1000 + 20.5 * 230);
    mockHomeyInstance.settings.set('overshoot_behaviors', { [ID]: { action: 'set_step' } });
    mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_CONFIGS, { [ID]: { enabled: true, preset: 'ev_charger_1_phase' } });
    mockHomeyInstance.settings.set('charging_current_control', { [ID]: { method: 'built_in', confirmation: 'none' } });
    mockHomeyInstance.settings.set('_homey_flow_api_key', 'test-key');
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(125_000);
    await drainUntil(() => simulation.ampereActions.length > 0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(simulation.ampereActions.length).toBeGreaterThan(0);
    for (const amps of simulation.ampereActions) {
      expect(Number.isInteger(amps)).toBe(true);
      expect(amps).toBeGreaterThanOrEqual(6);
      expect(amps).toBeLessThanOrEqual(32);
    }
    expect(simulation.maxA()).toBeLessThanOrEqual(20);
    expect(simulation.maxA()).toBeGreaterThanOrEqual(6);
    expect(simulation.paused()).toBe(false);
  });
});
