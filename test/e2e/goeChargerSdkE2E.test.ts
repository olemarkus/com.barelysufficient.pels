import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CONTROLLABLE_DEVICES, DEVICE_TARGET_POWER_CONFIGS,
  MANAGED_DEVICES, OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainUntil } from '../utils/asyncDrain';
import { connectLiveFeed } from '../helpers/liveFeedSocketHarness';

const ID = 'goe';
const pathFor = (capability: string) => `manager/devices/device/${ID}/capability/${capability}`;
const CHANGE_CURRENT_CARD = 'homey:app:com.go-e.charger:change_current';
const MAX_CURRENT_A = 32;

/**
 * The go-e Charger app (`com.go-e.charger` 2.11.1), as its shipped
 * `drivers/main-device.js` behaves:
 * - `is_allowed` is setable: false forces charging off (`frc` 1), true hands
 *   it back to the charger (`frc` 0), and the 5 s poll publishes the
 *   charger's `alw` on `is_allowed`.
 * - `status` follows the charger's `car` state; `is_connected` and
 *   `is_charging` follow it.
 * - `current_limit` is read-only; the `change_current` card writes the
 *   charger's `amp` (6 A to its maximum) and the poll publishes it back.
 */
function simulateGoe(charger: MockDevice, initialA: number) {
  let backgroundW = 1000;
  let ampA = initialA;
  let allowed = true;
  const currentActions: number[] = [];
  const chargingW = (): number => (allowed ? ampA * 230 : 0);
  const poll = (): void => {
    charger.setActualCapabilityValue('is_allowed', allowed);
    charger.setActualCapabilityValue('status', allowed ? 'car_charging' : 'station_waiting');
    charger.setActualCapabilityValue('is_charging', allowed);
    charger.setActualCapabilityValue('current_limit', ampA);
    charger.setActualCapabilityValue('measure_power', chargingW());
  };
  setInterval(poll, 5_000);
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  const put = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    await originalPut(path, body);
    const value: unknown = body && typeof body === 'object' && 'value' in body ? body.value : undefined;
    if (path === pathFor('is_allowed') && typeof value === 'boolean') allowed = value;
  });
  const responseHeaders: Record<string, string> = { 'content-type': 'application/json', 'x-homey-id': 'mock-homey-id' };
  const response = (body: unknown) => ({
    ok: true, status: 200,
    headers: { get: (name: string) => responseHeaders[name.toLowerCase()] ?? null },
    json: async () => body,
  });
  const fetch = vi.fn(async (url: unknown, options?: { method?: string; body?: string }) => {
    if (options?.method === 'POST' && String(url).includes(encodeURIComponent(CHANGE_CURRENT_CARD))) {
      const { args } = JSON.parse(options.body ?? '{}') as { args: { action_amps: number; device: { id: string } } };
      if (args.device.id !== ID || args.action_amps < 6 || args.action_amps > MAX_CURRENT_A) {
        throw new Error('bad action');
      }
      currentActions.push(args.action_amps);
      ampA = args.action_amps;
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
    if (path === 'manager/flow/flowcardaction') return [{ id: CHANGE_CURRENT_CARD }];
    return originalGet(path);
  });
  return {
    currentActions,
    ampA: () => ampA,
    allowed: () => allowed,
    switchWrites: () => put.mock.calls.filter(([path]) => path === pathFor('is_allowed'))
      .map(([, body]) => (body as { value: boolean }).value),
    setBackground: (watts: number) => { backgroundW = watts; },
  };
}

async function buildGoe(currentA: number): Promise<MockDevice> {
  const device = new MockDevice(ID, 'go-e Charger', [
    'is_allowed', 'is_charging', 'is_connected', 'status', 'current_limit', 'current_max', 'num_phases',
    'measure_power', 'measure_current', 'meter_power',
  ], 'evcharger');
  device.setDriverIdentity({ ownerUri: 'homey:app:com.go-e.charger',
    driverId: 'homey:app:com.go-e.charger:go-eCharger_V3' });
  device.setCapabilityMetadata('is_charging', { setable: false });
  device.setCapabilityMetadata('is_connected', { setable: false });
  device.setCapabilityMetadata('status', { setable: false });
  device.setCapabilityMetadata('current_limit', { setable: false, min: 6, max: 32, units: 'A' });
  device.setCapabilityMetadata('current_max', { setable: false });
  await device.setCapabilityValue('is_allowed', true);
  await device.setCapabilityValue('is_charging', true);
  await device.setCapabilityValue('is_connected', true);
  await device.setCapabilityValue('status', 'car_charging');
  await device.setCapabilityValue('current_limit', currentA);
  await device.setCapabilityValue('current_max', MAX_CURRENT_A);
  await device.setCapabilityValue('num_phases', '1');
  await device.setCapabilityValue('measure_power', currentA * 230);
  await device.setCapabilityValue('measure_current', currentA);
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

describe('go-e Charger (com.go-e.charger) at the SDK boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [
      'Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate',
      'clearTimeout', 'clearInterval', 'clearImmediate',
    ] });
    vi.setSystemTime(Date.UTC(2026, 10, 11, 8, 2));
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

  it('stops through is_allowed under pressure and allows charging again when there is room', async () => {
    const charger = await buildGoe(16);
    const simulation = simulateGoe(charger, 16);
    configureRuntime(1000 + 17 * 230);
    mockHomeyInstance.settings.set('overshoot_behaviors', { [ID]: { action: 'turn_off' } });
    simulation.setBackground(1000 + 18 * 230);
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(95_000);
    expect(simulation.allowed()).toBe(false);
    simulation.setBackground(1000);
    await vi.advanceTimersByTimeAsync(900_000);
    expect(simulation.allowed()).toBe(true);
    expect(simulation.switchWrites()).toEqual([false, true]);
  });

  it('lowers the current through the app\'s change_current card and reads it back from current_limit', async () => {
    const charger = await buildGoe(32);
    const simulation = simulateGoe(charger, 32);
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
    expect(simulation.ampA()).toBeLessThanOrEqual(20);
    expect(simulation.ampA()).toBeGreaterThanOrEqual(6);
    expect(simulation.allowed()).toBe(true);
  });
});
