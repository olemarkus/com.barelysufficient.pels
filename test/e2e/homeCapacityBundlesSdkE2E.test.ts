// SDK-boundary e2e for the R7b per-home capacity bundles: each configured
// sub-home runs its own capacity-only control loop against its OWN meter,
// independent of main's. Nothing internal is mocked — zones enter through the
// mock `manager/zones/zone` route, device zones through `MockDevice.setZone`,
// the homes registry + per-home capacity scalars through the settings seam
// (which drives the app's real settings handler → membership recompute +
// bundle reconcile + suffix hook), and power through the real Homey Energy
// poll carrying TWO id-stamped cumulative meter items in ONE live report.
// Control decisions are observed purely through what PELS writes back via
// `api.put` and the suffixed settings signals.
//
// Scenarios:
// 1. Independence — a sub-home meter overshoot sheds ONLY sub-home devices;
//    a main overshoot sheds ONLY main devices; suffixed `pels_status:<id>` +
//    `capacity_in_shortfall:<id>` are written.
// 2. Boot-window double-control guards — neither a PINNED member nor ordinary
//    zone-rule membership can be actuated by the wrong home while the zone-tree
//    fetch fails; control resumes under the correct owners after commit.
// 3. Meter safety — stale/external persisted ownership collisions fence Main,
//    and every configured meter stays source-only even when its zone membership
//    resolves to Main.
// 4. Restart rehydration — `device_last_controlled_ms:<id>` survives a
//    restart: the resume of a shed sub-home device stays backoff-blocked
//    right after reboot and lands once the cooldown elapses.
// 5. Orphaned-shed adoption (binary) — a device shed by MAIN and then moved
//    into a new sub-home is resumed by the sub-home's own planner via the
//    provenance-free restore lane (stepped-modality candidates are covered in
//    test/integration/homeCapacityBundles.test.ts).
// 6. Mode targets in an area — a setpoint-shed area heater is commanded back to
//    its mode target, and that same raise is HELD while the area's meter has
//    not reported (the direction/clamp rule itself is pinned far more cheaply in
//    test/integration/planDevices.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Homey from 'homey';
import { mockHomeyInstance, setMockDrivers, setMockZones, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  createHomesStore as createRawHomesStore,
  createDeviceHomeAssignmentsStore,
} from '../../setup/homeRegistryAdapter';
import {
  HOME_CONFIG_ACTIVATION_VERSION,
  type HomeConfig,
} from '../../lib/home/homeConfig';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  HOMEY_ENERGY_METER_DEVICE_ID,
} from '../../lib/utils/settingsKeys';
import { drainPending } from '../utils/asyncDrain';

const homeyLike = mockHomeyInstance as unknown as Homey.App['homey'];
const writeActiveHomesConfig = (config: HomeConfig): void => {
  createRawHomesStore(homeyLike).write({
    ...config,
    activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
  });
};

const ONOFF_CAP = (deviceId: string) => `manager/devices/device/${deviceId}/capability/onoff`;
const TEMP_CAP = (deviceId: string) => `manager/devices/device/${deviceId}/capability/target_temperature`;

const ZONES = {
  z1: { id: 'z1', name: 'Home', parent: null },
  z2: { id: 'z2', name: 'Annex', parent: 'z1' },
};

const SUB_HOME = { homeId: 'h_sub', name: 'Annex', rootZoneId: 'z2', meterDeviceId: 'm-sub' };

const buildOnOffDevice = async (deviceId: string, zoneId: string) => {
  const device = new MockDevice(
    deviceId,
    `Socket ${deviceId}`,
    ['onoff', 'measure_power', 'meter_power', 'rms_voltage', 'rms_current'],
    'socket',
  );
  device.setZone(zoneId);
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('measure_power', 2000);
  return device;
};

// A temperature-without-onoff load: PELS auto-assigns the `set_temperature`
// shed behaviour to these, so shedding lowers the setpoint instead of switching
// the device off. Its mode target is the RESTORE ANCHOR.
const buildHeaterDevice = async (deviceId: string, zoneId: string, setpoint: number) => {
  const device = new MockDevice(
    deviceId,
    `Heater ${deviceId}`,
    ['target_temperature', 'measure_temperature', 'measure_power', 'meter_power'],
    'heater',
  );
  device.setZone(zoneId);
  await device.setCapabilityValue('target_temperature', setpoint);
  await device.setCapabilityValue('measure_temperature', setpoint - 1);
  await device.setCapabilityValue('measure_power', 2000);
  return device;
};

// Drive BOTH meters through the real Homey Energy poll at the wire path the
// REST client hits: one live report, two id-stamped cumulative items (a device
// marked "Tracks total home energy consumption" appears exactly like this).
const meterState = {
  mainW: 200,
  subW: 200,
  failZones: false,
  mainOffline: false,
  subOffline: false,
  subMeterId: 'm-sub',
};
const installApiRoutes = () => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      // `subOffline` DROPS the sub-home's meter item entirely (a silent meter
      // dropout — never a fabricated zero), so the bundle stops sampling.
      return {
        items: [
          ...(meterState.mainOffline
            ? []
            : [{ type: 'cumulative', id: 'm-main', values: { W: meterState.mainW } }]),
          ...(meterState.subOffline
            ? []
            : [{ type: 'cumulative', id: meterState.subMeterId, values: { W: meterState.subW } }]),
        ],
      };
    }
    if (path === 'manager/zones/zone' && meterState.failZones) {
      throw new Error('zone fetch unavailable');
    }
    return originalGet(path);
  });
};

const configureMainCapacity = (limitKw: number) => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'm-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, limitKw);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set('controllable_devices', { 'device-main': true, 'device-sub': true });
  mockHomeyInstance.settings.set('managed_devices', { 'device-main': true, 'device-sub': true });
};

const configureSubHomeCapacity = (limitKw: number) => {
  mockHomeyInstance.settings.set(`${CAPACITY_LIMIT_KW}:h_sub`, limitKw);
  mockHomeyInstance.settings.set(`${CAPACITY_MARGIN_KW}:h_sub`, 0);
  mockHomeyInstance.settings.set(`${CAPACITY_DRY_RUN}:h_sub`, false);
};

const setupTwoZoneDevices = async () => {
  const mainDevice = await buildOnOffDevice('device-main', 'z1');
  const subDevice = await buildOnOffDevice('device-sub', 'z2');
  setMockDrivers({ driverA: new MockDriver('driverA', [mainDevice, subDevice]) });
  return { mainDevice, subDevice };
};

// Minimal structural view of the `api.put` spy: calls are `[path, body]`
// tuples typed unknown so the helpers narrow explicitly.
type ApiPutSpy = { mock: { calls: unknown[][] } };

const callsFor = (spy: ApiPutSpy, deviceId: string, fromIndex = 0) => (
  spy.mock.calls.slice(fromIndex).filter(([path]) => typeof path === 'string' && path.includes(deviceId))
);

// Advance whole 10 s poll cycles (the Homey Energy cadence) until `predicate`
// holds. A control decision can take more than one poll (sample → scheduled
// rebuild → actuation, plus per-engine cooldowns), and `drainUntil*` alone
// only drains zero-delay turns — it never fires the next poll.
const advancePollsUntil = async (predicate: () => boolean, maxPolls = 30): Promise<void> => {
  for (let poll = 0; poll < maxPolls && !predicate(); poll += 1) {
    await vi.advanceTimersByTimeAsync(10_000);
    await drainPending();
  }
  expect(predicate()).toBe(true);
};

// `boolean | number` (not `unknown`) so the same matcher covers boolean onoff
// writes and numeric `target_temperature` writes while a mistyped literal — one
// that could never match, silently turning a negative assertion into a pass —
// still fails to compile.
const wasCalledWith = (
  spy: ApiPutSpy,
  path: string,
  value: boolean | number,
  fromIndex = 0,
): boolean => spy.mock.calls.slice(fromIndex).some(([callPath, body]) => (
  callPath === path && (body as { value?: unknown } | undefined)?.value === value
));

describe('Per-home capacity bundles (SDK-boundary e2e)', () => {
  beforeEach(() => {
    // 'Date' MUST be faked: under NODE_ENV=test the plan-rebuild scheduler
    // (and the bundle scheduler) read their clocks via Date.now(); an unfaked
    // Date runs real wall-clock against fake timers and strands rebuilds.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 0));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    setMockZones({ ...ZONES });
    meterState.mainW = 200;
    meterState.subW = 200;
    meterState.failZones = false;
    meterState.mainOffline = false;
    meterState.subOffline = false;
    meterState.subMeterId = 'm-sub';
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('sheds ONLY the sub-home device on a sub-meter overshoot, ONLY the main device on a main overshoot, and writes the suffixed signals', async () => {
    await setupTwoZoneDevices();
    configureMainCapacity(1);
    configureSubHomeCapacity(1);
    installApiRoutes();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(1000);
    // The user creates the sub-home on a running app; the settings event
    // drives membership recompute + bundle reconcile.
    writeActiveHomesConfig({ subHomes: [SUB_HOME] });
    await vi.advanceTimersByTimeAsync(1000);

    // Sub-home meter overshoots; main's meter is comfortably under its cap.
    meterState.subW = 5000;
    await advancePollsUntil(() => wasCalledWith(putSpy, ONOFF_CAP('device-sub'), false));
    // ONLY the sub-home device was actuated.
    expect(callsFor(putSpy, 'device-main')).toEqual([]);

    // Sustained overshoot with nothing left to shed → the sub-home's OWN
    // shortfall signal; its status blob exists under the suffixed key. Main's
    // unsuffixed shortfall signal stays untouched (never true).
    await advancePollsUntil(() => mockHomeyInstance.settings.get('capacity_in_shortfall:h_sub') === true);
    expect(mockHomeyInstance.settings.get('pels_status:h_sub')).toBeTruthy();
    expect(mockHomeyInstance.settings.get('capacity_in_shortfall')).not.toBe(true);

    // Now the MAIN meter overshoots (sub recovers): only main's device sheds.
    const mainPhaseStart = putSpy.mock.calls.length;
    meterState.subW = 200;
    meterState.mainW = 5000;
    await advancePollsUntil(() => wasCalledWith(putSpy, ONOFF_CAP('device-main'), false, mainPhaseStart));
    await drainPending();
    const subWritesInMainPhase = callsFor(putSpy, 'device-sub', mainPhaseStart)
      .filter(([, body]) => (body as { value?: unknown } | undefined)?.value === false);
    expect(subWritesInMainPhase).toEqual([]);
  }, 30_000);

  it('a persisted explicit-meter collision fences Main while the sub-home owner still controls', async () => {
    await setupTwoZoneDevices();
    configureMainCapacity(1);
    configureSubHomeCapacity(1);
    // This models a legacy/external write that bypassed the current save
    // endpoint: Main and the area both explicitly name m-main. The live report
    // therefore resolves the SAME 5 kW item as primary and additional input.
    writeActiveHomesConfig({
      subHomes: [{ ...SUB_HOME, meterDeviceId: 'm-main' }],
    });
    meterState.mainW = 5000;
    installApiRoutes();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await advancePollsUntil(() => wasCalledWith(putSpy, ONOFF_CAP('device-sub'), false));

    // The rightful area controller remains live. Main sees the same overshoot
    // but its producer-owned collision fence closes the final write seam.
    expect(wasCalledWith(putSpy, ONOFF_CAP('device-main'), false)).toBe(false);
  }, 30_000);

  it('dry-run activation: flipping capacity_dry_run true→false issues the already-planned sub-home shed', async () => {
    await setupTwoZoneDevices();
    configureMainCapacity(6); // main comfortably under its cap; only the sub overshoots
    // The sub-home starts in dry-run (its default) with a tiny cap.
    mockHomeyInstance.settings.set(`${CAPACITY_LIMIT_KW}:h_sub`, 1);
    mockHomeyInstance.settings.set(`${CAPACITY_MARGIN_KW}:h_sub`, 0);
    mockHomeyInstance.settings.set(`${CAPACITY_DRY_RUN}:h_sub`, true);
    installApiRoutes();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(1000);
    writeActiveHomesConfig({ subHomes: [SUB_HOME] });
    await vi.advanceTimersByTimeAsync(1000);

    // Sustained sub-meter overshoot: the bundle PLANS a shed every poll but, while
    // dry-run, must never actuate the sub-home load.
    meterState.subW = 5000;
    for (let poll = 0; poll < 5; poll += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await drainPending();
    }
    expect(callsFor(putSpy, 'device-sub')).toEqual([]);

    // The user flips the sub-home OUT of dry-run (the normal ACTIVATION path). A
    // plain rebuild reproduces the SAME shed action signature as the never-applied
    // dry-run plan, so `maybeApplyPlanChanges` skips it (stable actuation does not
    // cover sheds). The fix force-applies the committed shed via reconcile, so the
    // command lands ON the transition itself — asserted with NO further polls (a
    // later poll could eventually mask the gap via some other signature change).
    const activationStart = putSpy.mock.calls.length;
    mockHomeyInstance.settings.set(`${CAPACITY_DRY_RUN}:h_sub`, false);
    await drainPending();
    await vi.advanceTimersByTimeAsync(100);
    await drainPending();
    expect(wasCalledWith(putSpy, ONOFF_CAP('device-sub'), false, activationStart)).toBe(true);
    // Main stayed comfortably under its cap the whole time: its device never shed.
    expect(callsFor(putSpy, 'device-main')).toEqual([]);
  }, 30_000);

  it('Flow source fences a committed sub-home shed when control is activated', async () => {
    await setupTwoZoneDevices();
    configureMainCapacity(6);
    mockHomeyInstance.settings.set(`${CAPACITY_LIMIT_KW}:h_sub`, 1);
    mockHomeyInstance.settings.set(`${CAPACITY_MARGIN_KW}:h_sub`, 0);
    mockHomeyInstance.settings.set(`${CAPACITY_DRY_RUN}:h_sub`, true);
    installApiRoutes();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(1000);
    writeActiveHomesConfig({ subHomes: [SUB_HOME] });
    await vi.advanceTimersByTimeAsync(1000);

    // Commit an over-cap shed plan while the home's own control toggle is off.
    meterState.subW = 5000;
    for (let poll = 0; poll < 5; poll += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await drainPending();
    }
    expect(callsFor(putSpy, 'device-sub')).toEqual([]);

    // Flow samples carry no meter identity. Switching the global source must
    // therefore fence this bundle before its ordinary activation path performs
    // rebuild -> reconcile against the already-committed shed.
    mockHomeyInstance.settings.set('power_source', 'flow');
    await drainPending();
    const flowPhaseStart = putSpy.mock.calls.length;
    mockHomeyInstance.settings.set(`${CAPACITY_DRY_RUN}:h_sub`, false);
    await vi.advanceTimersByTimeAsync(1000);
    await drainPending();

    expect(wasCalledWith(
      putSpy,
      ONOFF_CAP('device-sub'),
      false,
      flowPhaseStart,
    )).toBe(false);
    expect((mockHomeyInstance.settings.get('pels_status:h_sub') as
      | { dryRunEffective?: unknown }
      | undefined)?.dryRunEffective).toBe(true);
  }, 30_000);

  it('boot-window guard: a PINNED sub-home member is not actuated before a zone-tree commit; the shed lands after the tree arrives', async () => {
    await setupTwoZoneDevices();
    configureMainCapacity(1);
    configureSubHomeCapacity(1);
    // Sub-home + pin exist BEFORE boot; the zone-tree fetch fails, so
    // membership resolves the pin (no tree needed) but is NOT tree-committed.
    writeActiveHomesConfig({ subHomes: [SUB_HOME] });
    createDeviceHomeAssignmentsStore(homeyLike).write({ 'device-sub': 'h_sub' });
    meterState.failZones = true;
    meterState.subW = 5000;
    installApiRoutes();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    // Several poll cycles of hard sub-meter overshoot: the bundle PLANS but
    // must not actuate (forced dry-run until membership is tree-committed).
    await vi.advanceTimersByTimeAsync(35_000);
    await drainPending();
    expect(callsFor(putSpy, 'device-sub')).toEqual([]);

    // The zone tree becomes fetchable; a snapshot refresh commits it. The
    // very same overshoot that was gated above now actuates. This path now runs
    // through the DECOUPLED membership-ready edge (the registry fires each
    // bundle's `applyMembershipReadyEdge` from the zone-tree-commit transition,
    // not from sample arrival).
    meterState.failZones = false;
    mockHomeyInstance.settings.set('refresh_target_devices_snapshot', Date.now());
    await advancePollsUntil(() => wasCalledWith(putSpy, ONOFF_CAP('device-sub'), false));
  }, 30_000);

  it('boot-window guard: unpinned zone-rule devices are not actuated by Main before the zone tree commits', async () => {
    await setupTwoZoneDevices();
    configureMainCapacity(1);
    configureSubHomeCapacity(1);
    // Normal zone-rule configuration exists BEFORE boot, with no pin to make
    // the sub-home membership resolvable while the zones endpoint is down.
    writeActiveHomesConfig({ subHomes: [SUB_HOME] });
    meterState.failZones = true;
    meterState.mainW = 5000;
    meterState.subW = 5000;
    installApiRoutes();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    // The empty-tree resolver provisionally classifies both devices as Main.
    // Neither that fallback nor the sub-home's readiness-gated plan may write.
    await vi.advanceTimersByTimeAsync(35_000);
    await drainPending();
    expect(callsFor(putSpy, 'device-main')).toEqual([]);
    expect(callsFor(putSpy, 'device-sub')).toEqual([]);

    // Once a real tree commits, the membership-change rebuilds restore both
    // control loops under their actual owners: Main sheds only device-main and
    // the Annex bundle sheds device-sub.
    meterState.failZones = false;
    mockHomeyInstance.settings.set('refresh_target_devices_snapshot', Date.now());
    await advancePollsUntil(() => (
      wasCalledWith(putSpy, ONOFF_CAP('device-main'), false)
      && wasCalledWith(putSpy, ONOFF_CAP('device-sub'), false)
    ));
  }, 30_000);

  it('freshness heartbeat: a silent sub-meter dropout escalates to a fail-closed shed', async () => {
    await setupTwoZoneDevices();
    configureMainCapacity(1);
    configureSubHomeCapacity(1);
    writeActiveHomesConfig({ subHomes: [SUB_HOME] });
    installApiRoutes();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    // Sub-home comfortably under cap: several live polls set the meter's
    // lastTimestamp (proving it was sampling), and nothing is shed.
    for (let poll = 0; poll < 3; poll += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await drainPending();
    }
    expect(callsFor(putSpy, 'device-sub')).toEqual([]);

    // The sub-meter goes SILENT (item dropped from the live report; never a
    // fabricated zero). Without a heartbeat the last "under cap" decision would
    // freeze forever. The freshness heartbeat re-runs the planner while the
    // meter is quiet, so past the 10-minute stale-shed timeout the bundle
    // escalates to `stale_fail_closed` and sheds.
    meterState.subOffline = true;
    await advancePollsUntil(() => wasCalledWith(putSpy, ONOFF_CAP('device-sub'), false), 75);
    expect(wasCalledWith(putSpy, ONOFF_CAP('device-sub'), false)).toBe(true);
  }, 30_000);

  it('own-meter carve-out: a managed+controllable device that IS the meter is never shed', async () => {
    // The sub-home's meter is a managed+controllable metering plug (`device-sub`);
    // a second plug (`device-sub2`) is an ordinary sub-home load.
    const subMeterPlug = await buildOnOffDevice('device-sub', 'z2');
    const subLoad = await buildOnOffDevice('device-sub2', 'z2');
    const mainDevice = await buildOnOffDevice('device-main', 'z1');
    setMockDrivers({ driverA: new MockDriver('driverA', [mainDevice, subMeterPlug, subLoad]) });
    configureMainCapacity(1);
    configureSubHomeCapacity(1);
    mockHomeyInstance.settings.set('controllable_devices', {
      'device-main': true, 'device-sub': true, 'device-sub2': true,
    });
    mockHomeyInstance.settings.set('managed_devices', {
      'device-main': true, 'device-sub': true, 'device-sub2': true,
    });
    // The sub-home's meter IS the plug `device-sub`; its reading rides an item
    // stamped with that same device id.
    meterState.subMeterId = 'device-sub';
    writeActiveHomesConfig({
      subHomes: [{ ...SUB_HOME, meterDeviceId: 'device-sub' }],
    });
    installApiRoutes();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    // Sustained overshoot: the ordinary load sheds; the meter plug NEVER does
    // (it is carved out of the bundle's plan input — shedding it would break
    // sampling / oscillate).
    meterState.subW = 5000;
    await advancePollsUntil(() => wasCalledWith(putSpy, ONOFF_CAP('device-sub2'), false));
    // The meter plug's EXACT onoff path was never driven off (substring match
    // would false-positive on `device-sub2`, so compare the exact capability path).
    expect(wasCalledWith(putSpy, ONOFF_CAP('device-sub'), false)).toBe(false);
  }, 30_000);

  it('never lets Main shed a sub-home meter that resolves to Main membership', async () => {
    const mainLoad = await buildOnOffDevice('device-main', 'z1');
    const subMeterPlug = await buildOnOffDevice('device-sub-meter', 'z1');
    const subLoad = await buildOnOffDevice('device-sub', 'z2');
    setMockDrivers({ driverA: new MockDriver('driverA', [mainLoad, subMeterPlug, subLoad]) });
    configureMainCapacity(1);
    configureSubHomeCapacity(6);
    mockHomeyInstance.settings.set('controllable_devices', {
      'device-main': true, 'device-sub-meter': true, 'device-sub': true,
    });
    mockHomeyInstance.settings.set('managed_devices', {
      'device-main': true, 'device-sub-meter': true, 'device-sub': true,
    });
    // Make the metering plug Main's lowest-priority load so the pre-fix plan
    // deterministically selects it first during the Main overshoot.
    mockHomeyInstance.settings.set('capacity_priorities', {
      Home: { 'device-main': 1, 'device-sub': 1, 'device-sub-meter': 10 },
    });
    meterState.subMeterId = 'device-sub-meter';
    writeActiveHomesConfig({
      subHomes: [{ ...SUB_HOME, meterDeviceId: 'device-sub-meter' }],
    });
    meterState.mainW = 5000;
    installApiRoutes();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await advancePollsUntil(() => (
      wasCalledWith(putSpy, ONOFF_CAP('device-main'), false)
      || wasCalledWith(putSpy, ONOFF_CAP('device-sub-meter'), false)
    ));

    expect(wasCalledWith(putSpy, ONOFF_CAP('device-sub-meter'), false)).toBe(false);
    expect(wasCalledWith(putSpy, ONOFF_CAP('device-main'), false)).toBe(true);
    expect(wasCalledWith(putSpy, ONOFF_CAP('device-sub'), false)).toBe(false);
  }, 30_000);

  it('restart: suffixed per-home control state survives, the bundle rehydrates it, and the control loop resumes', async () => {
    const { subDevice } = await setupTwoZoneDevices();
    configureMainCapacity(1);
    configureSubHomeCapacity(1);
    writeActiveHomesConfig({ subHomes: [SUB_HOME] });
    installApiRoutes();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(1000);
    meterState.subW = 5000;
    await advancePollsUntil(() => wasCalledWith(putSpy, ONOFF_CAP('device-sub'), false));

    // SDK acceptance only records a pending command. Let the device publish the
    // commanded binary value and the ordinary observation loop confirm it before
    // expecting persisted actuation accounting.
    await subDevice.setCapabilityValue('onoff', false);
    await subDevice.setCapabilityValue('measure_power', 0);
    await vi.advanceTimersByTimeAsync(10_000);
    await drainPending();
    const lastControlled = mockHomeyInstance.settings.get('device_last_controlled_ms:h_sub') as
      | Record<string, number>
      | undefined;
    expect(lastControlled?.['device-sub']).toBeGreaterThan(0);

    // Restart shortly after the shed. The device reports off + idle now.
    await app.onUninit();
    await drainPending();
    putSpy.mockClear();
    // Teardown left every suffixed persisted key in place for re-creation
    // (hydration of the engine's lastDeviceControlledMs from this key is
    // asserted in test/integration/homeCapacityBundles.test.ts).
    expect(mockHomeyInstance.settings.get('device_last_controlled_ms:h_sub')).toEqual(lastControlled);
    expect(mockHomeyInstance.settings.get('power_tracker_state:h_sub')).toBeTruthy();
    // Ample headroom for the resume after reboot (persisted BEFORE boot so
    // the recreated bundle reads it at construction).
    mockHomeyInstance.settings.set(`${CAPACITY_LIMIT_KW}:h_sub`, 6);
    meterState.subW = 200;

    const rebooted = createApp();
    await rebooted.onInit();
    // The recreated bundle picks the shed device back up and resumes it once
    // its restore machinery allows — the per-home loop survived the restart.
    await advancePollsUntil(() => wasCalledWith(putSpy, ONOFF_CAP('device-sub'), true), 60);
    expect(rebooted).toBeTruthy();
  }, 30_000);

  it('meter change survives an immediate restart without acting on the old meter freshness', async () => {
    await setupTwoZoneDevices();
    configureMainCapacity(6);
    configureSubHomeCapacity(1);
    writeActiveHomesConfig({ subHomes: [SUB_HOME] });
    installApiRoutes();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    for (let poll = 0; poll < 3; poll += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await drainPending();
    }
    expect(callsFor(putSpy, 'device-sub')).toEqual([]);

    // Stop receiving meter items, then let the volatile tracker debounce flush
    // the OLD meter's freshness. With no later sample, there is no pending
    // tracker write for teardown to flush after the meter edit.
    meterState.subOffline = true;
    await vi.advanceTimersByTimeAsync(61_000);
    await drainPending();
    expect((mockHomeyInstance.settings.get('power_tracker_state:h_sub') as
      | { lastTimestamp?: unknown }
      | undefined)?.lastTimestamp).toEqual(expect.any(Number));

    writeActiveHomesConfig({
      subHomes: [{ ...SUB_HOME, meterDeviceId: 'm-sub-2' }],
    });
    await drainPending();
    await app.onUninit();
    await drainPending();
    putSpy.mockClear();

    const rebooted = createApp();
    await rebooted.onInit();
    // More than the ten-minute stale-shed threshold, while the NEW meter is
    // still absent. Rehydrating the OLD timestamp would trigger a fail-closed
    // sub-home shed; a durable meter-identity reset stays never-sampled.
    for (let poll = 0; poll < 75; poll += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await drainPending();
    }
    expect(wasCalledWith(putSpy, ONOFF_CAP('device-sub'), false)).toBe(false);
    expect(rebooted).toBeTruthy();
  }, 30_000);

  it('orphaned-shed adoption: a device shed by MAIN and then moved into a new sub-home is resumed by the sub-home bundle', async () => {
    const { subDevice } = await setupTwoZoneDevices();
    configureMainCapacity(1);
    installApiRoutes();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    // Boot single-home: a whole-home overshoot sheds BOTH devices (main owns everything).
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(1000);
    meterState.mainW = 5000;
    meterState.subW = 5000;
    await advancePollsUntil(() => (
      wasCalledWith(putSpy, ONOFF_CAP('device-sub'), false)
      && wasCalledWith(putSpy, ONOFF_CAP('device-main'), false)
    ));
    await subDevice.setCapabilityValue('onoff', false);
    await subDevice.setCapabilityValue('measure_power', 0);
    await drainPending();

    // The user now creates the sub-home around the SHED device, with its own
    // meter and ample capacity. The sub-home bundle must adopt the observed-off
    // device as an ordinary resume candidate (no shed provenance required).
    const adoptionPhaseStart = putSpy.mock.calls.length;
    configureSubHomeCapacity(6);
    writeActiveHomesConfig({ subHomes: [SUB_HOME] });
    meterState.mainW = 5000; // main stays in overshoot — it must NOT resume anything
    meterState.subW = 200;
    // Past the sub-home bundle's 60 s restore stabilization + resume machinery.
    await advancePollsUntil(
      () => wasCalledWith(putSpy, ONOFF_CAP('device-sub'), true, adoptionPhaseStart),
      60,
    );

    // The resume came from the sub-home's planner: main is still hard over its
    // cap the whole time and its own device stays off (no ON write for it).
    const mainOnWrites = callsFor(putSpy, 'device-main', adoptionPhaseStart)
      .filter(([, body]) => (body as { value?: unknown } | undefined)?.value === true);
    expect(mainOnWrites).toEqual([]);
  }, 30_000);

  // Regression: the sub-home scope used to bind `getModeDeviceTargets: () => ({})`
  // and a neutral operating-mode sentinel, so `resolveTemperatureSeed` fell through
  // to the device's LIVE setpoint. While shed that reading IS the shed setpoint, so
  // on release `plannedTarget === currentTarget`, the executor dropped the write, and
  // the heater stayed at the shed setpoint forever. The mode target is the restore
  // anchor, so it binds live for every home.
  it('an area temperature device shed to its shed setpoint is commanded back to its mode target', async () => {
    const heater = await buildHeaterDevice('device-sub-heat', 'z2', 22);
    const mainDevice = await buildOnOffDevice('device-main', 'z1');
    setMockDrivers({ driverA: new MockDriver('driverA', [mainDevice, heater]) });

    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'm-main');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('managed_devices', { 'device-main': true, 'device-sub-heat': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'device-main': true, 'device-sub-heat': true });
    // The mode target the heater must be resumed TO (the restore anchor), and the
    // shed setpoint PELS drops it to while the area is over its cap. The anchor
    // write IS load-bearing: `persistFilledModeTargets` returns early on an absent
    // or empty `mode_device_targets` blob (`setup/appDeviceSupport.ts`), so
    // nothing would auto-seed it here. That unanchored case is a separate open
    // defect (TODO: setpoint-shed device with no mode target stays stranded);
    // what this test pins is the RELEASE write for an ANCHORED device.
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'device-sub-heat': 22 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      'device-sub-heat': { action: 'set_temperature', temperature: 16 },
    });
    // The area cap must leave room to resume the heater against its EXPECTED
    // power (retained at ~2 kW even after the shed drops measured draw to 0), or
    // the resume is correctly held by `insufficient_headroom` forever and the
    // test would pass for the wrong reason. Verified: a 1 kW area cap fails here.
    configureSubHomeCapacity(6);
    installApiRoutes();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(1000);
    writeActiveHomesConfig({ subHomes: [SUB_HOME] });
    await vi.advanceTimersByTimeAsync(1000);

    // The area overshoots its 6 kW cap: the heater is shed by setpoint.
    meterState.subW = 9000;
    await advancePollsUntil(() => wasCalledWith(putSpy, TEMP_CAP('device-sub-heat'), 16));
    // Homey now reports the shed setpoint back, and the heater stops drawing
    // because the room (21 C) is already above it. That reported setpoint is the
    // observation that used to poison the next cycle's seed.
    await heater.setCapabilityValue('target_temperature', 16);
    await heater.setCapabilityValue('measure_power', 0);
    await drainPending();

    // The area returns well under its cap: the heater must be commanded back to
    // its mode target, not left sitting at the shed setpoint.
    const resumePhaseStart = putSpy.mock.calls.length;
    meterState.subW = 200;
    await advancePollsUntil(
      () => wasCalledWith(putSpy, TEMP_CAP('device-sub-heat'), 22, resumePhaseStart),
      60,
    );
  }, 30_000);

  // Regression (review P1): binding the mode targets live for a sub-home also
  // opened a LOAD-ADDING write on a bundle that has never seen its own meter.
  // A heater sitting below its mode target was raised on the very first
  // actuating rebuild, with the area's draw completely unknown — and a
  // never-sampled bundle is invisible to the freshness heartbeat (no aging
  // timestamp), so nothing escalated it later. This is the SDK-boundary proof
  // that the planner's unknown-power clamp reaches an area bundle; the clamp's
  // direction rule is pinned in test/integration/planDevices.test.ts.
  it('holds an area heater at its current setpoint until the area meter has reported, then applies the mode target', async () => {
    const heater = await buildHeaterDevice('device-sub-heat', 'z2', 18);
    const mainDevice = await buildOnOffDevice('device-main', 'z1');
    setMockDrivers({ driverA: new MockDriver('driverA', [mainDevice, heater]) });

    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'm-main');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('managed_devices', { 'device-main': true, 'device-sub-heat': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'device-main': true, 'device-sub-heat': true });
    // Configured 22, device sitting at 18: a raise is pending from the first
    // plan onward. Written before boot so `persistFilledModeTargets` cannot
    // auto-seed 18 and make the assertion vacuous.
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'device-sub-heat': 22 } });
    configureSubHomeCapacity(6);
    // The area's meter is offline from boot: its item never appears in the live
    // report, so this bundle never receives a sample (never a fabricated zero).
    meterState.subOffline = true;
    writeActiveHomesConfig({ subHomes: [SUB_HOME] });
    installApiRoutes();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    // Well past the zone-tree commit and the membership-ready apply edge, which
    // is decoupled from sample arrival and so DOES run for a never-sampled
    // bundle (`getStableSampleRevision()` is stable at revision 0).
    for (let poll = 0; poll < 12; poll += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await drainPending();
    }
    expect(callsFor(putSpy, 'device-sub-heat')).toEqual([]);
    // A never-sampled area builds no plan at all, so it also publishes no status
    // blob — the old positive control (reading `dryRunEffective: false` here)
    // can no longer run in this phase. It moves below instead: proving the SAME
    // bundle is live and allowed to actuate the moment its meter reports proves
    // the silence above was the missing measurement and not some unrelated gate
    // (dry-run, membership, source epoch) suppressing every write.
    expect(mockHomeyInstance.settings.getKeys()).not.toContain('pels_status:h_sub');

    // The meter comes back. Now the area's draw is known and well under its
    // 6 kW cap, so the same mode target is applied — the hold is on the unknown,
    // not a permanent loss of the restore anchor.
    const meterLivePhaseStart = putSpy.mock.calls.length;
    meterState.subOffline = false;
    meterState.subW = 200;
    await advancePollsUntil(
      () => wasCalledWith(putSpy, TEMP_CAP('device-sub-heat'), 22, meterLivePhaseStart),
      60,
    );
    // The relocated positive control (see above): live, not dry-run, not fenced.
    // Had any of those been suppressing the writes, this would still read true
    // or stay absent now that a measurement exists.
    expect((mockHomeyInstance.settings.get('pels_status:h_sub') as
      | { dryRunEffective?: unknown }
      | undefined)?.dryRunEffective).toBe(false);
  }, 30_000);

  // A silent-meter area gets no power-driven rebuilds and the freshness
  // heartbeat fires at most once per stale period. Its own scoped mode switch
  // must therefore rebuild that bundle immediately so a cooler-mode LOWERING —
  // the direction the unknown-power hold deliberately lets through — is not
  // left unapplied indefinitely.
  // The main home's half of the same rule. PELS requires a whole-home meter
  // (`docs/getting-started.md`), so "never sampled" is a startup instant, not a
  // configuration — but until it passes, there is nothing to plan from, and a
  // plan built anyway would have to carry that absence into every consumer.
  it('builds no plan for the main home until its meter reports, then builds one', async () => {
    const heater = await buildHeaterDevice('device-main-heat', 'z1', 18);
    setMockDrivers({ driverA: new MockDriver('driverA', [heater]) });

    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'm-main');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('managed_devices', { 'device-main-heat': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'device-main-heat': true });
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'device-main-heat': 22 } });
    // The meter never appears in the live report, so no sample is ever ingested
    // — never a fabricated zero.
    meterState.mainOffline = true;
    installApiRoutes();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp({ withoutPowerMeasurement: true });
    await app.onInit();
    for (let poll = 0; poll < 12; poll += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await drainPending();
    }

    // No plan: no published status, and the pending mode raise stays unwritten.
    expect(mockHomeyInstance.settings.get('pels_status')).toBeFalsy();
    expect(callsFor(putSpy, 'device-main-heat')).toEqual([]);

    // The meter appears. The sample schedules its own rebuild, so the plan
    // arrives without any other trigger.
    const meterLivePhaseStart = putSpy.mock.calls.length;
    meterState.mainOffline = false;
    meterState.mainW = 200;
    await advancePollsUntil(
      () => wasCalledWith(putSpy, TEMP_CAP('device-main-heat'), 22, meterLivePhaseStart),
      60,
    );
    expect(mockHomeyInstance.settings.get('pels_status')).toBeTruthy();
  }, 30_000);

  it('applies a cooler-mode lowering to an area heater while the area meter is silent', async () => {
    const heater = await buildHeaterDevice('device-sub-heat', 'z2', 22);
    const mainDevice = await buildOnOffDevice('device-main', 'z1');
    setMockDrivers({ driverA: new MockDriver('driverA', [mainDevice, heater]) });

    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'm-main');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('managed_devices', { 'device-main': true, 'device-sub-heat': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'device-main': true, 'device-sub-heat': true });
    // Both modes are configured up front and copied into the area's independent
    // catalog; only its scoped active-mode setting changes later.
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('mode_device_targets', {
      Home: { 'device-sub-heat': 22 },
      Away: { 'device-sub-heat': 16 },
    });
    configureSubHomeCapacity(6);
    installApiRoutes();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(1000);
    writeActiveHomesConfig({ subHomes: [SUB_HOME] });
    // Several live polls: the bundle samples its meter (so this is NOT the
    // never-sampled case) and the heater sits at its Home target, nothing to do.
    for (let poll = 0; poll < 3; poll += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await drainPending();
    }
    expect(callsFor(putSpy, 'device-sub-heat')).toEqual([]);

    // The area meter goes silent, then the user switches to Away. Stay far
    // below the 10-minute stale-shed window: within it there are NO sub-home
    // rebuild triggers left except the mode fan-out itself, so the lowering
    // landing here proves the fan-out (and a revert makes this time out).
    meterState.subOffline = true;
    await vi.advanceTimersByTimeAsync(10_000);
    await drainPending();
    const modeSwitchStart = putSpy.mock.calls.length;
    mockHomeyInstance.settings.set('operating_mode:h_sub', 'Away');
    await vi.advanceTimersByTimeAsync(5_000);
    await drainPending();
    expect(wasCalledWith(putSpy, TEMP_CAP('device-sub-heat'), 16, modeSwitchStart)).toBe(true);
  }, 30_000);
});
