import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import { createHomesStore } from '../../lib/home/homeRegistryStore';
import {
  CAPACITY_DRY_RUN, CAPACITY_ENABLED, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW,
  CAPACITY_PRIORITIES, CONTROLLABLE_DEVICES, DAILY_BUDGET_ENABLED, DAILY_BUDGET_KWH, DEVICE_POWER_CONTROL_MODES,
  EV_CAR_ASSOCIATIONS, EV_CAR_CURRENT_LIMITS, EV_CHARGER_CURRENT_LIMITS, EXTERNAL_OFF_HOLDS, GRID_IMPORT_ENABLED, GRID_IMPORT_LIMIT_KW,
  MANAGED_DEVICES, NATIVE_EV_WIRING_DEVICES, OPERATING_MODE_SETTING, OVERSHOOT_BEHAVIORS,
  RESPECT_EXTERNAL_OFF_DEVICES, homeScopedSettingsKey,
} from '../../lib/utils/settingsKeys';
import { connectLiveFeed } from '../helpers/liveFeedSocketHarness';
import { seedHourlyFlowPricesForTests } from '../helpers/smartTaskPriceSourceFixture';
import { buildZaptecTargetPowerDevice } from '../helpers/zaptecDeviceFixture';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers, setMockZones } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainPending } from '../utils/asyncDrain';
import { groupModePriorityDeviceIds } from '../../packages/shared-domain/src/modePriorities';

const PRIMARY = 'charger-b';
const SECONDARY = 'charger-a';
const MEMBERS = [PRIMARY, SECONDARY] as const;
const ANNEX = { homeId: 'annex', name: 'Annex', rootZoneId: 'annex-zone', meterDeviceId: 'meter-annex' };
const WATTS_PER_AMP = 230;
const MINIMUM_W = 6 * WATTS_PER_AMP;
const INITIAL_W = 32 * WATTS_PER_AMP;
const NOW_MS = Date.UTC(2026, 0, 1, 17, 5);
const homey = () => mockHomeyInstance as never;

type MemberId = typeof MEMBERS[number];
type MemberSetup = 'charging' | 'finished' | 'held' | 'unplugged' | 'waiting';
type Setup = {
  primary?: MemberSetup;
  secondary?: MemberSetup;
  mixed?: 'unmanaged' | 'power limit off' | 'missing charger id';
  additionalDevices?: MockDevice[];
  dailyBudget?: boolean;
  noLadder?: boolean;
  primaryMode?: 'device' | 'homey';
  splitMeterArea?: boolean;
  unreadableInstallationCurrent?: boolean;
};

function buildMember(id: MemberId) {
  const fixture = buildZaptecTargetPowerDevice();
  const member = new MockDevice(id, id, [...fixture.capabilities, 'measure_battery'], 'evcharger');
  member.setDriverIdentity({ ownerUri: fixture.ownerUri, driverId: fixture.driverId });
  for (const [capabilityId, metadata] of Object.entries(fixture.capabilitiesObj)) {
    if (metadata === undefined) continue;
    member.setCapabilityMetadata(capabilityId, metadata);
    member.setActualCapabilityValue(capabilityId, metadata.value);
  }
  member.setCapabilityMetadata('target_power', { max: INITIAL_W, excludeMin: 0, excludeMax: MINIMUM_W, min: 0, step: 230, setable: true });
  member.setActualCapabilityValue('measure_battery', 40);
  return member;
}

type CapabilityWrite = { id: MemberId; capability: string; value: unknown };

function simulateInstallation(setup: Setup) {
  let availableW = INITIAL_W;
  let backgroundW = 600;
  let annexBackgroundW = 600;
  let meterOnline = true;
  const members = { [PRIMARY]: buildMember(PRIMARY), [SECONDARY]: buildMember(SECONDARY) };
  if (setup.noLadder) {
    members[PRIMARY].removeCapability('target_power');
    members[PRIMARY].removeCapability('target_power_mode');
  }
  if (setup.splitMeterArea) {
    members[PRIMARY].setZone('home-zone');
    members[SECONDARY].setZone(ANNEX.rootZoneId);
  }
  const initial = { [PRIMARY]: setup.primary ?? 'charging', [SECONDARY]: setup.secondary ?? 'charging' };
  const charging = { [PRIMARY]: initial[PRIMARY] === 'charging', [SECONDARY]: initial[SECONDARY] === 'charging' };
  const defaultPrimaryMode = setup.mixed || setup.splitMeterArea ? 'device' : 'homey';
  const mode = { [PRIMARY]: setup.primaryMode ?? defaultPrimaryMode, [SECONDARY]: 'device' };
  if (setup.primaryMode === 'device') {
    // The write is accepted but the device only publishes its changed
    // retained watt target on the next report.
    members[PRIMARY].configureCapabilityBehavior('target_power', {
      onApiWrite: { updateActual: false, updateApi: false, emitCapabilityEvent: false, emitDeviceUpdate: false },
    });
  }
  const targetW = { [PRIMARY]: setup.unreadableInstallationCurrent ? 0 : INITIAL_W, [SECONDARY]: INITIAL_W };

  // A local pause frees that car's share for its sibling. The first session
  // gets the available current when there is too little for both.
  const drawW = (id: MemberId): number => {
    if (!charging[id]) return 0;
    if (!MEMBERS.every((memberId) => charging[memberId])) return availableW;
    if (availableW >= 2 * MINIMUM_W) return availableW / 2;
    return id === PRIMARY ? availableW : 0;
  };
  const report = (id: MemberId, capability: string, value: unknown) => {
    if (members[id].getActualCapabilityValue(capability) === value) return;
    members[id].setActualCapabilityValue(capability, value, { emitDeviceUpdate: false });
  };
  const publish = () => {
    for (const id of MEMBERS) {
      report(id, 'target_power_mode', mode[id]);
      report(id, 'target_power', targetW[id]);
      report(id, 'available_installation_current',
        id === PRIMARY && setup.unreadableInstallationCurrent ? undefined : availableW / WATTS_PER_AMP);
      report(id, 'evcharger_charging', charging[id]);
      let plugState = charging[id] ? 'plugged_in_charging' : 'plugged_in_paused';
      if (initial[id] === 'finished') plugState = 'plugged_in_finished';
      if (initial[id] === 'unplugged') plugState = 'plugged_out';
      if (initial[id] === 'waiting') plugState = 'plugged_in';
      report(id, 'evcharger_charging_state', plugState);
      report(id, 'measure_power', drawW(id));
    }
  };
  publish();
  setInterval(publish, 10_000);

  const attempts: CapabilityWrite[] = [];
  const writes: CapabilityWrite[] = [];
  const modeClaimTargetReports: unknown[] = [];
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    const id = MEMBERS.find((memberId) => path.startsWith(`manager/devices/device/${memberId}/capability/`));
    if (!id) return originalPut(path, body);
    const capability = path.split('/').at(-1) ?? '';
    const value = body && typeof body === 'object' && 'value' in body ? body.value : undefined;
    const write = { id, capability, value };
    attempts.push(write);
    if (capability === 'target_power_mode' && value === 'homey') {
      modeClaimTargetReports.push(await members[id].getCapabilityValue('target_power'));
    }
    const result = await originalPut(path, body);
    writes.push(write);
    if (capability === 'evcharger_charging' && typeof value === 'boolean') charging[id] = value;
    if (capability === 'target_power_mode' && (value === 'device' || value === 'homey')) mode[id] = value;
    if (capability === 'target_power' && typeof value === 'number') targetW[id] = value;
    if (mode[id] === 'homey' && (capability === 'target_power_mode' || capability === 'target_power')) {
      if (targetW[id] === 0) charging[id] = false;
      else availableW = targetW[id];
    }
    if (capability === 'available_installation_current' && typeof value === 'number') availableW = value * WATTS_PER_AMP;
    return result;
  });
  const secondaryIntegrationId = setup.mixed === 'missing charger id' ? undefined : 'go-2';
  const devicePayload = (id: MemberId) => ({
    ...members[id].toHomeyApiDevice(),
    data: {
      id: id === PRIMARY ? 'go-1' : secondaryIntegrationId,
      installationId: 'go-installation',
    },
  });
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path) => {
    if (path === 'manager/energy/live') {
      const mainW = backgroundW + drawW(PRIMARY) + (setup.splitMeterArea ? 0 : drawW(SECONDARY));
      return {
        items: [
          ...(meterOnline ? [{ type: 'cumulative', id: 'meter-main', values: { W: mainW } }] : []),
          ...(setup.splitMeterArea
            ? [{ type: 'cumulative', id: ANNEX.meterDeviceId, values: { W: annexBackgroundW + drawW(SECONDARY) } }]
            : []),
        ],
      };
    }
    if (path === 'manager/flow/flow/' || path === 'manager/flow/advancedflow/') return {};
    if (path === 'manager/devices/device') return {
      ...Object.fromEntries((setup.additionalDevices ?? []).map((device) => [device.idValue, device.toHomeyApiDevice()])),
      [PRIMARY]: devicePayload(PRIMARY),
      [SECONDARY]: devicePayload(SECONDARY),
    };
    const memberId = MEMBERS.find((id) => path === `manager/devices/device/${id}`);
    return memberId ? devicePayload(memberId) : originalGet(path);
  });
  const devices = [...Object.values(members), ...(setup.additionalDevices ?? [])];
  setMockDrivers({ chargers: new MockDriver('chargers', devices) });
  return {
    members, writes, attempts, modeClaimTargetReports, drawW,
    setBackground: (watts: number) => { backgroundW = watts; },
    setAnnexBackground: (watts: number) => { annexBackgroundW = watts; },
    loseMeter: () => { meterOnline = false; },
    finishCharging: (id: MemberId) => {
      initial[id] = 'finished';
      charging[id] = false;
      publish();
    },
    pauses: () => writes.filter((write) => write.capability === 'evcharger_charging' && write.value === false),
    resumes: () => writes.filter((write) => write.capability === 'evcharger_charging' && write.value === true),
    wattWrites: () => writes.filter((write) => write.capability === 'target_power'),
    currentWrites: () => writes.filter((write) => write.capability === 'target_power'
      || write.capability === 'target_power_mode' || write.capability === 'available_installation_current'),
  };
}

async function boot(setup: Setup = {}) {
  const sim = simulateInstallation(setup);
  const settings = mockHomeyInstance.settings;
  settings.set('power_source', 'homey_energy');
  settings.set('homey_energy_meter_device_id', 'meter-main');
  settings.set(CAPACITY_ENABLED, false);
  settings.set(CAPACITY_LIMIT_KW, 20);
  settings.set(CAPACITY_MARGIN_KW, 0);
  settings.set(GRID_IMPORT_ENABLED, true);
  settings.set(GRID_IMPORT_LIMIT_KW, 10);
  settings.set(CAPACITY_DRY_RUN, false);
  settings.set(DAILY_BUDGET_ENABLED, setup.dailyBudget === true);
  if (setup.dailyBudget) settings.set(DAILY_BUDGET_KWH, 360);
  if (setup.splitMeterArea) {
    setMockZones({
      'home-zone': { id: 'home-zone', name: 'Home', parent: null },
      [ANNEX.rootZoneId]: { id: ANNEX.rootZoneId, name: ANNEX.name, parent: 'home-zone' },
    });
    createHomesStore(settings).write({ subHomes: [ANNEX] });
    settings.set(homeScopedSettingsKey(CAPACITY_ENABLED, ANNEX.homeId), false);
    settings.set(homeScopedSettingsKey(GRID_IMPORT_ENABLED, ANNEX.homeId), true);
    settings.set(homeScopedSettingsKey(GRID_IMPORT_LIMIT_KW, ANNEX.homeId), 10);
    settings.set(homeScopedSettingsKey(CAPACITY_DRY_RUN, ANNEX.homeId), false);
  }
  settings.set(OPERATING_MODE_SETTING, 'Home');
  const extraManaged = Object.fromEntries((setup.additionalDevices ?? [])
    .filter((device) => device.getDeviceClass() !== 'car')
    .map((device) => [device.idValue, true]));
  settings.set(MANAGED_DEVICES, { [PRIMARY]: true, [SECONDARY]: setup.mixed !== 'unmanaged', ...extraManaged });
  settings.set(CONTROLLABLE_DEVICES, { [PRIMARY]: true, [SECONDARY]: setup.mixed !== 'power limit off', ...extraManaged });
  settings.set(CAPACITY_PRIORITIES, { Home: { [PRIMARY]: 1, [SECONDARY]: 2 } });
  settings.set(DEVICE_POWER_CONTROL_MODES, { [PRIMARY]: 'automatic', [SECONDARY]: 'automatic' });
  settings.set(NATIVE_EV_WIRING_DEVICES, { [PRIMARY]: true, [SECONDARY]: true });
  settings.set(OVERSHOOT_BEHAVIORS, { [PRIMARY]: { action: 'turn_off' }, [SECONDARY]: { action: 'turn_off' } });
  settings.set('price_optimization_enabled', true);
  seedHourlyFlowPricesForTests(Date.UTC(2026, 0, 1), Array.from({ length: 24 }, (_, hour) => (hour === 17 ? 5 : 50)));
  const held = MEMBERS.filter((id) => (id === PRIMARY ? setup.primary : setup.secondary) === 'held');
  if (held.length > 0) {
    settings.set(RESPECT_EXTERNAL_OFF_DEVICES, Object.fromEntries(held.map((id) => [id, true])));
    settings.set(EXTERNAL_OFF_HOLDS, {
      version: 1,
      entriesByDeviceId: Object.fromEntries(held.map((id) => [id, {
        sinceMs: NOW_MS - 60_000, observedAtMs: NOW_MS - 60_000, capabilityId: 'evcharger_charging',
      }])),
    });
  }
  await createApp().onInit();
  return sim;
}

async function advance(seconds = 30) {
  await vi.advanceTimersByTimeAsync(seconds * 1000);
  await drainPending();
}

async function advanceUntil(predicate: () => boolean, expected: string, maxPolls = 24) {
  for (let poll = 0; poll < maxPolls && !predicate(); poll += 1) await advance();
  expect(predicate(), expected).toBe(true);
}

describe('shared Zaptec load through the Homey SDK', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [
      'Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate',
      'clearTimeout', 'clearInterval', 'clearImmediate',
    ] });
    vi.setSystemTime(NOW_MS);
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

  it('lowers the installation current before pausing the two active chargers', async () => {
    const sim = await boot();
    await advance(90);
    expect(sim.drawW(PRIMARY) + sim.drawW(SECONDARY)).toBe(INITIAL_W);
    const beforePressure = sim.wattWrites().length;
    sim.setBackground(5_000);
    await advanceUntil(
      () => sim.wattWrites().slice(beforePressure).some(({ value }) => Number(value) < INITIAL_W),
      'the primary should receive a lower watt target',
    );
    expect(sim.drawW(PRIMARY) + sim.drawW(SECONDARY)).toBeGreaterThanOrEqual(MINIMUM_W);
    expect(sim.pauses()).toEqual([]);
    expect(sim.wattWrites()).toContainEqual({ id: PRIMARY, capability: 'target_power', value: expect.any(Number) });
    expect(sim.currentWrites().every((write) => write.id === PRIMARY)).toBe(true);

    sim.setBackground(9_350);
    await advanceUntil(
      () => MEMBERS.every((id) => sim.pauses().some((write) => write.id === id)),
      'both members should pause when the lowest charging step no longer fits',
    );
    const lowestStep = sim.writes.findIndex((write) => write.id === PRIMARY
      && write.capability === 'target_power' && write.value === MINIMUM_W);
    const firstPause = sim.writes.findIndex((write) => write.capability === 'evcharger_charging' && write.value === false);
    expect(lowestStep).toBeGreaterThanOrEqual(0);
    expect(firstPause).toBeGreaterThan(lowestStep);
    expect(sim.currentWrites().every((write) => write.id === PRIMARY)).toBe(true);
  });

  it.each(['waiting', 'unplugged'] as const)('limits secondary draw while the primary is %s', async (primary) => {
    const sim = await boot({ primary });
    await advance(90);
    expect(sim.drawW(SECONDARY)).toBe(INITIAL_W);
    const beforePressure = sim.wattWrites().length;
    sim.setBackground(5_000);
    await advanceUntil(
      () => sim.wattWrites().slice(beforePressure).some(({ value }) => Number(value) < INITIAL_W),
      'the primary should receive a lower watt target',
    );
    expect(sim.drawW(PRIMARY)).toBe(0);
    expect(sim.drawW(SECONDARY)).toBeGreaterThanOrEqual(MINIMUM_W);
    expect(sim.wattWrites().some((write) => write.id === PRIMARY && Number(write.value) < INITIAL_W)).toBe(true);
    expect(sim.currentWrites().every((write) => write.id === PRIMARY)).toBe(true);
    expect(sim.pauses()).toEqual([]);
    expect(sim.resumes().every((write) => write.id !== PRIMARY)).toBe(true);
  });

  it.each([5_000, 9_350])('pauses at %i W of background load while the primary is unavailable', async (backgroundW) => {
    const sim = await boot({ primary: 'unplugged' });
    await advance(90);
    sim.members[PRIMARY].setAvailable(false);
    await api.ui_refresh_devices({ homey: homey() });
    await advance();

    const writesBeforePressure = sim.currentWrites().length;
    sim.setBackground(backgroundW);
    await advanceUntil(
      () => sim.pauses().some((write) => write.id === SECONDARY),
      'the reachable charger should pause without changing installation current',
    );
    expect(sim.pauses().map((write) => write.id)).toEqual([SECONDARY]);
    expect(sim.currentWrites()).toHaveLength(writesBeforePressure);

    sim.setBackground(5_000);
    await advance(600);
    expect(sim.resumes()).toEqual([]);
    sim.setBackground(600);
    await advanceUntil(
      () => sim.resumes().some((write) => write.id === SECONDARY),
      'the reachable charger should resume once there is room for the retained assignment',
    );
    expect(sim.drawW(SECONDARY)).toBe(INITIAL_W);
    expect(sim.currentWrites()).toHaveLength(writesBeforePressure);

    sim.members[PRIMARY].setAvailable(true);
    await api.ui_refresh_devices({ homey: homey() });
    sim.setBackground(5_000);
    await advanceUntil(
      () => sim.wattWrites().slice(writesBeforePressure).some(({ value }) => Number(value) < INITIAL_W),
      'the primary should resume current control when it becomes reachable',
    );
  });

  it('pauses the drawing charger under pressure when the installation level is unreadable', async () => {
    const sim = await boot({ primary: 'unplugged', unreadableInstallationCurrent: true });
    await advance(90);
    expect(sim.drawW(SECONDARY)).toBe(INITIAL_W);
    sim.setBackground(5_000);
    await advanceUntil(() => sim.pauses().some((write) => write.id === SECONDARY), 'the drawing charger should pause');
    expect(sim.pauses().map((write) => write.id)).toEqual([SECONDARY]);
  });

  it.each(MEMBERS)('stops only %s when its smart task reaches the battery target', async (targetId) => {
    const sim = await boot();
    const otherId = targetId === PRIMARY ? SECONDARY : PRIMARY;
    await advance(90);
    expect(await api.ui_smart_task_create({
      homey: homey(),
      body: { deviceId: targetId, kind: 'ev_soc', target: 80, readyByLocalTime: '21:00', deadlineAtMs: NOW_MS + 3 * 3_600_000 },
    })).toMatchObject({ ok: true });
    await advance(120);
    expect(sim.drawW(targetId)).toBeGreaterThan(0);
    expect(sim.drawW(otherId)).toBeGreaterThan(0);
    const totalW = sim.drawW(targetId) + sim.drawW(otherId);

    sim.members[targetId].setActualCapabilityValue('measure_battery', 80, { emitDeviceUpdate: false });
    await advanceUntil(
      () => sim.pauses().some((write) => write.id === targetId),
      'the charger whose car reached its target should pause',
    );
    await advance(360);
    expect(sim.drawW(targetId)).toBe(0);
    expect(sim.drawW(otherId)).toBe(totalW);
    expect(sim.pauses().map((write) => write.id)).toEqual([targetId]);
    expect(sim.resumes().every((write) => write.id !== targetId)).toBe(true);
    expect(sim.currentWrites().every((write) => write.id === PRIMARY)).toBe(true);

    sim.setBackground(9_350);
    await advanceUntil(
      () => sim.pauses().some((write) => write.id === otherId),
      'the other charger should pause under capacity pressure',
    );
    sim.setBackground(600);
    await advanceUntil(
      () => sim.resumes().some((write) => write.id === otherId),
      'the other charger should resume when the pressure clears',
    );
    await advance();
    expect(sim.resumes().every((write) => write.id !== targetId)).toBe(true);
    expect(sim.drawW(targetId)).toBe(0);
  });

  it.each(MEMBERS)('keeps owner-held %s off while the other charger resumes', async (heldId) => {
    const sim = await boot(heldId === PRIMARY ? { primary: 'held' } : { secondary: 'held' });
    const activeId = heldId === PRIMARY ? SECONDARY : PRIMARY;
    await advance(90);
    sim.setBackground(9_350);
    await advanceUntil(() => sim.drawW(activeId) === 0, 'the active charger should pause');
    expect(sim.pauses().map((write) => write.id)).toEqual([activeId]);
    sim.setBackground(600);
    await advanceUntil(
      () => sim.resumes().some((write) => write.id === activeId),
      'the charger that was charging should resume',
    );
    await advance(60);
    expect(sim.resumes().map((write) => write.id)).toContain(activeId);
    expect(sim.resumes().every((write) => write.id !== heldId)).toBe(true);
    expect(sim.drawW(heldId)).toBe(0);
  });

  it('keeps a car that finished charging off through the installation resume', async () => {
    const sim = await boot({ secondary: 'finished' });
    await advance(90);
    sim.setBackground(9_350);
    await advanceUntil(() => sim.drawW(PRIMARY) === 0, 'the active charger should pause');
    sim.setBackground(600);
    await advanceUntil(() => sim.resumes().some((write) => write.id === PRIMARY), 'the active charger should resume');
    await advance(60);
    expect(sim.resumes().every((write) => write.id !== SECONDARY)).toBe(true);
    expect(sim.drawW(SECONDARY)).toBe(0);
  });

  it('moves the installation together when its secondary moves above another device', async () => {
    const heater = new MockDevice('heater', 'Heater', ['onoff', 'measure_power'], 'heater');
    await heater.setCapabilityValue('onoff', true);
    await heater.setCapabilityValue('measure_power', 1_000);
    await boot({ additionalDevices: [heater] });

    const settings = mockHomeyInstance.settings;
    settings.set(CAPACITY_PRIORITIES, { Home: { heater: 1, [PRIMARY]: 2, [SECONDARY]: 3 } });
    await advance();
    const before = await api.ui_devices({ homey: homey() });
    const priorityById = (devices: typeof before.devices) =>
      Object.fromEntries(devices.map((device) => [device.id, device.priority]));
    expect(priorityById(before.devices)).toMatchObject({ heater: 1, [PRIMARY]: 2, [SECONDARY]: 3 });

    const groups = new Map(before.devices.map((device) => [device.id, device.controlAdapter?.chargingInstallation?.mainId]));
    const draggedOrder = [SECONDARY, heater.idValue, PRIMARY];
    const newOrder = groupModePriorityDeviceIds(draggedOrder, (id) => groups.get(id), SECONDARY);
    settings.set(CAPACITY_PRIORITIES, { Home: Object.fromEntries(newOrder.map((id, index) => [id, index + 1])) });

    await advance();
    const after = await api.ui_devices({ homey: homey() });
    expect(priorityById(after.devices)).toMatchObject({ [PRIMARY]: 1, [SECONDARY]: 2, heater: 3 });
  });

  it.each(['accepted', 'rejected'] as const)('pauses both during meter silence after a %s step-down attempt', async (outcome) => {
    const sim = await boot();
    await advance(90);
    expect(sim.drawW(PRIMARY) + sim.drawW(SECONDARY)).toBe(INITIAL_W);
    if (outcome === 'rejected') {
      sim.members[PRIMARY].configureCapabilityBehavior('target_power', { onApiWrite: { accept: false } });
    }
    const beforeSilence = sim.attempts.length;
    sim.loseMeter();

    await advanceUntil(
      () => MEMBERS.every((id) => sim.pauses().some((write) => write.id === id)),
      'the one silent-meter pass should pause both chargers',
    );
    const attempted = sim.attempts.slice(beforeSilence);
    const stepIndex = attempted.findIndex((write) => write.id === PRIMARY
      && write.capability === 'target_power' && write.value === MINIMUM_W);
    const firstPause = attempted.findIndex((write) => write.capability === 'evcharger_charging' && write.value === false);
    expect(stepIndex).toBeGreaterThanOrEqual(0);
    expect(firstPause).toBeGreaterThan(stepIndex);
    expect(sim.wattWrites().some(({ value }) => value === MINIMUM_W)).toBe(outcome === 'accepted');

    await advance(180);
    expect(sim.pauses()).toHaveLength(2);
    expect(sim.resumes()).toEqual([]);
  });

  it('uses only the switch in the meter area under pressure when the installation crosses areas', async () => {
    const sim = await boot({ splitMeterArea: true });
    await advance(90);
    expect(sim.drawW(PRIMARY)).toBeGreaterThan(0);
    expect(sim.drawW(SECONDARY)).toBeGreaterThan(0);

    sim.setAnnexBackground(8_000);
    await advanceUntil(
      () => sim.pauses().some((write) => write.id === SECONDARY),
      'the annex meter should pause only the annex charger',
    );
    await advance();
    expect(sim.pauses().map((write) => write.id)).toEqual([SECONDARY]);
    expect(sim.drawW(PRIMARY)).toBe(INITIAL_W);
    expect(sim.currentWrites()).toEqual([]);

    sim.setBackground(8_000);
    await advanceUntil(
      () => sim.pauses().some((write) => write.id === PRIMARY),
      'the main meter should pause its charger without lowering the shared current',
    );
    expect(sim.pauses().map((write) => write.id)).toEqual([SECONDARY, PRIMARY]);
    expect(sim.currentWrites()).toEqual([]);
  });

  it('pauses and resumes a member individually when the shared ladder is unavailable', async () => {
    const sim = await boot({ noLadder: true, primary: 'unplugged' });
    await advance(90);
    expect(sim.drawW(SECONDARY)).toBe(INITIAL_W);

    sim.setBackground(5_000);
    await advanceUntil(
      () => sim.pauses().some((write) => write.id === SECONDARY),
      'a reachable charger should be paused by its own switch',
    );
    sim.setBackground(600);
    await advanceUntil(
      () => sim.resumes().some((write) => write.id === SECONDARY),
      'the individually paused charger should resume',
    );
    expect(sim.pauses().map((write) => write.id)).toEqual([SECONDARY]);
    expect(sim.resumes().map((write) => write.id)).toEqual([SECONDARY]);
    expect(sim.currentWrites()).toEqual([]);
  });

  it('attributes a booked secondary task’s budget exemption to that car’s share of the installation', async () => {
    const sim = await boot({ dailyBudget: true });
    await advance(90);
    const taskSettings = {
      deviceId: SECONDARY, kind: 'ev_soc', target: 80, readyByLocalTime: '21:00', deadlineAtMs: NOW_MS + 3 * 3_600_000,
      exemptFromBudget: true, limitLowerPriorityDevices: true, pauseLowerPriorityDevices: true,
    };
    expect(await api.ui_smart_task_create({ homey: homey(), body: taskSettings })).toMatchObject({ ok: true });
    await advance(120);
    const { deferredObjectives } = await api.ui_bootstrap({ homey: homey() });
    expect(deferredObjectives).toMatchObject({
      objectivesByDeviceId: {
        [SECONDARY]: {
          rescue: { exemptFromBudget: 'always', limitLowerPriorityDevices: 'always', pauseLowerPriorityDevices: 'always' },
        },
      },
    });
    expect(sim.drawW(PRIMARY)).toBeGreaterThan(0);
    expect(sim.drawW(SECONDARY)).toBeGreaterThan(0);
    const { plan } = await api.ui_plan({ homey: homey() });
    expect(plan?.meta?.projectedExemptKw).toBe(Number((sim.drawW(SECONDARY) / 1000).toFixed(1)));
  });

  it('applies a connected secondary car’s upper bound through the primary until the car finishes', async () => {
    const car = new MockDevice('second-car', 'Car', ['ev_charging_state', 'measure_battery'], 'car');
    await car.setCapabilityValue('ev_charging_state', 'plugged_in_charging');
    await car.setCapabilityValue('measure_battery', 40);
    mockHomeyInstance.settings.set(EV_CAR_ASSOCIATIONS, { [SECONDARY]: { carIds: [car.idValue] } });
    mockHomeyInstance.settings.set(EV_CAR_CURRENT_LIMITS, { [car.idValue]: { minA: 6, maxA: 10 } });
    const sim = await boot({ additionalDevices: [car] });
    await advance(90);
    const beforeConfirmation = sim.wattWrites().length;
    const upperBoundW = 10 * WATTS_PER_AMP;
    const confirmation = await api.ui_car_association_confirm({
      homey: homey(), body: { chargerId: SECONDARY, carId: car.idValue },
    });
    expect(confirmation.associatedCar).toMatchObject({ carId: car.idValue, confirmed: true });
    await advanceUntil(
      () => sim.wattWrites().slice(beforeConfirmation).some((write) => Number(write.value) > 0 && Number(write.value) <= upperBoundW),
      'the connected car’s bound should lower shared watts through the primary',
    );
    expect(sim.drawW(PRIMARY) + sim.drawW(SECONDARY)).toBeLessThanOrEqual(upperBoundW);
    expect(sim.currentWrites().every((write) => write.id === PRIMARY)).toBe(true);

    sim.finishCharging(SECONDARY);
    await advanceUntil(
      () => sim.drawW(PRIMARY) > upperBoundW,
      'the finished car’s bound should stop constraining the charging car',
      60,
    );
    expect(sim.drawW(SECONDARY)).toBe(0);
  });

  it('prepares a safe retained watt target before claiming control of the shared installation', async () => {
    mockHomeyInstance.settings.set(EV_CHARGER_CURRENT_LIMITS, { [SECONDARY]: { minA: 6, maxA: 10 } });
    const sim = await boot({ primaryMode: 'device' });
    await advanceUntil(
      () => sim.currentWrites().some((write) => write.capability === 'target_power_mode' && write.value === 'homey'),
      'the primary should claim Homey control after preparing a safe target',
    );

    const currentWrites = sim.currentWrites();
    const prepareIndex = currentWrites.findIndex((write) => write.capability === 'target_power' && write.value === MINIMUM_W);
    const claimIndex = currentWrites.findIndex((write) => write.capability === 'target_power_mode' && write.value === 'homey');
    expect(prepareIndex).toBeGreaterThanOrEqual(0);
    expect(claimIndex).toBeGreaterThan(prepareIndex);
    expect(sim.modeClaimTargetReports).toEqual([MINIMUM_W]);
    expect(currentWrites.every((write) => write.id === PRIMARY)).toBe(true);
    expect(sim.drawW(PRIMARY) + sim.drawW(SECONDARY)).toBeLessThanOrEqual(10 * WATTS_PER_AMP);
  });

  it('pauses both chargers when their configured current ranges have no common step', async () => {
    const sim = await boot();
    await advance(90);
    expect(sim.drawW(PRIMARY) + sim.drawW(SECONDARY)).toBe(INITIAL_W);
    const beforeLimits = sim.currentWrites().length;
    mockHomeyInstance.settings.set(EV_CHARGER_CURRENT_LIMITS, {
      [PRIMARY]: { minA: 12, maxA: 16 },
      [SECONDARY]: { minA: 6, maxA: 10 },
    });
    await advanceUntil(
      () => MEMBERS.every((id) => sim.pauses().some((write) => write.id === id)),
      'both chargers should pause when no shared current is allowed',
    );
    expect(sim.currentWrites()).toHaveLength(beforeLimits);
    expect(sim.drawW(PRIMARY) + sim.drawW(SECONDARY)).toBe(0);
  });

  it.each(['unmanaged', 'power limit off', 'missing charger id'] as const)('uses individual switching with %s', async (mixed) => {
    const sim = await boot({ mixed, secondary: 'unplugged' });
    const setup = await api.ui_charging_current({ homey: homey() });
    expect(setup.find((entry) => entry.deviceId === PRIMARY)).toMatchObject({
      sharedInstallation: true, currentRoute: 'flow',
    });
    const { devices } = await api.ui_devices({ homey: homey() });
    expect(devices.find((device) => device.id === PRIMARY)?.controlAdapter?.chargingInstallation).toBeUndefined();

    await advance(90);
    sim.setBackground(5_000);
    await advanceUntil(
      () => sim.pauses().some((write) => write.id === PRIMARY),
      'the managed charger should pause through binary control',
    );
    expect(sim.pauses().map((write) => write.id)).toEqual([PRIMARY]);
    expect(sim.currentWrites()).toEqual([]);
  });
});
