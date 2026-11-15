import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CONTROLLABLE_DEVICES, DEVICE_POWER_CONTROL_MODES,
  MANAGED_DEVICES, OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainPending } from '../utils/asyncDrain';
import { connectLiveFeed, emitDeviceUpdate } from '../helpers/liveFeedSocketHarness';

const ID = 'ocpp';
const MAX_CURRENT_A = 16;
const pathFor = (capability: string) => `manager/devices/device/${ID}/capability/${capability}`;
const PHASE_READINGS = ['measure_current.l1', 'measure_voltage.l1', 'measure_current.l2', 'measure_voltage.l2',
  'measure_current.l3', 'measure_voltage.l3'];
const INSTALLS = [
  { phases: '1', wattsPerAmp: 230 },
  { phases: '3', wattsPerAmp: 690 },
] as const;

/**
 * The OCPP Server app's `charger` (`com.dnetlabs.ocpp` 1.0.16, class
 * `evcharger`) as paired: `phases` is a string setting, `target_power` runs
 * from 0 W to `max_current` on those phases in 1 A steps, and `stop_behavior`
 * is `stop`. Right after pairing, with a car plugged in and no session yet,
 * the app reports `evcharger_charging` empty (null) and `plugged_in`.
 */
async function buildCharger(
  phases: string, wattsPerAmp: number, amps: number,
  session: 'charging' | 'stopped' | 'never_started' = 'charging',
): Promise<MockDevice> {
  const device = new MockDevice(ID, 'Wallbox', [
    'evcharger_charging', 'evcharger_charging_state', 'target_power', 'target_power_mode',
    'measure_current', 'meter_power', 'measure_power', 'measure_voltage', ...PHASE_READINGS,
  ], 'evcharger');
  // The app adds the per-phase readings once the charger first reports them in a session.
  for (const capabilityId of PHASE_READINGS) device.removeCapability(capabilityId);
  device.setDriverIdentity({ ownerUri: 'homey:app:com.dnetlabs.ocpp', driverId: 'homey:app:com.dnetlabs.ocpp:charger' });
  device.setSettings({
    ocpp_id: 'CP-1', phases, max_current: MAX_CURRENT_A, stop_behavior: 'stop', energy_exclude: false,
  });
  device.setCapabilityMetadata('target_power', {
    min: 0, max: MAX_CURRENT_A * wattsPerAmp, step: wattsPerAmp, setable: true, units: 'W',
  });
  device.setCapabilityMetadata('evcharger_charging', { setable: true });
  device.setCapabilityMetadata('target_power_mode', { setable: true });
  // Homey echoes a write with the writer's transaction id; the app republishes
  // none of these itself, except `target_power_mode`, and an unchanged value fires nothing.
  for (const capabilityId of ['target_power', 'target_power_mode', 'evcharger_charging']) {
    device.configureCapabilityBehavior(capabilityId, { onApiWrite: { emitCapabilityEvent: true } });
  }
  await device.setCapabilityValue('target_power', amps * wattsPerAmp);
  await device.setCapabilityValue('target_power_mode', 'homey');
  const charging = session === 'charging';
  await device.setCapabilityValue('evcharger_charging', { charging: true, stopped: false, never_started: null }[session]);
  await device.setCapabilityValue('evcharger_charging_state', charging ? 'plugged_in_charging' : 'plugged_in');
  await device.setCapabilityValue('measure_current', charging ? amps : 0);
  await device.setCapabilityValue('measure_voltage', 230);
  await device.setCapabilityValue('measure_power', charging ? amps * wattsPerAmp : 0);
  setMockDrivers({ chargers: new MockDriver('chargers', [device]) });
  return device;
}

/**
 * The app's commands as it carries them out over OCPP: a positive target sets
 * the charger's current limit (whole amps, up to `max_current`) and never
 * starts a session; a 0 W target is ignored under `stop_behavior` `stop`; the
 * switch starts a transaction (`true`) or stops it (`false`). The charger's
 * status and meter values reach Homey a few seconds later. Homey drops an
 * unchanged value: it fires no event and keeps its date.
 */
function simulateOcpp(charger: MockDevice, wattsPerAmp: number, amps: number) {
  let backgroundW = 1000;
  let limitA = amps;
  let session = charger.getActualCapabilityValue('evcharger_charging') === true;
  const startCurrents: number[] = [];
  const drawW = (): number => (session ? limitA * wattsPerAmp : 0);
  const report = (capabilityId: string, value: unknown): void => {
    if (charger.getActualCapabilityValue(capabilityId) !== value) charger.setActualCapabilityValue(capabilityId, value);
  };
  const reportSession = (): void => {
    report('evcharger_charging', session);
    report('evcharger_charging_state', session ? 'plugged_in_charging' : 'plugged_in');
  };
  // The app never republishes `target_power`: its only update is Homey's echo of the write.
  const publish = (): void => {
    report('measure_current', session ? limitA : 0);
    report('measure_power', drawW());
  };
  setInterval(publish, 30_000);
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  const put = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    await originalPut(path, body);
    const value: unknown = body && typeof body === 'object' && 'value' in body ? body.value : undefined;
    if (path === pathFor('target_power') && typeof value === 'number' && value > 0) {
      limitA = Math.min(MAX_CURRENT_A, Math.floor(value / wattsPerAmp));
      report('target_power_mode', 'homey');
    }
    if (path === pathFor('evcharger_charging') && typeof value === 'boolean') {
      if (value && !session) startCurrents.push(limitA);
      session = value;
      setTimeout(reportSession, 3_000);
    }
    setTimeout(publish, 5_000);
  });
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') return {
      items: [{ type: 'cumulative', id: 'meter-main', values: { W: backgroundW + drawW() } }],
    };
    if (path === 'manager/flow/flow/' || path === 'manager/flow/advancedflow/') return {};
    const payload = await originalGet(path);
    if (path === `manager/devices/device/${ID}`) return withUnreportedPhases(payload);
    if (path === 'manager/devices/device') {
      const devices = payload as Record<string, unknown>;
      return { ...devices, [ID]: withUnreportedPhases(devices[ID]) };
    }
    return payload;
  });
  return {
    startCurrents,
    limitA: () => limitA,
    session: () => session,
    powerWrites: () => put.mock.calls.filter(([path]) => path === pathFor('target_power'))
      .map(([, body]) => (body as { value: number }).value),
    switchWrites: () => put.mock.calls.filter(([path]) => path === pathFor('evcharger_charging'))
      .map(([, body]) => (body as { value: boolean }).value),
    setBackground: (watts: number) => { backgroundW = watts; },
    /** The charger reports per-phase meter values, and the app adds their capabilities. */
    addPhaseReadings: async () => {
      for (const capabilityId of PHASE_READINGS) {
        charger.restoreCapability(capabilityId);
        await charger.setCapabilityValue(capabilityId, null);
      }
      emitDeviceUpdate(withUnreportedPhases(charger.toHomeyApiDevice()) as Record<string, unknown>);
    },
    /** Someone else stops the session, from the app or the charger: the app reports it. */
    stopElsewhere: () => { session = false; reportSession(); publish(); },
  };
}

/** A capability the app added and the charger never reported: no value, no date. */
function withUnreportedPhases(payload: unknown): unknown {
  const device = payload as { capabilitiesObj?: Record<string, Record<string, unknown>> } | undefined;
  if (!device?.capabilitiesObj) return payload;
  const values = Object.fromEntries(Object.entries(device.capabilitiesObj).map(([id, entry]) => [id,
    PHASE_READINGS.includes(id) ? { ...entry, value: null, lastUpdated: null } : entry]));
  return { ...device, capabilitiesObj: values };
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

async function readCharger() {
  const response = await api.ui_devices({ homey: mockHomeyInstance as never });
  const device = response.devices.find((candidate) => candidate.id === ID);
  if (!device) throw new Error('OCPP charger missing from /ui_devices');
  return device;
}

describe.each(INSTALLS)('OCPP Server charger on $phases phase(s) at the SDK boundary', ({ phases, wattsPerAmp }) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [
      'Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate',
      'clearTimeout', 'clearInterval', 'clearImmediate',
    ] });
    vi.setSystemTime(Date.UTC(2026, 10, 15, 8, 2));
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

  it('plans from 6 A to the charger\'s maximum current', async () => {
    const charger = await buildCharger(phases, wattsPerAmp, MAX_CURRENT_A);
    simulateOcpp(charger, wattsPerAmp, MAX_CURRENT_A);
    configureRuntime(1000 + 20 * wattsPerAmp);
    await createApp().onInit();
    expect((await readCharger()).steppedLoadProfile?.steps.map((step) => step.planningPowerW)).toEqual([
      0, ...Array.from({ length: MAX_CURRENT_A - 5 }, (_, index) => (index + 6) * wattsPerAmp),
    ]);
  });

  it('steps a running session down under pressure, never below 6 A', async () => {
    const charger = await buildCharger(phases, wattsPerAmp, MAX_CURRENT_A);
    const simulation = simulateOcpp(charger, wattsPerAmp, MAX_CURRENT_A);
    configureRuntime(1000 + 10.5 * wattsPerAmp);
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(125_000);
    await drainPending();
    const positive = simulation.powerWrites().filter((watts) => watts > 0);
    expect(positive.length).toBeGreaterThan(0);
    expect(positive.every((watts) => watts >= 6 * wattsPerAmp)).toBe(true);
    expect(simulation.session()).toBe(true);
    expect(simulation.limitA()).toBeGreaterThanOrEqual(6);
    expect(simulation.limitA()).toBeLessThanOrEqual(10);
  });

  it('stops the session when 6 A does not fit and starts a new one at a safe limit when room returns', async () => {
    const charger = await buildCharger(phases, wattsPerAmp, MAX_CURRENT_A);
    const simulation = simulateOcpp(charger, wattsPerAmp, MAX_CURRENT_A);
    configureRuntime(1000 + 10.5 * wattsPerAmp);
    simulation.setBackground(1000 + 12 * wattsPerAmp);
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(125_000);
    expect(simulation.switchWrites()).toContain(false);
    expect(simulation.session()).toBe(false);
    simulation.setBackground(1000);
    await vi.advanceTimersByTimeAsync(600_000);
    await drainPending();
    expect(simulation.startCurrents.length).toBeGreaterThan(0);
    expect(simulation.startCurrents.every((amps) => amps >= 6 && amps <= 10)).toBe(true);
    expect(simulation.session()).toBe(true);
    expect(simulation.powerWrites().filter((watts) => watts > 0)
      .every((watts) => watts >= 6 * wattsPerAmp)).toBe(true);
    expect(simulation.powerWrites()).not.toContain(0);
  });
  it('starts a freshly paired charger whose switch is still empty when there is room', async () => {
    const charger = await buildCharger(phases, wattsPerAmp, MAX_CURRENT_A, 'never_started');
    const simulation = simulateOcpp(charger, wattsPerAmp, MAX_CURRENT_A);
    configureRuntime(1000 + 10.5 * wattsPerAmp);
    await createApp().onInit();
    expect((await readCharger()).binaryControl).toEqual({ on: false });
    await vi.advanceTimersByTimeAsync(395_000);
    await drainPending();
    expect(simulation.startCurrents.length).toBe(1);
    expect(simulation.startCurrents.every((amps) => amps >= 6 && amps <= 10)).toBe(true);
    expect(simulation.session()).toBe(true);
  });

  it('starts a new session at a safe limit after a stop made elsewhere', async () => {
    const charger = await buildCharger(phases, wattsPerAmp, 7);
    const simulation = simulateOcpp(charger, wattsPerAmp, 7);
    configureRuntime(1000 + 10.5 * wattsPerAmp);
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(65_000);
    simulation.stopElsewhere();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await readCharger()).binaryControl).toEqual({ on: false });
    await vi.advanceTimersByTimeAsync(600_000);
    await drainPending();
    expect(simulation.switchWrites()).toContain(true);
    expect(simulation.startCurrents.length).toBeGreaterThan(0);
    expect(simulation.startCurrents.every((amps) => amps >= 6 && amps <= 10)).toBe(true);
    expect(simulation.session()).toBe(true);
  });

  it('keeps the 6 A floor across full refreshes and device updates', async () => {
    const charger = await buildCharger(phases, wattsPerAmp, MAX_CURRENT_A);
    simulateOcpp(charger, wattsPerAmp, MAX_CURRENT_A);
    configureRuntime(1000 + 10.5 * wattsPerAmp);
    await createApp().onInit();
    const floor = async () => {
      const device = await readCharger();
      return [device.steppedLoadProfile?.steps[1]?.planningPowerW,
        device.automaticPowerControl?.profile.steps[1]?.planningPowerW];
    };
    expect(await floor()).toEqual([6 * wattsPerAmp, 6 * wattsPerAmp]);
    for (let minute = 0; minute < 30; minute += 5) {
      emitDeviceUpdate(charger.toHomeyApiDevice());
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(await floor()).toEqual([6 * wattsPerAmp, 6 * wattsPerAmp]);
    }
  });
  it('keeps the 6 A floor and restarts after a stop once the app adds per-phase readings', async () => {
    const charger = await buildCharger(phases, wattsPerAmp, MAX_CURRENT_A, 'never_started');
    const simulation = simulateOcpp(charger, wattsPerAmp, MAX_CURRENT_A);
    configureRuntime(1000 + 10.5 * wattsPerAmp);
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(395_000);
    expect(simulation.session()).toBe(true);
    await simulation.addPhaseReadings();
    await vi.advanceTimersByTimeAsync(330_000);
    const device = await readCharger();
    expect(device.steppedLoadProfile?.steps[1]?.planningPowerW).toBe(6 * wattsPerAmp);
    expect(device.automaticPowerControl?.profile.steps[1]?.planningPowerW).toBe(6 * wattsPerAmp);
    const startsBefore = simulation.startCurrents.length;
    simulation.stopElsewhere();
    await vi.advanceTimersByTimeAsync(600_000);
    await drainPending();
    expect(simulation.startCurrents.length).toBeGreaterThan(startsBefore);
    expect(simulation.startCurrents.every((amps) => amps >= 6 && amps <= 10)).toBe(true);
    expect(simulation.session()).toBe(true);
    expect(simulation.powerWrites().filter((watts) => watts > 0).every((watts) => watts >= 6 * wattsPerAmp)).toBe(true);
  });
  it('changes a stopped session\'s limit before starting it, with only the echo of the write to read', async () => {
    const charger = await buildCharger(phases, wattsPerAmp, 1, 'stopped');
    const simulation = simulateOcpp(charger, wattsPerAmp, 1);
    configureRuntime(1000 + 10.5 * wattsPerAmp);
    await createApp().onInit();
    // The start follows the prepared limit after the ordinary five-minute restore pacing.
    await vi.advanceTimersByTimeAsync(395_000);
    await drainPending();
    expect(simulation.powerWrites().some((watts) => watts >= 6 * wattsPerAmp)).toBe(true);
    expect(simulation.startCurrents.length).toBe(1);
    expect(simulation.startCurrents.every((amps) => amps >= 6 && amps <= 10)).toBe(true);
    expect(simulation.session()).toBe(true);
  });
});
