import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CONTROLLABLE_DEVICES,
  MANAGED_DEVICES, OPERATING_MODE_SETTING, DEVICE_POWER_CONTROL_MODES, DEVICE_TARGET_POWER_CONFIGS,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { connectLiveFeed } from '../helpers/liveFeedSocketHarness';

const ID = 'alfen';
const pathFor = (capability: string) => `manager/devices/device/${ID}/capability/${capability}`;
const STATION_LIMIT_A = 32;

type Phases = 1 | 3;

function plugState(plugged: boolean, charging: boolean): string {
  if (!plugged) return 'plugged_out';
  return charging ? 'plugged_in_charging' : 'plugged_in_paused';
}

/**
 * The official Alfen app (`com.alfen` 2.1.1, `chargepoint` driver), as its
 * shipped `device.js` and `lib/AlfenApi.js` behave:
 * - `target_power` is the OCPP external-constraint profile. A write is sent as
 *   `round(round(W / 230, 0.1) / phases, 0.1)` A per phase, and the next read
 *   publishes `ampsPerPhase × phases × 230` back. The driver re-declares the
 *   capability as `{ min: 0, max: limit × phases × 230, step: 230, excludeMin: 0,
 *   excludeMax: 1380 }` whatever the phase count.
 * - `evcharger_charging` is derived from the charger mode (`true` only while
 *   charging). Writing it sets the profile: `true` to the station limit's
 *   watts, `false` to 0 W.
 * - Phases are read from `measure_voltage.l2/l3` (> 50 V means three).
 * - Every write is followed by a read; the app also polls every 30 s.
 * A car takes current from 6 A per phase; below that the charger suspends it.
 */
function simulateAlfen(charger: MockDevice, phases: Phases, initialAmps: number, plugged = true) {
  let backgroundW = 1000;
  let ampsPerPhase = initialAmps;
  const startWrites: boolean[] = [];
  const chargingW = (): number => (plugged && ampsPerPhase >= 6 ? Math.round(ampsPerPhase * phases * 230) : 0);
  const publish = (): void => {
    charger.setActualCapabilityValue('target_power', ampsPerPhase * phases * 230);
    const charging = chargingW() > 0;
    charger.setActualCapabilityValue('evcharger_charging', charging);
    charger.setActualCapabilityValue('evcharger_charging_state', plugState(plugged, charging));
    charger.setActualCapabilityValue('measure_power', chargingW());
  };
  const setProfileW = (watts: number): void => {
    const totalAmps = Math.round((watts / 230) * 10) / 10;
    ampsPerPhase = Math.round((totalAmps / phases) * 10) / 10;
  };
  setInterval(publish, 30_000);
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  const putSpy = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    await originalPut(path, body);
    const value: unknown = body && typeof body === 'object' && 'value' in body ? body.value : undefined;
    if (path === pathFor('target_power') && typeof value === 'number') setProfileW(value);
    if (path === pathFor('evcharger_charging') && typeof value === 'boolean') {
      startWrites.push(value);
      setProfileW(value ? STATION_LIMIT_A * phases * 230 : 0);
    }
    if (path === pathFor('target_power') || path === pathFor('evcharger_charging')) publish();
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
    startWrites,
    ampsPerPhase: () => ampsPerPhase,
    chargingW,
    powerWrites: () => putSpy.mock.calls.filter(([path]) => path === pathFor('target_power'))
      .map(([, body]) => (body as { value: number }).value),
    setBackground: (watts: number) => { backgroundW = watts; },
  };
}

async function buildAlfen(phases: Phases, ampsPerPhase: number, plugged = true): Promise<MockDevice> {
  const device = new MockDevice(ID, 'Alfen Eve', [
    'operatingmode', 'measure_current', 'measure_power', 'target_power', 'evcharger_charging',
    'evcharger_charging_state', 'meter_power', 'measure_voltage.l1', 'measure_voltage.l2', 'measure_voltage.l3',
    'measure_current.limit', 'measure_current.stationlimit',
  ], 'evcharger');
  device.setDriverIdentity({ ownerUri: 'homey:app:com.alfen', driverId: 'homey:app:com.alfen:chargepoint' });
  device.setCapabilityMetadata('target_power', {
    min: 0, max: STATION_LIMIT_A * phases * 230, step: 230, excludeMin: 0, excludeMax: 1380,
    setable: true, units: 'W',
  });
  device.setCapabilityMetadata('measure_current.limit', { min: 1, max: 32, step: 1, setable: true, units: 'A' });
  const watts = Math.round(ampsPerPhase * phases * 230);
  const charging = plugged && ampsPerPhase >= 6;
  await device.setCapabilityValue('target_power', watts);
  await device.setCapabilityValue('measure_current.limit', STATION_LIMIT_A);
  await device.setCapabilityValue('measure_current.stationlimit', STATION_LIMIT_A);
  await device.setCapabilityValue('measure_voltage.l1', 231);
  await device.setCapabilityValue('measure_voltage.l2', phases === 3 ? 230 : 0);
  await device.setCapabilityValue('measure_voltage.l3', phases === 3 ? 229 : 0);
  await device.setCapabilityValue('evcharger_charging', charging);
  await device.setCapabilityValue('evcharger_charging_state', plugState(plugged, charging));
  await device.setCapabilityValue('measure_power', charging ? watts : 0);
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

type LoggedEvent = { event?: unknown };

/** `log`, also recording each structured event the app logs (one JSON line each). */
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
  if (!device) throw new Error('Alfen missing from /ui_devices');
  return device;
}

describe.each([1, 3] as const)('Alfen (com.alfen) on %i phase(s) at the SDK boundary', (phases) => {
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

  it('offers whole-amp levels from 6 A to the station limit in the station\'s phase watts', async () => {
    const charger = await buildAlfen(phases, 16);
    simulateAlfen(charger, phases, 16);
    configureRuntime(1000 + 16 * wattsPerAmp);
    await createApp().onInit();
    const steps = (await readCharger()).steppedLoadProfile?.steps;
    expect(steps?.map((step) => step.planningPowerW)).toEqual([
      0, ...Array.from({ length: 27 }, (_, index) => (index + 6) * wattsPerAmp),
    ]);
  });

  it('reduces a running session to what fits, only in whole amps of at least 6 A', async () => {
    const charger = await buildAlfen(phases, 16);
    const simulation = simulateAlfen(charger, phases, 16);
    configureRuntime(1000 + 10.5 * wattsPerAmp);
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(95_000);
    expect(simulation.powerWrites().length).toBeGreaterThan(0);
    for (const watts of simulation.powerWrites().filter((value) => value > 0)) {
      expect(watts % wattsPerAmp).toBe(0);
      expect(watts / wattsPerAmp).toBeGreaterThanOrEqual(6);
    }
    expect(simulation.ampsPerPhase()).toBeGreaterThanOrEqual(6);
    expect(simulation.ampsPerPhase()).toBeLessThanOrEqual(10);
    expect(simulation.startWrites).toEqual([]);
  });

  it('pauses under pressure and resumes at a safe current, never through the app\'s full-power switch', async () => {
    const charger = await buildAlfen(phases, 16);
    const simulation = simulateAlfen(charger, phases, 16);
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
    expect(simulation.ampsPerPhase()).toBeLessThanOrEqual(10);
    expect(simulation.startWrites.filter((value) => value)).toEqual([]);
    // The resume confirms from the limit's read-back; it is never left unconfirmed.
    const events = loggedEvents.map(({ event }) => event);
    expect(events).toContain('binary_command_succeeded');
    expect(events).not.toContain('binary_command_reachability_backoff_armed');
  });

  it('starts a stopped session with a safe current, not at the 32 A station limit', async () => {
    const charger = await buildAlfen(phases, 0);
    const simulation = simulateAlfen(charger, phases, 0);
    configureRuntime(1000 + 10.5 * wattsPerAmp);
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(400_000);
    expect(simulation.chargingW()).toBeGreaterThan(0);
    expect(simulation.ampsPerPhase()).toBeLessThanOrEqual(10);
    expect(simulation.startWrites.filter((value) => value)).toEqual([]);
  });

  it('keeps a stopped charger off when the house cannot afford 6 A', async () => {
    const charger = await buildAlfen(phases, 0);
    const simulation = simulateAlfen(charger, phases, 0);
    configureRuntime(1000 + 5 * wattsPerAmp);
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(400_000);
    expect(simulation.chargingW()).toBe(0);
    expect(simulation.startWrites.filter((value) => value)).toEqual([]);
  });

  it('resumes at the station\'s 6 A with a saved EV model using the other phase count', async () => {
    const charger = await buildAlfen(phases, 0);
    const simulation = simulateAlfen(charger, phases, 0);
    // Both planning models have room for their first rung; the station still
    // receives its own native 6 A watts rather than the planning model's watts.
    configureRuntime(1000 + 10.5 * 3 * 230);
    mockHomeyInstance.settings.set(DEVICE_POWER_CONTROL_MODES, { [ID]: 'manual' });
    mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_CONFIGS, {
      [ID]: { enabled: true, preset: phases === 3 ? 'ev_charger_1_phase' : 'ev_charger_3_phase' },
    });
    const app = createApp();
    const loggedEvents: LoggedEvent[] = [];
    app.log = recordingLog(loggedEvents, app.log.bind(app));
    await app.onInit();
    await vi.advanceTimersByTimeAsync(400_000);
    expect(simulation.powerWrites().find((watts) => watts > 0)).toBe(6 * wattsPerAmp);
    expect(simulation.chargingW()).toBeGreaterThan(0);
    expect(simulation.startWrites).toEqual([]);
    expect(loggedEvents.map(({ event }) => event)).toContain('binary_command_succeeded');
  });
});
