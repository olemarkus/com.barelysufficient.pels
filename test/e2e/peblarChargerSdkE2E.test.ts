import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CONTROLLABLE_DEVICES,
  MANAGED_DEVICES, OPERATING_MODE_SETTING, DEVICE_POWER_CONTROL_MODES,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { connectLiveFeed } from '../helpers/liveFeedSocketHarness';

const ID = 'peblar';
const pathFor = (capability: string) => `manager/devices/device/${ID}/capability/${capability}`;
const ALLOWED_MAX_A = 16;
const PAUSE_WINDOW_MS = 10 * 60 * 1000;

type Phases = 1 | 3;
type LoggedEvent = { event?: unknown };

/**
 * The community Peblar app (`com.KyleMichiels.Peblar` 4.2.8,
 * `peblar_charger` driver), as the app behaves:
 * - `peblar_charge_limit` sets the charger's charge limit (whole amps) and
 *   publishes the amps at once.
 * - `evcharger_charging = true` sets the limit to the allowed maximum,
 *   `false` sets it to 0; a fourth pause inside ten minutes is refused.
 * - A 10 s poll publishes the limit, `evcharger_charging` as limit >= 6 A,
 *   and the CP state (State B, `plugged_in_paused`, while the limit holds
 *   the car; State C, `plugged_in_charging`, while it draws).
 */
function simulatePeblar(charger: MockDevice, phases: Phases, initialA: number) {
  let backgroundW = 1000;
  let limitMa = initialA * 1000;
  let pauses: number[] = [];
  const fullStarts: number[] = [];
  const limitA = (): number => Math.round(limitMa / 1000);
  const chargingW = (): number => (limitMa >= 6000 ? limitA() * phases * 230 : 0);
  const poll = (): void => {
    charger.setActualCapabilityValue('peblar_charge_limit', limitA());
    charger.setActualCapabilityValue('evcharger_charging', limitMa >= 6000);
    charger.setActualCapabilityValue('evcharger_charging_state', chargingW() > 0 ? 'plugged_in_charging' : 'plugged_in_paused');
    charger.setActualCapabilityValue('measure_power', chargingW());
  };
  setInterval(poll, 10_000);
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  const putSpy = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    const value: unknown = body && typeof body === 'object' && 'value' in body ? body.value : undefined;
    if (path === pathFor('evcharger_charging') && value === false) {
      pauses = pauses.filter((at) => at >= Date.now() - PAUSE_WINDOW_MS);
      if (pauses.length >= 3) throw new Error('Pausing charging is limited to 3 times per 10 minutes.');
      pauses.push(Date.now());
    }
    await originalPut(path, body);
    if (path === pathFor('peblar_charge_limit') && typeof value === 'number') {
      limitMa = Math.max(1, Math.min(48, Math.round(value))) * 1000;
      charger.setActualCapabilityValue('peblar_charge_limit', limitA());
    }
    if (path === pathFor('evcharger_charging') && typeof value === 'boolean') {
      if (value) fullStarts.push(ALLOWED_MAX_A);
      limitMa = value ? ALLOWED_MAX_A * 1000 : 0;
      charger.setActualCapabilityValue('evcharger_charging', limitMa >= 6000);
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
    fullStarts,
    limitA,
    chargingW,
    limitWrites: () => putSpy.mock.calls.filter(([path]) => path === pathFor('peblar_charge_limit'))
      .map(([, body]) => (body as { value: number }).value),
    setBackground: (watts: number) => { backgroundW = watts; },
  };
}

async function buildPeblar(phases: Phases, limitA: number): Promise<MockDevice> {
  const device = new MockDevice(ID, 'Peblar Home', [
    'meter_power.charged', 'measure_power', 'evcharger_charging', 'evcharger_charging_state', 'peblar_charging_state',
    'peblar_charge_limit', 'peblar_force_1_phase', 'peblar_phase_mode',
    'peblar_voltage_l1', 'peblar_voltage_l2', 'peblar_voltage_l3',
  ], 'evcharger');
  device.setDriverIdentity({
    ownerUri: 'homey:app:com.KyleMichiels.Peblar', driverId: 'homey:app:com.KyleMichiels.Peblar:peblar_charger',
  });
  device.setCapabilityMetadata('peblar_charge_limit', { min: 6, max: ALLOWED_MAX_A, step: 1, setable: true, units: 'A' });
  const charging = limitA >= 6;
  await device.setCapabilityValue('peblar_charge_limit', limitA);
  await device.setCapabilityValue('peblar_force_1_phase', false);
  await device.setCapabilityValue('peblar_phase_mode', '3F');
  await device.setCapabilityValue('peblar_voltage_l1', 231);
  await device.setCapabilityValue('peblar_voltage_l2', phases === 3 ? 230 : 0);
  await device.setCapabilityValue('peblar_voltage_l3', phases === 3 ? 229 : 0);
  await device.setCapabilityValue('evcharger_charging', charging);
  await device.setCapabilityValue('evcharger_charging_state', charging ? 'plugged_in_charging' : 'plugged_in_paused');
  await device.setCapabilityValue('measure_power', charging ? limitA * phases * 230 : 0);
  setMockDrivers({ chargers: new MockDriver('chargers', [device]) });
  return device;
}

function configureRuntime(limitW: number): void {
  mockHomeyInstance.settings.set(DEVICE_POWER_CONTROL_MODES, { [ID]: 'automatic' });
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

async function readCharger() {
  const response = await api.ui_devices({ homey: mockHomeyInstance as never });
  const device = response.devices.find((candidate) => candidate.id === ID);
  if (!device) throw new Error('Peblar missing from /ui_devices');
  return device;
}

describe.each([1, 3] as const)('Peblar (com.KyleMichiels.Peblar) on %i phase(s) at the SDK boundary', (phases) => {
  const wattsPerAmp = phases * 230;
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

  it('offers whole-amp levels from 6 A to the allowed maximum in the charger\'s phase watts', async () => {
    const charger = await buildPeblar(phases, 16);
    simulatePeblar(charger, phases, 16);
    configureRuntime(1000 + 16 * wattsPerAmp);
    await createApp().onInit();
    const device = await readCharger();
    expect(device.automaticPowerControl?.mode).toBe('automatic');
    expect(device.steppedLoadProfile?.steps.map((step) => step.planningPowerW)).toEqual([
      0, ...Array.from({ length: ALLOWED_MAX_A - 5 }, (_, index) => (index + 6) * wattsPerAmp),
    ]);
  });

  it('reduces a running session to what fits in whole amps', async () => {
    const charger = await buildPeblar(phases, 16);
    const simulation = simulatePeblar(charger, phases, 16);
    configureRuntime(1000 + 10.5 * wattsPerAmp);
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(185_000);
    expect(simulation.limitWrites().length).toBeGreaterThan(0);
    for (const amps of simulation.limitWrites()) {
      expect(Number.isInteger(amps)).toBe(true);
      expect(amps).toBeGreaterThanOrEqual(6);
    }
    expect(simulation.limitA()).toBeGreaterThanOrEqual(6);
    expect(simulation.limitA()).toBeLessThanOrEqual(10);
  });

  it('pauses under pressure, then resumes at a safe current instead of the allowed maximum', async () => {
    const charger = await buildPeblar(phases, 16);
    const simulation = simulatePeblar(charger, phases, 16);
    configureRuntime(1000 + 10.5 * wattsPerAmp);
    simulation.setBackground(1000 + 12 * wattsPerAmp);
    const app = createApp();
    const loggedEvents: LoggedEvent[] = [];
    app.log = recordingLog(loggedEvents, app.log.bind(app));
    await app.onInit();
    await vi.advanceTimersByTimeAsync(95_000);
    expect(simulation.chargingW()).toBe(0);
    simulation.setBackground(1000);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(simulation.chargingW()).toBeGreaterThan(0);
    expect(simulation.limitA()).toBeLessThanOrEqual(10);
    expect(simulation.fullStarts).toEqual([]);
    const events = loggedEvents.map(({ event }) => event);
    expect(events).toContain('binary_command_succeeded');
    expect(events).not.toContain('binary_command_reachability_backoff_armed');
  });

  it('keeps a paused charger paused when the house cannot afford 6 A', async () => {
    const charger = await buildPeblar(phases, 0);
    const simulation = simulatePeblar(charger, phases, 0);
    configureRuntime(1000 + 5 * wattsPerAmp);
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(400_000);
    expect(simulation.chargingW()).toBe(0);
    expect(simulation.fullStarts).toEqual([]);
  });
});
