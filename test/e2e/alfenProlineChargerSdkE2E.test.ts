import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CONTROLLABLE_DEVICES,
  MANAGED_DEVICES, OPERATING_MODE_SETTING, DEVICE_POWER_CONTROL_MODES,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { connectLiveFeed } from '../helpers/liveFeedSocketHarness';

const ID = 'alfen-ace';
const pathFor = (capability: string) => `manager/devices/device/${ID}/capability/${capability}`;
const CABLE_MAX_A = 16;
const PAUSE_CURRENT_A = 5;

type Phases = 1 | 3;
type LoggedEvent = { event?: unknown };

/**
 * The community Alfen Pro-line/ACE app (`Alfen.ProlineSingle` 1.3.7,
 * `alfen-ace` driver), as its shipped `device.js` behaves without its own
 * load balancing or solar mode:
 * - `max_current` writes the Modbus charging current (1 A to the cable
 *   limit), lifts a pause, and reads the current back.
 * - `evcharger_charging = false` pauses at 5 A; `true` restores the current
 *   from before the pause.
 * - A 30 s keep-alive rewrites the current (5 A while paused, otherwise the
 *   last written current, at least 6 A); a 30 s poll publishes the Mode 3
 *   state, with `evcharger_charging` true only while the car draws, and while
 *   paused the app holds `plugged_in_paused` and `evcharger_charging = false`.
 * A car takes current from 6 A; below that the charger suspends it.
 */
function simulateProline(charger: MockDevice, phases: Phases, initialA: number) {
  let backgroundW = 1000;
  let setpointA = initialA;
  let userMaxA = CABLE_MAX_A;
  let paused = false;
  let prePauseA: number | null = null;
  const resumes: number[] = [];
  const chargingW = (): number => (setpointA >= 6 ? setpointA * phases * 230 : 0);
  const publishCurrent = (): void => charger.setActualCapabilityValue('max_current', setpointA);
  const poll = (): void => {
    publishCurrent();
    charger.setActualCapabilityValue('charging_paused', paused);
    charger.setActualCapabilityValue('measure_power', chargingW());
    if (paused) return;
    charger.setActualCapabilityValue('evcharger_charging', chargingW() > 0);
    charger.setActualCapabilityValue('evcharger_charging_state', chargingW() > 0 ? 'plugged_in_charging' : 'plugged_in_paused');
  };
  const keepalive = (): void => {
    setpointA = paused ? PAUSE_CURRENT_A : Math.max(6, Math.min(setpointA, userMaxA));
    publishCurrent();
  };
  setInterval(poll, 30_000);
  setInterval(keepalive, 30_000);
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  const putSpy = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    await originalPut(path, body);
    const value: unknown = body && typeof body === 'object' && 'value' in body ? body.value : undefined;
    if (path === pathFor('max_current') && typeof value === 'number') {
      paused = false;
      prePauseA = null;
      charger.setActualCapabilityValue('charging_paused', false);
      setpointA = value;
      userMaxA = value;
      publishCurrent();
    }
    if (path === pathFor('evcharger_charging') && value === false && !paused) {
      prePauseA = setpointA;
      paused = true;
      setpointA = PAUSE_CURRENT_A;
      publishCurrent();
      charger.setActualCapabilityValue('charging_paused', true);
      charger.setActualCapabilityValue('evcharger_charging', false);
      charger.setActualCapabilityValue('evcharger_charging_state', 'plugged_in_paused');
    }
    if (path === pathFor('evcharger_charging') && value === true && paused) {
      paused = false;
      setpointA = prePauseA ?? setpointA;
      resumes.push(setpointA);
      prePauseA = null;
      publishCurrent();
      charger.setActualCapabilityValue('charging_paused', false);
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
    resumes,
    setpointA: () => setpointA,
    paused: () => paused,
    chargingW,
    currentWrites: () => putSpy.mock.calls.filter(([path]) => path === pathFor('max_current'))
      .map(([, body]) => (body as { value: number }).value),
    setBackground: (watts: number) => { backgroundW = watts; },
  };
}

async function buildProline(phases: Phases, currentA: number): Promise<MockDevice> {
  const device = new MockDevice(ID, 'Alfen Pro-line', [
    'evcharger_charging', 'measure_power', 'max_current', 'meter_power', 'charge_phases', 'actual_max_current',
    'safe_current', 'car_connected', 'charging_paused', 'evcharger_charging_state',
  ], 'evcharger');
  device.setDriverIdentity({
    ownerUri: 'homey:app:Alfen.ProlineSingle', driverId: 'homey:app:Alfen.ProlineSingle:alfen-ace',
  });
  device.setSettings({ grid_phases: String(phases), max_current_limit: CABLE_MAX_A, lb_enabled: false });
  device.setCapabilityMetadata('max_current', { min: 1, max: CABLE_MAX_A, step: 1, setable: true, units: 'A' });
  const charging = currentA >= 6;
  await device.setCapabilityValue('max_current', currentA);
  await device.setCapabilityValue('charge_phases', String(phases));
  await device.setCapabilityValue('car_connected', true);
  await device.setCapabilityValue('charging_paused', false);
  await device.setCapabilityValue('evcharger_charging', charging);
  await device.setCapabilityValue('evcharger_charging_state', charging ? 'plugged_in_charging' : 'plugged_in_paused');
  await device.setCapabilityValue('measure_power', charging ? currentA * phases * 230 : 0);
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
  if (!device) throw new Error('Alfen Pro-line missing from /ui_devices');
  return device;
}

describe.each([1, 3] as const)('Alfen Pro-line (Alfen.ProlineSingle) on %i phase(s) at the SDK boundary', (phases) => {
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

  it('offers whole-amp levels from 6 A to the cable limit in the charger\'s phase watts', async () => {
    const charger = await buildProline(phases, 16);
    simulateProline(charger, phases, 16);
    configureRuntime(1000 + 16 * wattsPerAmp);
    await createApp().onInit();
    const device = await readCharger();
    expect(device.automaticPowerControl?.mode).toBe('automatic');
    expect(device.steppedLoadProfile?.steps.map((step) => step.planningPowerW)).toEqual([
      0, ...Array.from({ length: CABLE_MAX_A - 5 }, (_, index) => (index + 6) * wattsPerAmp),
    ]);
  });

  it('reduces a running session to what fits in whole amps, and holds it through the keep-alive', async () => {
    const charger = await buildProline(phases, 16);
    const simulation = simulateProline(charger, phases, 16);
    configureRuntime(1000 + 10.5 * wattsPerAmp);
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(185_000);
    expect(simulation.currentWrites().length).toBeGreaterThan(0);
    for (const amps of simulation.currentWrites()) {
      expect(Number.isInteger(amps)).toBe(true);
      expect(amps).toBeGreaterThanOrEqual(6);
    }
    expect(simulation.setpointA()).toBeGreaterThanOrEqual(6);
    expect(simulation.setpointA()).toBeLessThanOrEqual(10);
  });

  it('pauses under pressure, then resumes at a safe current instead of the pre-pause 16 A', async () => {
    const charger = await buildProline(phases, 16);
    const simulation = simulateProline(charger, phases, 16);
    configureRuntime(1000 + 10.5 * wattsPerAmp);
    simulation.setBackground(1000 + 12 * wattsPerAmp);
    const app = createApp();
    const loggedEvents: LoggedEvent[] = [];
    app.log = recordingLog(loggedEvents, app.log.bind(app));
    await app.onInit();
    await vi.advanceTimersByTimeAsync(95_000);
    expect(simulation.paused()).toBe(true);
    expect(simulation.chargingW()).toBe(0);
    simulation.setBackground(1000);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(simulation.paused()).toBe(false);
    expect(simulation.chargingW()).toBeGreaterThan(0);
    expect(simulation.setpointA()).toBeLessThanOrEqual(10);
    expect(simulation.resumes).toEqual([]);
    const events = loggedEvents.map(({ event }) => event);
    expect(events).toContain('binary_command_succeeded');
    expect(events).not.toContain('binary_command_reachability_backoff_armed');
  });

  it('keeps a paused charger paused when the house cannot afford 6 A', async () => {
    const charger = await buildProline(phases, 16);
    const simulation = simulateProline(charger, phases, 16);
    configureRuntime(1000 + 5 * wattsPerAmp);
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(400_000);
    expect(simulation.paused()).toBe(true);
    expect(simulation.chargingW()).toBe(0);
    expect(simulation.resumes).toEqual([]);
  });
});
