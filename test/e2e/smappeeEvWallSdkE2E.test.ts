import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CONTROLLABLE_DEVICES, MANAGED_DEVICES,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { connectLiveFeed } from '../helpers/liveFeedSocketHarness';

const ID = 'smappee';
const pathFor = (capability: string) => `manager/devices/device/${ID}/capability/${capability}`;
const MODES = ['normal', 'smart', 'paused'];

/**
 * The Smappee app's EV Wall (`com.smappee` 1.3.4, `ev-wall` driver, Homey
 * class `other`), as the app behaves:
 * - `charging_mode` is setable: a write sends the connector's mode to the
 *   Smappee cloud and sets the capability once the cloud accepts it.
 * - The charger's MQTT charging state then publishes `charging_mode`,
 *   `cable_connected` and `charging`; power arrives on `measure_power`.
 */
function simulateSmappee(charger: MockDevice, chargingW: number) {
  let backgroundW = 1000;
  let mode = 'normal';
  const drawW = (): number => (mode === 'paused' ? 0 : chargingW);
  const reportState = (): void => {
    charger.setActualCapabilityValue('charging_mode', mode);
    charger.setActualCapabilityValue('charging', mode !== 'paused');
    charger.setActualCapabilityValue('measure_power', drawW());
  };
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  const put = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    const value: unknown = body && typeof body === 'object' && 'value' in body ? body.value : undefined;
    if (path === pathFor('charging_mode') && (typeof value !== 'string' || !MODES.includes(value))) {
      throw new Error('invalid charging mode');
    }
    await originalPut(path, body);
    if (path === pathFor('charging_mode') && typeof value === 'string') {
      mode = value;
      setTimeout(reportState, 3_000);
    }
  });
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') return {
      items: [{ type: 'cumulative', id: 'meter-main', values: { W: backgroundW + drawW() } }],
    };
    if (path === 'manager/flow/flow/' || path === 'manager/flow/advancedflow/') return {};
    return originalGet(path);
  });
  return {
    mode: () => mode,
    modeWrites: () => put.mock.calls.filter(([path]) => path === pathFor('charging_mode'))
      .map(([, body]) => (body as { value: string }).value),
    setBackground: (watts: number) => { backgroundW = watts; },
  };
}

async function buildSmappee(chargingW: number): Promise<MockDevice> {
  const device = new MockDevice(ID, 'EV Wall', [
    'measure_power', 'measure_power.alwayson', 'cable_connected', 'charging', 'charging_mode',
  ], 'other');
  device.setDriverIdentity({ ownerUri: 'homey:app:com.smappee', driverId: 'homey:app:com.smappee:ev-wall' });
  device.setCapabilityMetadata('cable_connected', { setable: false });
  device.setCapabilityMetadata('charging', { setable: false });
  device.setCapabilityMetadata('charging_mode', { setable: true, values: MODES.map((id) => ({ id })) });
  await device.setCapabilityValue('cable_connected', true);
  await device.setCapabilityValue('charging', true);
  await device.setCapabilityValue('charging_mode', 'normal');
  await device.setCapabilityValue('measure_power', chargingW);
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

describe('Smappee EV Wall (com.smappee) at the SDK boundary', () => {
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

  it('pauses through charging_mode under pressure and resumes in standard charging when there is room', async () => {
    const charger = await buildSmappee(16 * 230);
    const simulation = simulateSmappee(charger, 16 * 230);
    configureRuntime(1000 + 17 * 230);
    mockHomeyInstance.settings.set('overshoot_behaviors', { [ID]: { action: 'turn_off' } });
    simulation.setBackground(1000 + 18 * 230);
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(95_000);
    expect(simulation.mode()).toBe('paused');
    simulation.setBackground(1000);
    await vi.advanceTimersByTimeAsync(900_000);
    expect(simulation.mode()).toBe('normal');
    expect(simulation.modeWrites()).toEqual(['paused', 'normal']);
  });
});
