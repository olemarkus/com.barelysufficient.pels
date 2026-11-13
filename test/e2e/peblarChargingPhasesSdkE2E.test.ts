import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CONTROLLABLE_DEVICES,
  DEVICE_PHASE_CONNECTIONS, DEVICE_POWER_CONTROL_MODES, DEVICE_TARGET_POWER_CONFIGS,
  MANAGED_DEVICES, NATIVE_EV_WIRING_DEVICES, OPERATING_MODE_SETTING,
  MAIN_FUSE_SUPPLY, MAIN_FUSE_AMPS, MAIN_FUSE_PHASE_CAPABILITIES, MAIN_FUSE_PHASE_METER_DEVICE_ID,
} from '../../lib/utils/settingsKeys';
import { CHARGING_PHASE_SETTINGS_KEY } from '../../packages/shared-domain/src/settings/chargingPhases';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp, seedStoredPowerTrackerForTests } from '../utils/appTestUtils';
import { connectLiveFeed } from '../helpers/liveFeedSocketHarness';
import { drainPending } from '../utils/asyncDrain';

const ID = 'peblar-phases';
const pathFor = (capability: string) => `manager/devices/device/${ID}/capability/${capability}`;
type PhaseCount = 1 | 3;

/** The public capability contract: setting echoes precede independently polled physical power. */
async function modelPeblar() {
  const charger = new MockDevice(ID, 'Peblar Home', [
    'measure_power', 'meter_power.charged', 'evcharger_charging', 'evcharger_charging_state',
    'peblar_charge_limit', 'peblar_force_1_phase', 'peblar_phase_mode',
    'peblar_power_l1', 'peblar_power_l2', 'peblar_power_l3',
    'peblar_voltage_l1', 'peblar_voltage_l2', 'peblar_voltage_l3',
  ], 'evcharger');
  charger.setDriverIdentity({ ownerUri: 'homey:app:com.KyleMichiels.Peblar',
    driverId: 'homey:app:com.KyleMichiels.Peblar:peblar_charger' });
  charger.setCapabilityMetadata('peblar_charge_limit', { min: 6, max: 16, step: 1, setable: true, units: 'A' });
  charger.setCapabilityMetadata('peblar_force_1_phase', { setable: true });
  const meter = new MockDevice('meter-phases', 'House meter', [
    'measure_power', 'measure_power.l1', 'measure_power.l2', 'measure_power.l3',
  ], 'sensor');
  let phases: PhaseCount = 3;
  let currentA = 6;
  let forceSingle = false;
  let backgroundW = -2500;
  let transitionDelayMs = 20_000;
  let ignoreSwitches = false;
  let meterAvailable = true;
  let transitionActive = false;
  let idleDuringTransition = false;
  let phaseBaseW: readonly [number, number, number] | undefined;
  const phaseRequests: { atMs: number; forceSingle: boolean }[] = [];
  const currentWrites: number[] = [];
  const pauses: number[] = [];
  const watts = () => currentA >= 6 && !(transitionActive && idleDuringTransition) ? currentA * phases * 230 : 0;
  const publishOn = (device: MockDevice, capability: string, value: unknown): void => {
    // Shipped integrations may publish only changed values; quiet zeros are not fresh samples.
    if (device.getActualCapabilityValue(capability) !== value) device.setActualCapabilityValue(capability, value);
  };
  const publish = (capability: string, value: unknown) => publishOn(charger, capability, value);
  const poll = (): void => {
    publish('peblar_charge_limit', currentA);
    publish('peblar_force_1_phase', forceSingle);
    publish('peblar_phase_mode', forceSingle ? '1F' : '3F');
    const phaseW = watts() / phases;
    publish('peblar_power_l1', phaseW);
    publish('peblar_power_l2', phases === 3 ? phaseW : 0);
    publish('peblar_power_l3', phases === 3 ? phaseW : 0);
    publish('measure_power', watts());
    publish('evcharger_charging', watts() > 0);
    publish('evcharger_charging_state', watts() > 0 ? 'plugged_in_charging' : 'plugged_in_paused');
    const base = phaseBaseW ?? [backgroundW / 3, backgroundW / 3, backgroundW / 3];
    publishOn(meter, 'measure_power', backgroundW + watts());
    for (const [index, name] of ['l1', 'l2', 'l3'].entries()) {
      publishOn(meter, `measure_power.${name}`, (base[index] ?? 0) + (index === 0 || phases === 3 ? phaseW : 0));
    }
  };
  await charger.setCapabilityValue('peblar_charge_limit', currentA);
  await charger.setCapabilityValue('peblar_force_1_phase', forceSingle);
  await charger.setCapabilityValue('peblar_phase_mode', '3F');
  for (const phase of [1, 2, 3]) await charger.setCapabilityValue(`peblar_voltage_l${phase}`, 230);
  await charger.setCapabilityValue('meter_power.charged', 10);
  poll();
  setInterval(poll, 10_000);
  setMockDrivers({ chargers: new MockDriver('chargers', [charger]), meters: new MockDriver('meters', [meter]) });
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  const put = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    const value: unknown = body && typeof body === 'object' && 'value' in body ? body.value : undefined;
    if (path === pathFor('evcharger_charging') && value === false) {
      const recent = pauses.filter((at) => at >= Date.now() - 600_000);
      if (recent.length >= 3) throw new Error('Pausing charging is limited to three times per ten minutes.');
      pauses.push(Date.now());
    }
    await originalPut(path, body);
    if (path === pathFor('peblar_charge_limit') && typeof value === 'number') {
      currentA = value;
      currentWrites.push(value);
    }
    if (path === pathFor('evcharger_charging') && typeof value === 'boolean') currentA = value ? 16 : 0;
    if (path === pathFor('peblar_force_1_phase') && typeof value === 'boolean') {
      phaseRequests.push({ atMs: Date.now(), forceSingle: value });
      if (!ignoreSwitches) {
        forceSingle = value;
        transitionActive = true;
        const requested = value;
        setTimeout(() => { phases = requested ? 1 : 3; transitionActive = false; }, transitionDelayMs);
      }
    }
  });
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      if (!meterAvailable) throw new Error('Meter unavailable');
      return { items: [{ type: 'cumulative', id: 'meter-phases', values: { W: backgroundW + watts() } }] };
    }
    if (path === 'manager/flow/flow/' || path === 'manager/flow/advancedflow/') return {};
    return originalGet(path);
  });
  return {
    charger, put, phaseRequests, currentWrites, pauses,
    phases: () => phases, currentA: () => currentA, watts,
    setSolar: (availableW: number) => { backgroundW = -availableW; },
    setTransitionDelay: (delayMs: number) => { transitionDelayMs = delayMs; },
    idleWhileSwitching: () => { idleDuringTransition = true; },
    setPhaseBackground: (wattsByPhase: readonly [number, number, number]) => { phaseBaseW = wattsByPhase; },
    ignoreSwitches: () => { ignoreSwitches = true; },
    suspendMeter: () => { meterAvailable = false; },
  };
}

function configure(mode: 'automatic' | 'single' | 'three' = 'automatic'): void {
  const settings = mockHomeyInstance.settings;
  settings.set('power_source', 'homey_energy');
  settings.set('homey_energy_meter_device_id', 'meter-phases');
  settings.set(CAPACITY_LIMIT_KW, 20);
  settings.set(CAPACITY_MARGIN_KW, 0);
  settings.set(CAPACITY_DRY_RUN, false);
  settings.set(OPERATING_MODE_SETTING, 'Home');
  settings.set(MANAGED_DEVICES, { [ID]: true });
  settings.set(CONTROLLABLE_DEVICES, { [ID]: true });
  settings.set(NATIVE_EV_WIRING_DEVICES, { [ID]: true });
  settings.set(DEVICE_POWER_CONTROL_MODES, { [ID]: 'automatic' });
  settings.set(DEVICE_TARGET_POWER_CONFIGS, { [ID]: { enabled: true, preset: 'ev_charger_3_phase' } });
  settings.set(DEVICE_PHASE_CONNECTIONS, { [ID]: 'three_L1' });
  settings.set(CHARGING_PHASE_SETTINGS_KEY, { [ID]: { mode, installationConfirmed: true } });
  settings.set('overshoot_behaviors', { [ID]: { action: 'turn_off' } });
  settings.set('price_optimization_settings', { [ID]: {
    enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusWilling: true, surplusDelta: 0,
  } });
  seedStoredPowerTrackerForTests({ exportBuckets: { '2026-11-12T11:00:00.000Z': 4 } });
}

async function chargerRead() {
  const { devices } = await api.ui_devices({ homey: mockHomeyInstance as never });
  const device = devices.find((entry) => entry.id === ID);
  if (!device) throw new Error('Peblar missing from /ui_devices');
  return device;
}

async function advance(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 10_000) await vi.advanceTimersByTimeAsync(Math.min(10_000, ms - elapsed));
}

describe('Peblar physical phase control at the SDK boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate',
      'clearTimeout', 'clearInterval', 'clearImmediate'] });
    vi.setSystemTime(Date.UTC(2026, 10, 13, 10, 2));
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

  it('uses one phase for small solar and three phases for sustained larger surplus, without a Flow key', async () => {
    const model = await modelPeblar();
    configure();
    await createApp().onInit();
    for (let cycle = 0; cycle < 90 && model.phases() !== 1; cycle += 1) await advance(10_000);
    await advance(60_000);
    expect(model.phaseRequests.some((request) => request.forceSingle)).toBe(true);
    expect(model.phases()).toBe(1);
    expect(model.currentA()).toBeGreaterThanOrEqual(6);
    expect(model.watts()).toBeLessThanOrEqual(2500);
    model.setSolar(10_000);
    await advance(900_000);
    expect(model.phaseRequests.some((request) => !request.forceSingle)).toBe(true);
    expect(model.phases()).toBe(3);
    expect(model.watts()).toBeGreaterThan(3680);
  });

  it('keeps the observed ladder on three phases until independent power confirms the transition', async () => {
    const model = await modelPeblar();
    model.setTransitionDelay(60_000);
    configure('single');
    await createApp().onInit();
    for (let i = 0; i < 60 && model.phaseRequests.length === 0; i += 1) await advance(10_000);
    expect(model.phaseRequests).toHaveLength(1);
    expect(model.phases()).toBe(3);
    expect((await chargerRead()).automaticPowerControl?.profile.steps.find((step) => step.id === '6a')?.planningPowerW)
      .toBe(4140);
    await advance(70_000);
    expect(model.phases()).toBe(1);
    expect((await chargerRead()).automaticPowerControl?.profile.steps.find((step) => step.id === '6a')?.planningPowerW)
      .toBe(1380);
  });

  it('locks an ignored phase request for this connection instead of repeating it', async () => {
    const model = await modelPeblar();
    model.ignoreSwitches();
    configure('single');
    await createApp().onInit();
    await advance(900_000);
    expect(model.phaseRequests.filter((request) => request.forceSingle)).toHaveLength(1);
    expect(model.phases()).toBe(3);
    const state = (await chargerRead()).chargingPhaseControl;
    expect(state?.kind === 'supported' && state.status.kind).toBe('failed');
  });

  it('keeps the phase transition pending through the firmware idle dip without issuing a generic resume', async () => {
    const model = await modelPeblar();
    model.setTransitionDelay(60_000);
    model.idleWhileSwitching();
    configure('single');
    await createApp().onInit();
    for (let i = 0; i < 60 && model.phaseRequests.length === 0; i += 1) await advance(10_000);
    expect(model.phaseRequests).toHaveLength(1);
    await advance(20_000);
    expect(model.watts()).toBe(0);
    expect(model.currentA()).toBe(6);
    expect(model.phaseRequests).toHaveLength(1);
    expect(model.put.mock.calls.some(([path, body]) => path === pathFor('evcharger_charging')
      && typeof body === 'object' && body !== null && 'value' in body && body.value === true)).toBe(false);
    await advance(70_000);
    expect(model.phases()).toBe(1);
    expect(model.watts()).toBeGreaterThan(0);
  });

  it('retains one-phase charging when a three-phase expansion would overload another house phase', async () => {
    const model = await modelPeblar();
    configure();
    await createApp().onInit();
    await advance(360_000);
    expect(model.phases()).toBe(1);
    model.setSolar(5000);
    model.setPhaseBackground([-4750, 4500, -4750]);
    const settings = mockHomeyInstance.settings;
    settings.set(MAIN_FUSE_SUPPLY, 'three_phase_neutral');
    settings.set(MAIN_FUSE_AMPS, 25);
    settings.set(MAIN_FUSE_PHASE_METER_DEVICE_ID, 'meter-phases');
    settings.set(MAIN_FUSE_PHASE_CAPABILITIES, {
      facet: 'power', L1: 'measure_power.l1', L2: 'measure_power.l2', L3: 'measure_power.l3',
    });
    const before = model.phaseRequests.length;
    await advance(900_000);
    expect(model.phases()).toBe(1);
    expect(model.phaseRequests.slice(before).some((request) => !request.forceSingle)).toBe(false);
    expect(model.watts()).toBeGreaterThan(0);
  });

  it('does not decide or issue another phase command from a device event without a new meter sample', async () => {
    const model = await modelPeblar();
    configure('single');
    await createApp().onInit();
    await advance(180_000);
    model.suspendMeter();
    await drainPending();
    const before = model.put.mock.calls.length;
    model.charger.setActualCapabilityValue('peblar_power_l1', model.watts() + 5);
    await drainPending();
    expect(model.put.mock.calls).toHaveLength(before);
  });

  it.each(['unmanaged', 'simulation'] as const)('hands back the original phase setting safely when %s', async (change) => {
    const model = await modelPeblar();
    configure('single');
    await createApp().onInit();
    await advance(300_000);
    expect(model.phases()).toBe(1);
    if (change === 'unmanaged') mockHomeyInstance.settings.set(MANAGED_DEVICES, { [ID]: false });
    else mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, true);
    await advance(120_000);
    expect(model.phaseRequests.some((request) => !request.forceSingle)).toBe(true);
    expect(model.currentA()).toBe(0);
  });

  it('recovers a durable claim after restart by handing back before another switch', async () => {
    const model = await modelPeblar();
    configure('single');
    await createApp().onInit();
    await advance(300_000);
    expect(model.phases()).toBe(1);
    const before = model.phaseRequests.length;
    await cleanupApps();
    await createApp().onInit();
    await advance(60_000);
    expect(model.currentA()).toBe(0);
    // The pause's current-limit report arrives on the next poll. Expansion waits
    // for that accepted zero and the phase owner's one-minute retry window.
    await advance(70_000);
    expect(model.phaseRequests.slice(before)[0]?.forceSingle).toBe(false);
    expect(model.currentA()).toBe(0);
  });
});
