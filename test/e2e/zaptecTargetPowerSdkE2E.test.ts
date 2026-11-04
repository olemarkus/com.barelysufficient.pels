import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CONTROLLABLE_DEVICES,
  DEVICE_TARGET_POWER_CONFIGS, DEVICE_TARGET_POWER_REACHABILITY, MANAGED_DEVICES, OPERATING_MODE_SETTING,
  DEVICE_POWER_CONTROL_MODES, RESPECT_EXTERNAL_OFF_DEVICES,
} from '../../lib/utils/settingsKeys';
import { buildZaptecCurrentOnlyDevice, buildZaptecTargetPowerDevice } from '../helpers/zaptecDeviceFixture';
import { connectLiveFeed, emitDeviceUpdate } from '../helpers/liveFeedSocketHarness';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainPending, drainUntil } from '../utils/asyncDrain';

const ID = 'zaptec-target-power';
const GRID_WATTS_PER_AMP = Math.sqrt(3) * 230;
const BACKGROUND_W = 1000;
const HOUSE_LIMIT_W = 7000;
const pathFor = (capability: string) => `manager/devices/device/${ID}/capability/${capability}`;

// Reclaim can wait for the previous restore cooldown before pausing, then a new cooldown before resuming.
async function advanceMeterDecisionsUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 45 && !predicate(); attempt += 1) {
    await vi.advanceTimersByTimeAsync(30_000);
  }
  expect(predicate(), 'charger should converge through preparation and normal restore cooldowns').toBe(true);
}

async function buildCharger(source = buildZaptecTargetPowerDevice()): Promise<MockDevice> {
  const charger = new MockDevice(ID, 'Zaptec Go 2', source.capabilities ?? [], 'evcharger');
  charger.setDriverIdentity({ ownerUri: source.ownerUri, driverId: source.driverId });
  for (const [id, capability] of Object.entries(source.capabilitiesObj ?? {})) {
    if (!capability) continue;
    charger.setCapabilityMetadata(id, {
      units: capability.units, min: capability.min, max: capability.max, step: capability.step,
      excludeMin: capability.excludeMin, excludeMax: capability.excludeMax, setable: capability.setable,
    });
    await charger.setCapabilityValue(id, capability.value);
  }
  await charger.setCapabilityValue('available_installation_current', 32);
  if (source.capabilities?.includes('target_power')) {
    await charger.setCapabilityValue('target_power', Math.floor(32 * GRID_WATTS_PER_AMP));
    await charger.setCapabilityValue('target_power_mode', 'homey');
    await charger.setCapabilityValue('evcharger_charging', true);
    await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in_charging');
  } else {
    await charger.setCapabilityValue('charging_button', true);
    await charger.setCapabilityValue('charge_mode', 'Charging');
  }
  await charger.setCapabilityValue('measure_power', 32 * GRID_WATTS_PER_AMP);
  setMockDrivers({ chargers: new MockDriver('chargers', [charger]) });
  return charger;
}

function simulateZaptec(charger: MockDevice) {
  let limitA = 32;
  let wattsPerAmp = GRID_WATTS_PER_AMP;
  let maximumA = 32;
  let targetW = Math.floor(limitA * GRID_WATTS_PER_AMP);
  let mode = 'homey';
  let charging = true;
  let targetCurrentA: number | undefined = 32;
  let currentBeforeHomey: number | undefined;
  const resetHousePowers: number[] = [];
  const drawW = () => charging ? limitA * wattsPerAmp : 0;
  const applyTargetPower = () => {
    const amps = Math.min(maximumA, Math.floor(targetW / wattsPerAmp));
    if (amps < 6) { charging = false; return; }
    // Zaptec 1.12 caches this independently of legacy installation writes.
    if (amps === targetCurrentA) return;
    currentBeforeHomey ??= limitA;
    limitA = amps;
    targetCurrentA = amps;
  };
  const report = (capability: string, value: unknown) => {
    charger.setActualCapabilityValue(capability, value, { emitDeviceUpdate: false });
  };
  const publish = () => {
    report('target_power', targetW);
    report('target_power_mode', mode);
    report('available_installation_current', limitA);
    report('evcharger_charging', charging);
    report('evcharger_charging_state', charging ? 'plugged_in_charging' : 'plugged_in_paused');
    report('measure_power', drawW());
  };
  setInterval(publish, 30_000);
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  const put = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    await originalPut(path, body);
    const value = body && typeof body === 'object' && 'value' in body ? body.value : undefined;
    if (path === pathFor('target_power') && typeof value === 'number') targetW = value;
    if (path === pathFor('target_power_mode') && typeof value === 'string') {
      mode = value;
      if (mode === 'device') {
        targetCurrentA = undefined;
        limitA = currentBeforeHomey ?? limitA;
        currentBeforeHomey = undefined;
        resetHousePowers.push(BACKGROUND_W + drawW());
      }
    }
    if ((path === pathFor('target_power') || path === pathFor('target_power_mode')) && mode === 'homey') {
      applyTargetPower();
    }
    if (path === pathFor('evcharger_charging') && typeof value === 'boolean') charging = value;
    // As in the vendor app, the cloud current changes before its next poll
    // publishes independent installation-current and power observations.
  });
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  const get = vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') return {
      items: [{ type: 'cumulative', id: 'meter-main', values: { W: BACKGROUND_W + drawW() } }],
    };
    if (path === 'manager/flow/flow/' || path === 'manager/flow/advancedflow/') return {};
    // MockDevice supplies the SDK capabilities. The installation id is the
    // vendor's data, needed to expose the legacy installation-current route.
    const data = { id: ID, installationId: 'zaptec-installation' };
    if (path === 'manager/devices/device') return { [ID]: { ...charger.toHomeyApiDevice(), data } };
    if (path === `manager/devices/device/${ID}`) return { ...charger.toHomeyApiDevice(), data };
    return originalGet(path);
  });
  return {
    get, put, resetHousePowers,
    setManualCurrent: (amps: number) => { limitA = amps; publish(); },
    setInstallation: (nextWattsPerAmp: number, maxCurrentA: number) => {
      wattsPerAmp = nextWattsPerAmp;
      maximumA = maxCurrentA;
      limitA = Math.min(limitA, maximumA);
      charger.setCapabilityMetadata('target_power', { min: 0, max: Math.floor(maximumA * wattsPerAmp),
        step: 230, excludeMin: 0, excludeMax: Math.ceil(6 * wattsPerAmp), setable: true, units: 'W' });
      publish();
      emitDeviceUpdate({ ...charger.toHomeyApiDevice(), data: { id: ID, installationId: 'zaptec-installation' } });
    },
    housePowerW: () => BACKGROUND_W + drawW(),
    powerWrites: () => put.mock.calls.filter(([path]) => path === pathFor('target_power'))
      .map(([, body]) => (body as { value: number }).value),
  };
}

/** The 1.10.4 app action changes cloud current; its poll reports the new limit. */
function simulateCurrentOnlyZaptec(charger: MockDevice) {
  let limitA = 32;
  let charging = true;
  const currentActions: Array<{ current1: number; current2: number; current3: number }> = [];
  const report = (capability: string, value: unknown) => {
    charger.setActualCapabilityValue(capability, value, { emitDeviceUpdate: false });
  };
  setInterval(() => {
    report('available_installation_current', limitA);
    report('charging_button', charging);
    report('charge_mode', charging ? 'Charging' : 'Connecting to car');
    report('measure_power', charging ? limitA * GRID_WATTS_PER_AMP : 0);
  }, 30_000);
  const responseHeaders: Record<string, string> = {
    'content-type': 'application/json', 'x-homey-id': 'mock-homey-id',
  };
  const response = (body: unknown) => ({
    ok: true, status: 200,
    headers: { get: (name: string) => responseHeaders[name.toLowerCase()] ?? null },
    json: async () => body,
  });
  const fetch = vi.fn(async (_url: unknown, options?: { method?: string; body?: string }) => {
    if (options?.method === 'POST') {
      const { args } = JSON.parse(options.body ?? '{}') as {
        args: { current1: number; current2: number; current3: number };
      };
      currentActions.push(args);
      limitA = args.current1;
      return response({ error: null });
    }
    return response({ intersectedScopes: ['homey.flow'] });
  });
  vi.stubGlobal('fetch', fetch);
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  const put = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    await originalPut(path, body);
    if (path === pathFor('charging_button') && body && typeof body === 'object' && 'value' in body) {
      charging = body.value === true;
    }
  });
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  const get = vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') return {
      items: [{ type: 'cumulative', id: 'meter-main', values: {
        W: BACKGROUND_W + (charging ? limitA * GRID_WATTS_PER_AMP : 0),
      } }],
    };
    if (path === 'manager/flow/flow/' || path === 'manager/flow/advancedflow/') return {};
    if (path === 'manager/flow/flowcardaction') return [{ id: 'homey:app:com.zaptec:go2_installation_current_control' }];
    const data = { id: ID, installationId: 'zaptec-installation' };
    if (path === 'manager/devices/device') return { [ID]: { ...charger.toHomeyApiDevice(), data } };
    if (path === `manager/devices/device/${ID}`) return { ...charger.toHomeyApiDevice(), data };
    return originalGet(path);
  });
  return { currentActions, fetch, get, put };
}

describe('Zaptec legacy current and native watt control at the SDK boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [
      'Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate',
      'clearTimeout', 'clearInterval', 'clearImmediate',
    ] });
    vi.setSystemTime(Date.UTC(2026, 10, 4, 8, 2));
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

  it('keeps the shipped current-only charger on its installation-current action despite an Automatic preference', async () => {
    const charger = await buildCharger(buildZaptecCurrentOnlyDevice());
    const simulation = simulateCurrentOnlyZaptec(charger);
    const savedConfig = { [ID]: { enabled: true, preset: 'ev_charger_3_phase', max: 22080 } };
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, HOUSE_LIMIT_W / 1000);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
    mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { [ID]: true });
    mockHomeyInstance.settings.set(MANAGED_DEVICES, { [ID]: true });
    mockHomeyInstance.settings.set('overshoot_behaviors', { [ID]: { action: 'set_step' } });
    mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_CONFIGS, structuredClone(savedConfig));
    mockHomeyInstance.settings.set(DEVICE_POWER_CONTROL_MODES, { [ID]: 'automatic' });
    mockHomeyInstance.settings.set('charging_current_control', {
      [ID]: { method: 'built_in', confirmation: 'single_charger' },
    });
    mockHomeyInstance.settings.set('_homey_flow_api_key', 'test-key');

    await createApp().onInit();
    const initial = await api.ui_devices({ homey: mockHomeyInstance as never });
    const device = initial.devices.find((entry) => entry.id === ID);
    expect(device?.automaticPowerControl).toBeUndefined();
    expect(device?.targetPowerConfig?.preset).toBe('ev_charger_3_phase');
    await vi.advanceTimersByTimeAsync(125_000);
    await drainUntil(() => simulation.currentActions.length > 0);
    expect(simulation.get).toHaveBeenCalledWith('manager/flow/flowcardaction');
    for (const command of simulation.currentActions) {
      expect(command.current1).toBeGreaterThanOrEqual(6);
      expect(command.current1).toBeLessThanOrEqual(32);
      expect(command.current2).toBe(command.current1);
      expect(command.current3).toBe(command.current1);
    }
    expect(simulation.fetch.mock.calls.some(([url, options]) => (
      String(url).includes(encodeURIComponent('homey:app:com.zaptec:go2_installation_current_control'))
      && options?.method === 'POST'
    ))).toBe(true);
    expect(simulation.put).not.toHaveBeenCalledWith(pathFor('target_power'), expect.anything());
    expect(simulation.put).not.toHaveBeenCalledWith(pathFor('target_power_mode'), expect.anything());
    expect(simulation.put).not.toHaveBeenCalledWith(pathFor('available_installation_current'), expect.anything());
    expect(mockHomeyInstance.settings.get(DEVICE_TARGET_POWER_CONFIGS)).toEqual(savedConfig);
    expect(mockHomeyInstance.settings.get(DEVICE_POWER_CONTROL_MODES)).toEqual({ [ID]: 'automatic' });
  });

  it.each(['flow', 'built_in'] as const)('limits IT charging in watts with legacy %s current control selected', async (method) => {
    const charger = await buildCharger();
    const simulation = simulateZaptec(charger);
    const savedConfig = { [ID]: { enabled: true, preset: 'ev_charger_3_phase', max: 22080 } };
    const savedCurrentControl = { [ID]: { method, confirmation: 'single_charger' } };
    const savedReachability = { [ID]: {
      profileFingerprint: 'ev_charger_3_phase:off=0,6a=4140,8a=5520,10a=6900,12a=8280,14a=9660,16a=11040,20a=13800,24a=16560,28a=19320,32a=22080',
      maxReachedPowerW: 22080, probeFailureCount: 0,
    } };
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, HOUSE_LIMIT_W / 1000);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
    mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { [ID]: true });
    mockHomeyInstance.settings.set(MANAGED_DEVICES, { [ID]: true });
    mockHomeyInstance.settings.set('overshoot_behaviors', { [ID]: { action: 'set_step' } });
    mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_CONFIGS, structuredClone(savedConfig));
    mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_REACHABILITY, structuredClone(savedReachability));
    mockHomeyInstance.settings.set('charging_current_control', structuredClone(savedCurrentControl));
    mockHomeyInstance.settings.set(RESPECT_EXTERNAL_OFF_DEVICES, { [ID]: true });
    mockHomeyInstance.settings.set(DEVICE_POWER_CONTROL_MODES, { [ID]: 'automatic' });

    await createApp().onInit();
    const initial = await api.ui_devices({ homey: mockHomeyInstance as never });
    expect(initial.devices.find((entry) => entry.id === ID)).toMatchObject({
      controlModel: 'stepped_load',
      available: true,
      managed: true,
    });
    await vi.advanceTimersByTimeAsync(125_000);
    await advanceMeterDecisionsUntil(() => simulation.powerWrites().some((watts) => watts > 0)
      && simulation.housePowerW() > BACKGROUND_W);
    await drainPending();
    // Zaptec floors watt limits to whole amps. The measured house draw is the
    // budget authority; a watt target can sit above that draw by less than 1 A.
    for (const watts of simulation.powerWrites().filter((value) => value > 0)) {
      expect(watts % 230).toBe(0);
      expect(watts).toBeLessThan(HOUSE_LIMIT_W - BACKGROUND_W + GRID_WATTS_PER_AMP);
    }
    expect(simulation.housePowerW()).toBeLessThanOrEqual(HOUSE_LIMIT_W);
    expect(simulation.housePowerW()).toBeGreaterThan(BACKGROUND_W);
    expect(simulation.put).not.toHaveBeenCalledWith(pathFor('available_installation_current'), expect.anything());
    expect(simulation.get).not.toHaveBeenCalledWith('manager/flow/flowcardaction');

    const response = await api.ui_devices({ homey: mockHomeyInstance as never });
    const device = response.devices.find((entry) => entry.id === ID);
    expect(device?.targetPowerConfig).toBeUndefined();
    expect(device?.reportedStepId).toMatch(/^\d+w$/u);
    expect(device?.steppedLoadProfile?.steps.at(-1)).toEqual({ id: '12650w', planningPowerW: 12650 });
    expect(device?.steppedLoadProfile?.steps.every((step) => step.planningCurrentA === undefined)).toBe(true);
    expect(mockHomeyInstance.settings.get(DEVICE_TARGET_POWER_CONFIGS)).toEqual(savedConfig);
    expect(mockHomeyInstance.settings.get(DEVICE_TARGET_POWER_REACHABILITY)).toEqual(savedReachability);
    expect(mockHomeyInstance.settings.get('charging_current_control')).toEqual(savedCurrentControl);

    if (method === 'flow') {
      const retainedWatts = Number(charger.getActualCapabilityValue('target_power'));
      mockHomeyInstance.settings.set(DEVICE_POWER_CONTROL_MODES, { [ID]: 'manual' });
      await vi.advanceTimersByTimeAsync(31_000);
      simulation.setManualCurrent(20);
      await vi.advanceTimersByTimeAsync(1_000);
      const manual = await api.ui_devices({ homey: mockHomeyInstance as never });
      expect(manual.devices.find((entry) => entry.id === ID)?.automaticPowerControl?.mode).toBe('manual');
      expect(Number(charger.getActualCapabilityValue('target_power'))).toBe(retainedWatts);
      const previousWrites = simulation.powerWrites().length;
      mockHomeyInstance.settings.set(DEVICE_POWER_CONTROL_MODES, { [ID]: 'automatic' });
      await vi.advanceTimersByTimeAsync(125_000);
      await advanceMeterDecisionsUntil(() => simulation.powerWrites().length > previousWrites
        && simulation.housePowerW() > BACKGROUND_W);
      expect(simulation.housePowerW()).toBeLessThanOrEqual(HOUSE_LIMIT_W);
      expect(simulation.housePowerW()).toBeGreaterThan(BACKGROUND_W);
      expect(simulation.resetHousePowers.length).toBeGreaterThan(0);
      expect(simulation.resetHousePowers.every((watts) => watts === BACKGROUND_W)).toBe(true);
      expect(mockHomeyInstance.settings.get(DEVICE_TARGET_POWER_CONFIGS)).toEqual(savedConfig);
    }
  });

  it.each([
    { change: 'lower IT installation maximum', wattsPerAmp: GRID_WATTS_PER_AMP, maximumA: 10,
      firstW: 2530, lastW: 3910 },
    { change: 'single-phase supply', wattsPerAmp: 230, maximumA: 32, firstW: 1380, lastW: 7360 },
  ])('updates the same Automatic charger after a $change on the next meter decision', async (change) => {
    const charger = await buildCharger();
    const simulation = simulateZaptec(charger);
    const savedConfig = { [ID]: { enabled: true, preset: 'ev_charger_3_phase', max: 22080 } };
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, HOUSE_LIMIT_W / 1000);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
    mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { [ID]: true });
    mockHomeyInstance.settings.set(MANAGED_DEVICES, { [ID]: true });
    mockHomeyInstance.settings.set('overshoot_behaviors', { [ID]: { action: 'set_step' } });
    mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_CONFIGS, structuredClone(savedConfig));
    mockHomeyInstance.settings.set(DEVICE_POWER_CONTROL_MODES, { [ID]: 'automatic' });
    await createApp().onInit();
    await vi.advanceTimersByTimeAsync(125_000);
    await advanceMeterDecisionsUntil(() => simulation.powerWrites().some((watts) => watts > 0)
      && simulation.housePowerW() > BACKGROUND_W);
    await drainPending();
    const previousWrites = simulation.powerWrites().length;
    expect(previousWrites).toBeGreaterThan(0);

    simulation.setInstallation(change.wattsPerAmp, change.maximumA);
    await drainPending();
    expect(simulation.powerWrites()).toHaveLength(previousWrites);
    const changed = await api.ui_devices({ homey: mockHomeyInstance as never });
    const device = changed.devices.find((entry) => entry.id === ID);
    expect(device?.automaticPowerControl?.mode).toBe('automatic');
    expect(device?.steppedLoadProfile?.steps[1]).toEqual({
      id: `${change.firstW}w`, planningPowerW: change.firstW,
    });
    expect(device?.steppedLoadProfile?.steps.at(-1)).toEqual({
      id: `${change.lastW}w`, planningPowerW: change.lastW,
    });
    expect(device?.reportedStepId).toBeUndefined();

    await vi.advanceTimersByTimeAsync(125_000);
    await advanceMeterDecisionsUntil(() => simulation.powerWrites().length > previousWrites
      && simulation.housePowerW() > BACKGROUND_W);
    for (const watts of simulation.powerWrites().slice(previousWrites).filter((value) => value > 0)) {
      expect(watts % 230).toBe(0);
      expect(watts).toBeGreaterThanOrEqual(change.firstW);
      expect(watts).toBeLessThanOrEqual(change.lastW);
    }
    expect(simulation.housePowerW()).toBeLessThanOrEqual(HOUSE_LIMIT_W);
    expect(mockHomeyInstance.settings.get(DEVICE_TARGET_POWER_CONFIGS)).toEqual(savedConfig);
    expect(mockHomeyInstance.settings.get(DEVICE_POWER_CONTROL_MODES)).toEqual({ [ID]: 'automatic' });
  });
});
