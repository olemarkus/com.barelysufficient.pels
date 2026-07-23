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
// 3. Meter ownership — a stale/external persisted collision fences Main while
//    the sub-home's legitimate controller continues to act.
// 4. Restart rehydration — `device_last_controlled_ms:<id>` survives a
//    restart: the resume of a shed sub-home device stays backoff-blocked
//    right after reboot and lands once the cooldown elapses.
// 5. Orphaned-shed adoption (binary) — a device shed by MAIN and then moved
//    into a new sub-home is resumed by the sub-home's own planner via the
//    provenance-free restore lane (stepped-modality candidates are covered in
//    test/integration/homeCapacityBundles.test.ts).
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

// Drive BOTH meters through the real Homey Energy poll at the wire path the
// REST client hits: one live report, two id-stamped cumulative items (a device
// marked "Tracks total home energy consumption" appears exactly like this).
const meterState = { mainW: 200, subW: 200, failZones: false, subOffline: false, subMeterId: 'm-sub' };
const installApiRoutes = () => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      // `subOffline` DROPS the sub-home's meter item entirely (a silent meter
      // dropout — never a fabricated zero), so the bundle stops sampling.
      return {
        items: [
          { type: 'cumulative', id: 'm-main', values: { W: meterState.mainW } },
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

const wasCalledWith = (
  spy: ApiPutSpy,
  path: string,
  value: boolean,
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
    const lastControlled = mockHomeyInstance.settings.get('device_last_controlled_ms:h_sub') as
      | Record<string, number>
      | undefined;
    expect(lastControlled?.['device-sub']).toBeGreaterThan(0);

    // Restart shortly after the shed. The device reports off + idle now.
    await subDevice.setCapabilityValue('onoff', false);
    await subDevice.setCapabilityValue('measure_power', 0);
    await vi.advanceTimersByTimeAsync(10_000);
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
});
