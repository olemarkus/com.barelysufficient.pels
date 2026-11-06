import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CONTROLLABLE_DEVICES,
  MANAGED_DEVICES, OPERATING_MODE_SETTING, DEVICE_POWER_CONTROL_MODES,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { connectLiveFeed } from '../helpers/liveFeedSocketHarness';

const ID = 'zappi';
const pathFor = (capability: string) => `manager/devices/device/${ID}/capability/${capability}`;
const FAST = '1';
const ECO_PLUS = '3';
const OFF = '4';
const FAST_DRAW_W = 7360;

type LoggedEvent = { event?: unknown };

/**
 * The community myenergi app's Zappi (`net.biseth.myenergi` 2.4.18), as its
 * shipped `drivers/zappi/device.js` behaves:
 * - `onoff` and `evcharger_charging` share one listener: charge mode Off, or
 *   the owner's last mode. It updates `charge_mode` at once; `onoff` keeps
 *   the value Homey was written until the next poll.
 * - Each 60 s poll publishes `onoff` as charge mode != Off, and
 *   `evcharger_charging` / `evcharger_charging_state` from what the car does.
 * Fast draws at once; Eco+ waits for solar export, of which there is none here.
 */
function simulateZappi(charger: MockDevice, initialMode: string, lastOnMode: string) {
  let backgroundW = 1000;
  let mode = initialMode;
  const modes: string[] = [];
  const chargingW = (): number => (mode === FAST ? FAST_DRAW_W : 0);
  const poll = (): void => {
    charger.setActualCapabilityValue('onoff', mode !== OFF);
    charger.setActualCapabilityValue('charge_mode', mode);
    charger.setActualCapabilityValue('evcharger_charging', chargingW() > 0);
    charger.setActualCapabilityValue('evcharger_charging_state', chargingW() > 0 ? 'plugged_in_charging' : 'plugged_in');
    charger.setActualCapabilityValue('measure_power', chargingW());
  };
  setInterval(poll, 60_000);
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    await originalPut(path, body);
    const value: unknown = body && typeof body === 'object' && 'value' in body ? body.value : undefined;
    if ((path === pathFor('onoff') || path === pathFor('evcharger_charging')) && typeof value === 'boolean') {
      mode = value ? lastOnMode : OFF;
      modes.push(mode);
      charger.setActualCapabilityValue('charge_mode', mode);
    }
  });
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') return {
      items: [{ type: 'cumulative', id: 'meter-main', values: { W: backgroundW + chargingW() } }],
    };
    if (path === 'manager/flow/flow/' || path === 'manager/flow/advancedflow/') return {};
    return originalGet(path);
  });
  return {
    modes,
    mode: () => mode,
    chargingW,
    setBackground: (watts: number) => { backgroundW = watts; },
  };
}

async function buildZappi(mode: string): Promise<MockDevice> {
  const device = new MockDevice(ID, 'Zappi', [
    'onoff', 'evcharger_charging', 'zappi_phase_setting', 'charge_mode_selector', 'evcharger_charging_state',
    'charge_mode', 'charger_status', 'measure_power', 'measure_current', 'meter_power', 'zappi_boost_mode',
    'ev_connected', 'charger_locked',
  ], 'evcharger');
  device.setDriverIdentity({ ownerUri: 'homey:app:net.biseth.myenergi', driverId: 'homey:app:net.biseth.myenergi:zappi' });
  const charging = mode === FAST;
  await device.setCapabilityValue('onoff', mode !== OFF);
  await device.setCapabilityValue('charge_mode', mode);
  await device.setCapabilityValue('zappi_boost_mode', 'Stop');
  await device.setCapabilityValue('ev_connected', true);
  await device.setCapabilityValue('evcharger_charging', charging);
  await device.setCapabilityValue('evcharger_charging_state', charging ? 'plugged_in_charging' : 'plugged_in');
  await device.setCapabilityValue('measure_power', charging ? FAST_DRAW_W : 0);
  setMockDrivers({ chargers: new MockDriver('chargers', [device]) });
  return device;
}

function configureRuntime(limitW: number): void {
  mockHomeyInstance.settings.set(DEVICE_POWER_CONTROL_MODES, {});
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, limitW / 1000);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { [ID]: true });
  mockHomeyInstance.settings.set(MANAGED_DEVICES, { [ID]: true });
  mockHomeyInstance.settings.set('overshoot_behaviors', { [ID]: { action: 'turn_off' } });
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

describe('Zappi (net.biseth.myenergi) at the SDK boundary', () => {
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
    vi.useRealTimers();
  });

  it('stops a Fast session under pressure and starts it again in the owner\'s mode, confirmed', async () => {
    const charger = await buildZappi(FAST);
    const simulation = simulateZappi(charger, FAST, FAST);
    configureRuntime(1000 + FAST_DRAW_W + 500);
    simulation.setBackground(1000 + FAST_DRAW_W);
    const app = createApp();
    const loggedEvents: LoggedEvent[] = [];
    app.log = recordingLog(loggedEvents, app.log.bind(app));
    await app.onInit();
    await vi.advanceTimersByTimeAsync(95_000);
    expect(simulation.mode()).toBe(OFF);
    simulation.setBackground(1000);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(simulation.mode()).toBe(FAST);
    expect(simulation.chargingW()).toBe(FAST_DRAW_W);
    const events = loggedEvents.map(({ event }) => event);
    expect(events).toContain('binary_command_succeeded');
    expect(events).not.toContain('binary_command_reachability_backoff_armed');
  });

  it('confirms a start in Eco+ that waits for solar, without reading it as unresponsive', async () => {
    const charger = await buildZappi(OFF);
    const simulation = simulateZappi(charger, OFF, ECO_PLUS);
    configureRuntime(1000 + FAST_DRAW_W + 500);
    const app = createApp();
    const loggedEvents: LoggedEvent[] = [];
    app.log = recordingLog(loggedEvents, app.log.bind(app));
    await app.onInit();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(simulation.modes).toEqual([ECO_PLUS]);
    expect(simulation.chargingW()).toBe(0);
    const events = loggedEvents.map(({ event }) => event);
    expect(events).toContain('binary_command_succeeded');
    expect(events).not.toContain('binary_command_reachability_backoff_armed');
  });
});
