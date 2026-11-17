import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CONTROLLABLE_DEVICES, DEVICE_TARGET_POWER_CONFIGS,
  MANAGED_DEVICES, OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainUntil } from '../utils/asyncDrain';
import { connectLiveFeed } from '../helpers/liveFeedSocketHarness';

const ID = 'keba';
const pathFor = (capability: string) => `manager/devices/device/${ID}/capability/${capability}`;
const SET_CURRENT_CARD = 'homey:app:se.cohen.keba:set_charge_power';
const MAX_CURRENT_A = 32;

/**
 * The KEBA app (`se.cohen.keba` 1.1.17, `keba-p30` driver), as the app behaves:
 * - `onoff` is setable: false disables charging, true enables it, and the
 *   10 s poll publishes the charger's own enabled state on `onoff`.
 * - `plug_status` and `charge_status` follow the cable and the session.
 * - `charge_power` is read-only; the `set_charge_power` card sets the
 *   charger's current and the poll publishes it back.
 */
function simulateKeba(charger: MockDevice, initialA: number) {
  let backgroundW = 1000;
  let ampA = initialA;
  let enabled = true;
  const currentActions: number[] = [];
  const chargingW = (): number => (enabled ? ampA * 230 : 0);
  const poll = (): void => {
    charger.setActualCapabilityValue('onoff', enabled);
    charger.setActualCapabilityValue('plug_status', true);
    charger.setActualCapabilityValue('charge_status', enabled);
    charger.setActualCapabilityValue('charge_power', ampA);
    charger.setActualCapabilityValue('measure_power', chargingW());
  };
  setInterval(poll, 10_000);
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  const put = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    await originalPut(path, body);
    const value: unknown = body && typeof body === 'object' && 'value' in body ? body.value : undefined;
    if (path === pathFor('onoff') && typeof value === 'boolean') enabled = value;
  });
  const responseHeaders: Record<string, string> = { 'content-type': 'application/json', 'x-homey-id': 'mock-homey-id' };
  const response = (body: unknown) => ({
    ok: true, status: 200,
    headers: { get: (name: string) => responseHeaders[name.toLowerCase()] ?? null },
    json: async () => body,
  });
  const fetch = vi.fn(async (url: unknown, options?: { method?: string; body?: string }) => {
    if (options?.method === 'POST' && String(url).includes(encodeURIComponent(SET_CURRENT_CARD))) {
      const { args } = JSON.parse(options.body ?? '{}') as { args: { charge_power: number; device: { id: string } } };
      if (args.device.id !== ID || args.charge_power < 6 || args.charge_power > MAX_CURRENT_A) {
        throw new Error('bad action');
      }
      currentActions.push(args.charge_power);
      ampA = args.charge_power;
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
    ampA: () => ampA,
    enabled: () => enabled,
    switchWrites: () => put.mock.calls.filter(([path]) => path === pathFor('onoff'))
      .map(([, body]) => (body as { value: boolean }).value),
    setBackground: (watts: number) => { backgroundW = watts; },
  };
}

async function buildKeba(currentA: number): Promise<MockDevice> {
  const device = new MockDevice(ID, 'KEBA P30', [
    'onoff', 'charge_power', 'plug_status', 'charge_status', 'charge_power_selector', 'measure_power', 'meter_power',
  ], 'evcharger');
  device.setDriverIdentity({ ownerUri: 'homey:app:se.cohen.keba', driverId: 'homey:app:se.cohen.keba:keba-p30' });
  device.setCapabilityMetadata('charge_power', { setable: false, units: 'A' });
  device.setCapabilityMetadata('plug_status', { setable: false });
  device.setCapabilityMetadata('charge_status', { setable: false });
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('plug_status', true);
  await device.setCapabilityValue('charge_status', true);
  await device.setCapabilityValue('charge_power', currentA);
  await device.setCapabilityValue('charge_power_selector', String(currentA * 1000));
  await device.setCapabilityValue('measure_power', currentA * 230);
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

describe('KEBA P30 (se.cohen.keba) at the SDK boundary', () => {
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

  it('stops through onoff under pressure and enables charging again when there is room', async () => {
    const charger = await buildKeba(16);
    const simulation = simulateKeba(charger, 16);
    configureRuntime(1000 + 17 * 230);
    mockHomeyInstance.settings.set('overshoot_behaviors', { [ID]: { action: 'turn_off' } });
    simulation.setBackground(1000 + 18 * 230);
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(95_000);
    expect(simulation.enabled()).toBe(false);
    simulation.setBackground(1000);
    await vi.advanceTimersByTimeAsync(900_000);
    expect(simulation.enabled()).toBe(true);
    expect(simulation.switchWrites()).toEqual([false, true]);
  });

  it('lowers the current through the app\'s set_charge_power card and reads it back from charge_power', async () => {
    const charger = await buildKeba(32);
    const simulation = simulateKeba(charger, 32);
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
    expect(simulation.enabled()).toBe(true);
  });
});
