// Integration coverage for the multi-home membership wiring (R4):
// - the full post-refresh seam chain: real DeviceTransport → observer-owned
//   emitter dispatch → `HomeMembershipService.recompute()` — including the
//   zone-tree COMMIT trigger (the first refresh resolves zone membership once
//   the detached fetch commits), a zone move picked up by the next refresh,
//   trigger teardown, and recompute-throw containment;
// - settings-change triggers through the real serialized settings handler
//   (`homes_config` / `device_home_assignments` map entries);
// - the discriminated store reads: 'suspect' keeps the PREVIOUS cached
//   membership (junk blob + written-before marker), 'unwritten' is empty;
// - null-zone-tree fail-safe at boot and last-good tree retention;
// - pin overrides (incl. the 'main' opt-out and a dangling pin's fallback);
// - the read-only `ui_homes` payload composition.
// Only the Homey SDK seams are mocked, via the shared mock (settings store,
// `manager/zones/zone` route, drivers).
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type Homey from 'homey';
import api from '../../api';
import { DeviceTransport } from '../../lib/device/deviceTransport';
import { ObservedHomePower } from '../../lib/observer/observedHomePower';
import { ObservedStateEmitter } from '../../lib/observer/observedStateEvents';
import type { Logger as PinoLogger } from '../../lib/logging/logger';
import type { ZoneTree } from '../../lib/home/homeConfig';
import { createSettingsHandler, type SettingsHandlerDeps } from '../../lib/utils/settingsHandlers';
import {
  DEVICE_HOME_ASSIGNMENTS, HOMES_CONFIG,
} from '../../lib/utils/settingsKeys';
import {
  createDeviceHomeAssignmentsStore,
  createHomesStore,
} from '../../setup/homeRegistryAdapter';
import {
  createHomeMembershipService,
  HomeMembershipService,
  type HomeMembershipDeviceInput,
} from '../../setup/homeMembership';
import { wireHomeMembership } from '../../setup/appInit/wireHomeMembership';
import type { AppContext } from '../../lib/app/appContext';
import { getSettingsUiHomesPayload, saveSettingsUiHomesConfig } from '../../setup/settingsUiApi';
import {
  MockDevice,
  MockDriver,
  mockHomeyInstance,
  setMockDrivers,
  setMockZones,
} from '../mocks/homey';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';

const homeyApp = mockHomeyInstance as unknown as Homey.App;
const homeyLike = mockHomeyInstance as unknown as Homey.App['homey'];
// A homey with the real (mock) settings store but NO wired homeMembership
// service: exercises the save endpoint's classified store path without the
// forest-root diagnostics (`getApp(...)?.homeMembership` is undefined).
const homeyNoService = {
  app: {}, settings: mockHomeyInstance.settings,
} as unknown as Homey.App['homey'];
const noop = (): void => undefined;
const loggerMock: Logger = {
  log: noop,
  debug: noop,
  error: noop,
  structuredLog: { info: noop, error: noop, debug: noop, warn: noop } as unknown as Logger['structuredLog'],
};

const ZONES = {
  z1: { id: 'z1', name: 'Home', parent: null },
  z2: { id: 'z2', name: 'First floor', parent: 'z1' },
  z3: { id: 'z3', name: 'Garage', parent: 'z1' },
};
const SUB_HOME_A = {
  homeId: 'h_a', name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: null,
};

const makeLoggerSpy = () => {
  const warn = vi.fn();
  const info = vi.fn();
  const error = vi.fn();
  const debug = vi.fn();
  const logger = {
    warn, info, error, debug,
  } as unknown as PinoLogger;
  return {
    warn, info, error, debug, logger,
  };
};

// Static-input service used by the non-transport scenarios: real stores over
// the mock settings seam; zone tree and device list injected per test.
const makeStaticService = (params: {
  getZoneTree: () => ZoneTree | null;
  devices: readonly HomeMembershipDeviceInput[];
  logger?: PinoLogger;
}): HomeMembershipService => new HomeMembershipService({
  homesStore: createHomesStore(homeyLike),
  assignmentsStore: createDeviceHomeAssignmentsStore(homeyLike),
  getZoneTree: params.getZoneTree,
  getDevices: () => params.devices,
  getLogger: () => params.logger,
});

// A homey whose app carries a WIRED, non-degraded membership service (real
// stores over the mock settings seam, ZONES committed) AND the mock settings
// store — the save endpoint's HEALTHY path: the forest-root + nested-root
// checks have a known tree, and the shared degraded predicate reads a clean
// config. The service caches whatever the stores hold at construction time.
const makeWiredHealthyHomey = (): Homey.App['homey'] => {
  const service = makeStaticService({ getZoneTree: () => ZONES, devices: [] });
  service.recompute();
  return {
    app: { homeMembership: service }, settings: mockHomeyInstance.settings,
  } as unknown as Homey.App['homey'];
};

const flushHandlerQueue = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const settleDetachedZoneFetch = async (): Promise<void> => (
  new Promise((resolve) => { setImmediate(resolve); })
);

beforeEach(() => {
  mockHomeyInstance.settings.clear();
  setMockZones({ ...ZONES });
  setMockDrivers({});
});

afterEach(() => {
  mockHomeyInstance.settings.removeAllListeners('set');
  vi.restoreAllMocks();
});

describe('post-refresh recompute through the transport seam', () => {
  // Real transport + observer emitter + wiring, exactly as `initHomeMembership`
  // assembles it (both notification seams subscribed).
  const buildTransportChain = (logger?: PinoLogger) => {
    const emitter = new ObservedStateEmitter();
    const transport = new DeviceTransport(homeyApp, loggerMock, {}, undefined, {
      observedStateDispatcher: emitter.asDispatcher(new ObservedHomePower()),
    });
    const wiring = createHomeMembershipService({
      homey: homeyLike,
      emitter,
      setOnZoneTreeCommitted: (callback) => transport.setOnZoneTreeCommitted(callback),
      setOnDeviceZoneChanged: (callback) => transport.setOnDeviceZoneChanged(callback),
      getZoneTree: () => transport.getZoneTree(),
      getDevices: () => transport.getSnapshot().map((snapshotDevice) => ({
        deviceId: snapshotDevice.id,
        zoneId: snapshotDevice.zoneId ?? null,
      })),
      getLogger: () => logger,
    });
    return { transport, service: wiring.service, teardown: wiring.teardown };
  };

  const addZonedHeater = (zoneId: string): MockDevice => {
    const device = new MockDevice('dev1', 'Heater', ['target_temperature']);
    device.setZone(zoneId);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    return device;
  };

  it('the FIRST refresh resolves zone membership once the detached tree fetch commits', async () => {
    const device = addZonedHeater('z2');
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    const { transport, service } = buildTransportChain();

    // At the refresh-dispatch instant the detached tree fetch has not landed:
    // no tree seen yet, so the device fail-safes to main, visibly.
    await transport.refreshSnapshot();
    expect(service.getHomeIdForDevice('dev1')).toBe('main');
    expect(service.getDiagnostics().membershipByDeviceId.dev1.source).toBe('fallback');

    // The tree COMMIT itself triggers recompute — no second refresh needed.
    await settleDetachedZoneFetch();
    expect(service.getHomeIdForDevice('dev1')).toBe('h_a');
    expect(service.getDiagnostics().membershipByDeviceId.dev1.source).toBe('zone');
    expect(service.getMembershipMap()).toEqual({ dev1: 'h_a' });
    expect(service.hasSubHomes()).toBe(true);
    // Unknown device: main, always.
    expect(service.getHomeIdForDevice('never-seen')).toBe('main');

    // Zone move: the device now reports the garage zone; the next snapshot
    // refresh recomputes membership back to the main-home complement (the
    // refresh dispatch joins against the already-cached tree synchronously).
    device.setZone('z3');
    await transport.refreshSnapshot();
    expect(service.getHomeIdForDevice('dev1')).toBe('main');
    expect(service.getDiagnostics().membershipByDeviceId.dev1.source).toBe('zone');
  });

  it('the production wiring joins the RAW transport snapshot, never the decorated ctx path', async () => {
    addZonedHeater('z2');
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    const emitter = new ObservedStateEmitter();
    const transport = new DeviceTransport(homeyApp, loggerMock, {}, undefined, {
      observedStateDispatcher: emitter.asDispatcher(new ObservedHomePower()),
    });
    // Stub ctx exposing ONLY the members `wireHomeMembership` may touch. The
    // decorated-snapshot getter throws: `decorateTargetSnapshotList` MUTATES
    // stepped-load runtime state (prune/expire/confirm), so a membership
    // recompute routing through it would be a side-effecting read. If any
    // recompute touched it, containment would leave the membership map empty
    // and the h_a assertion below would fail.
    const ctxStub = {
      homey: homeyLike,
      deviceManager: transport,
      getStructuredLogger: () => undefined,
      get latestTargetSnapshot(): never {
        throw new Error('membership recompute must not touch the decorated snapshot path');
      },
    } as unknown as AppContext;
    const wiring = wireHomeMembership(ctxStub, emitter);

    await transport.refreshSnapshot();
    await settleDetachedZoneFetch();
    expect(wiring.service.getMembershipMap()).toEqual({ dev1: 'h_a' });
  });

  it('a membership change firing before the plan service is wired warns and skips the rebuild, without throwing', async () => {
    addZonedHeater('z2');
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    const { warn, error, logger } = makeLoggerSpy();
    const emitter = new ObservedStateEmitter();
    const transport = new DeviceTransport(homeyApp, loggerMock, {}, undefined, {
      observedStateDispatcher: emitter.asDispatcher(new ObservedHomePower()),
    });
    // Wiring-order regression stub: membership seams present, planService
    // absent at fire time.
    const ctxStub = {
      homey: homeyLike,
      deviceManager: transport,
      getStructuredLogger: () => logger,
    } as unknown as AppContext;
    const wiring = wireHomeMembership(ctxStub, emitter);

    // Refresh + detached tree commit resolve dev1 into h_a — a plan-relevant
    // change, so the invalidation fires with no plan service wired: the skip
    // must be logged, never silent, and nothing may throw (a contained throw
    // would surface as home_membership_recompute_failed on the error spy).
    await transport.refreshSnapshot();
    await settleDetachedZoneFetch();
    expect(wiring.service.getHomeIdForDevice('dev1')).toBe('h_a');
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'home_membership_rebuild_skipped_unwired',
    }));
    expect(error).not.toHaveBeenCalled();
  });

  it('a realtime device.update that moves the device across zones recomputes membership immediately', async () => {
    const device = addZonedHeater('z2');
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    const { transport, service } = buildTransportChain();

    await transport.refreshSnapshot();
    await settleDetachedZoneFetch();
    expect(service.getHomeIdForDevice('dev1')).toBe('h_a');

    // Realtime move to the garage: NO snapshot refresh — the transport's
    // zone-move seam triggers the recompute the instant the replacement
    // entry commits. Without it the device would stay h_a (and, in the R5
    // consumer, wrongly outside main's plan or vice versa) until the next
    // full refresh.
    device.setZone('z3');
    transport.injectDeviceUpdateForTest(device.toHomeyApiDevice() as HomeyDeviceLike);
    expect(service.getHomeIdForDevice('dev1')).toBe('main');
    expect(service.getDiagnostics().membershipByDeviceId.dev1.source).toBe('zone');

    // A realtime update with an UNCHANGED zone does not recompute (no delta,
    // no trigger): move the persisted pin so a recompute WOULD change the
    // map, then inject an update with the same zone — the map must not move.
    createDeviceHomeAssignmentsStore(homeyLike).write({ dev1: 'h_a' });
    transport.injectDeviceUpdateForTest(device.toHomeyApiDevice() as HomeyDeviceLike);
    expect(service.getHomeIdForDevice('dev1')).toBe('main');
  });

  it('teardown detaches all three triggers: refresh dispatch, tree commit, and realtime zone move', async () => {
    const device = addZonedHeater('z2');
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    const { transport, service, teardown } = buildTransportChain();
    await transport.refreshSnapshot();
    await settleDetachedZoneFetch();
    expect(service.getHomeIdForDevice('dev1')).toBe('h_a');

    teardown();

    // The device moves zones and a full refresh cycle (dispatch + detached
    // tree commit) completes — a live subscription would recompute dev1 to
    // main. The map staying put proves NEITHER trigger reached the service.
    device.setZone('z3');
    await transport.refreshSnapshot();
    await settleDetachedZoneFetch();
    expect(service.getMembershipMap()).toEqual({ dev1: 'h_a' });

    // A realtime zone move after teardown is equally inert (z3 → z1 would
    // recompute dev1 to main on a live subscription).
    device.setZone('z1');
    transport.injectDeviceUpdateForTest(device.toHomeyApiDevice() as HomeyDeviceLike);
    expect(service.getMembershipMap()).toEqual({ dev1: 'h_a' });
  });

  it('a throwing recompute is contained + logged; the snapshot pipeline and detached chain are unharmed', async () => {
    const device = addZonedHeater('z2');
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    const { error, logger } = makeLoggerSpy();
    const { transport, service } = buildTransportChain(logger);
    await transport.refreshSnapshot();
    await settleDetachedZoneFetch();
    expect(service.getHomeIdForDevice('dev1')).toBe('h_a');

    vi.spyOn(service, 'recompute').mockImplementation(() => {
      throw new Error('forced recompute failure');
    });
    device.setZone('z3');
    // The refresh emit chain must complete (an uncontained throw would reject
    // refreshSnapshot and break the live-feed/mutation listeners riding it)...
    await transport.refreshSnapshot();
    // ...and the detached tree-commit chain must settle without an unhandled
    // rejection (its recompute throws too).
    await settleDetachedZoneFetch();

    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'home_membership_recompute_failed',
      trigger: 'snapshot_refresh',
    }));
    // Previous membership retained; the snapshot itself committed normally.
    expect(service.getHomeIdForDevice('dev1')).toBe('h_a');
    expect(transport.getSnapshot()[0]?.zoneId).toBe('z3');
  });
});

describe('settings-change recompute triggers', () => {
  const buildHandlerDeps = (recompute: () => void): SettingsHandlerDeps => ({
    homey: mockHomeyInstance as unknown as SettingsHandlerDeps['homey'],
    recomputeHomeMembership: recompute,
    loadCapacitySettings: vi.fn(),
    rebuildPlanFromCache: vi.fn().mockResolvedValue(undefined),
    refreshTargetDevicesSnapshot: vi.fn().mockResolvedValue(undefined),
    loadPowerTracker: vi.fn(),
    getCapacityGuard: vi.fn().mockReturnValue(undefined),
    getCapacitySettings: vi.fn().mockReturnValue({ limitKw: 10, marginKw: 1 }),
    getCapacityDryRun: vi.fn().mockReturnValue(false),
    loadPriceOptimizationSettings: vi.fn(),
    loadDailyBudgetSettings: vi.fn(),
    updateDailyBudgetState: vi.fn(),
    resetDailyBudgetLearning: vi.fn(),
    priceService: {
      refreshGridTariffData: vi.fn().mockResolvedValue(undefined),
      refreshSpotPrices: vi.fn().mockResolvedValue(undefined),
      updateCombinedPrices: vi.fn(),
    },
    updatePriceOptimizationEnabled: vi.fn(),
    updateOverheadToken: vi.fn().mockResolvedValue(undefined),
    updateDebugLoggingEnabled: vi.fn(),
  });

  it('homes_config and pin writes recompute through the serialized handler; suspect keeps the previous map', async () => {
    const { warn, logger } = makeLoggerSpy();
    const service = makeStaticService({
      getZoneTree: () => ZONES,
      devices: [{ deviceId: 'dev1', zoneId: 'z2' }],
      logger,
    });
    const handler = createSettingsHandler(buildHandlerDeps(() => service.recompute()));
    // Mirror `initSettingsHandlerForApp`: dispatch every settings `set`.
    mockHomeyInstance.settings.on('set', (key: string) => { void handler(key); });

    service.recompute();
    expect(service.getHomeIdForDevice('dev1')).toBe('main');
    expect(service.hasSubHomes()).toBe(false);

    // Registry write lands through the handler map entry — no manual recompute.
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    await flushHandlerQueue();
    expect(service.getHomeIdForDevice('dev1')).toBe('h_a');
    expect(service.hasSubHomes()).toBe(true);

    // Junk blob with the written-before marker present classifies 'suspect':
    // the PREVIOUS membership must survive, with a structured warning.
    mockHomeyInstance.settings.set(HOMES_CONFIG, 'not-a-homes-config');
    await flushHandlerQueue();
    expect(service.getHomeIdForDevice('dev1')).toBe('h_a');
    expect(service.hasSubHomes()).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'home_membership_store_read_suspect',
      storeKey: HOMES_CONFIG,
    }));
    expect(warn).toHaveBeenCalledTimes(1);

    // Edge-triggered, not per-recompute: a second consecutive suspect read
    // must NOT re-warn — a warn-per-recompute regression would fire at
    // snapshot-refresh cadence indefinitely.
    service.recompute();
    expect(service.getHomeIdForDevice('dev1')).toBe('h_a');
    expect(warn).toHaveBeenCalledTimes(1);

    // A recovered (plausible) read re-arms the edge...
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    await flushHandlerQueue();
    expect(service.getHomeIdForDevice('dev1')).toBe('h_a');
    expect(warn).toHaveBeenCalledTimes(1);

    // ...so a NEW suspect episode warns exactly once more.
    mockHomeyInstance.settings.set(HOMES_CONFIG, 'junk-episode-two');
    await flushHandlerQueue();
    expect(service.getHomeIdForDevice('dev1')).toBe('h_a');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(expect.objectContaining({
      event: 'home_membership_store_read_suspect',
      storeKey: HOMES_CONFIG,
    }));

    // Pin write through the handler: 'main' pin opts the device out of h_a.
    createDeviceHomeAssignmentsStore(homeyLike).write({ dev1: 'main' });
    await flushHandlerQueue();
    expect(service.getHomeIdForDevice('dev1')).toBe('main');
    expect(service.getDiagnostics().membershipByDeviceId.dev1.source).toBe('pin');
  });

  it('a recompute that CHANGES the plan-relevant membership requests a plan rebuild; identical and single-home recomputes stay free', async () => {
    const onMembershipChanged = vi.fn();
    let devices: readonly HomeMembershipDeviceInput[] = [{ deviceId: 'dev1', zoneId: 'z2' }];
    const service = new HomeMembershipService({
      homesStore: createHomesStore(homeyLike),
      assignmentsStore: createDeviceHomeAssignmentsStore(homeyLike),
      getZoneTree: () => ZONES,
      getDevices: () => devices,
      getLogger: () => undefined,
      onMembershipChanged,
    });
    const handler = createSettingsHandler(buildHandlerDeps(() => service.recompute()));
    mockHomeyInstance.settings.on('set', (key: string) => { void handler(key); });

    // Boot baseline: the FIRST recompute must NOT request a rebuild — the
    // bootstrap builds the initial plan through its own path.
    service.recompute();
    expect(service.getHomeIdForDevice('dev1')).toBe('main');
    expect(onMembershipChanged).not.toHaveBeenCalled();

    // Single-home device churn: the membership MAP changes (new key) but
    // every device is main — the plan filter is identity, so this must stay
    // free (device-set rebuilds ride the snapshot-refresh paths; firing here
    // broke real single-home plan scenarios).
    devices = [{ deviceId: 'dev1', zoneId: 'z2' }, { deviceId: 'dev2', zoneId: 'z3' }];
    service.recompute();
    expect(onMembershipChanged).not.toHaveBeenCalled();

    // Settings-driven membership change (dev1: main → h_a): the committed
    // plan now governs the wrong device set — exactly one rebuild request.
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    await flushHandlerQueue();
    expect(service.getHomeIdForDevice('dev1')).toBe('h_a');
    expect(onMembershipChanged).toHaveBeenCalledTimes(1);

    // Re-writing the SAME config recomputes but resolves identically — the
    // change gate keeps it free (no rebuild storm from redundant writes).
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    await flushHandlerQueue();
    expect(onMembershipChanged).toHaveBeenCalledTimes(1);

    // And a bare no-change recompute (any trigger) requests nothing either.
    service.recompute();
    expect(onMembershipChanged).toHaveBeenCalledTimes(1);

    // Leaving the sub-home (pin back to main) is a plan-relevant change too.
    createDeviceHomeAssignmentsStore(homeyLike).write({ dev1: 'main' });
    await flushHandlerQueue();
    expect(service.getHomeIdForDevice('dev1')).toBe('main');
    expect(onMembershipChanged).toHaveBeenCalledTimes(2);
  });
});

describe('zone-tree fail-safe and pins', () => {
  it('null tree at boot resolves every device to main; a seen tree is never dropped for a later null', () => {
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    let tree: ZoneTree | null = null;
    const service = makeStaticService({
      getZoneTree: () => tree,
      devices: [
        { deviceId: 'dev1', zoneId: 'z2' },
        { deviceId: 'dev2', zoneId: null },
      ],
    });

    service.recompute();
    expect(service.getMembershipMap()).toEqual({ dev1: 'main', dev2: 'main' });
    expect(service.getDiagnostics().membershipByDeviceId.dev1.source).toBe('fallback');

    tree = ZONES;
    service.recompute();
    expect(service.getHomeIdForDevice('dev1')).toBe('h_a');

    // A transport reporting null again (e.g. recreated) must not flap
    // membership back to main — the last seen tree stays in use.
    tree = null;
    service.recompute();
    expect(service.getHomeIdForDevice('dev1')).toBe('h_a');
    expect(service.getDiagnostics().zoneTree).toEqual(ZONES);
  });

  it('honors pins over the zone rule and fail-safes a dangling pin to the zone rule', () => {
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    createDeviceHomeAssignmentsStore(homeyLike).write({
      dev1: 'main', // opt-out of the surrounding h_a
      dev2: 'h_a', // pin INTO h_a from the garage
      dev3: 'h_ghost', // dangling: falls back to the zone rule, visibly
    });
    const service = makeStaticService({
      getZoneTree: () => ZONES,
      devices: [
        { deviceId: 'dev1', zoneId: 'z2' },
        { deviceId: 'dev2', zoneId: 'z3' },
        { deviceId: 'dev3', zoneId: 'z3' },
      ],
    });
    service.recompute();

    expect(service.getMembershipMap()).toEqual({ dev1: 'main', dev2: 'h_a', dev3: 'main' });
    const { membershipByDeviceId } = service.getDiagnostics();
    expect(membershipByDeviceId.dev1.source).toBe('pin');
    expect(membershipByDeviceId.dev2.source).toBe('pin');
    expect(membershipByDeviceId.dev3.source).toBe('fallback');
  });
});

describe('last-known zone retention', () => {
  // Live-devices variant of `makeStaticService`: the device list is swapped
  // between recomputes, mirroring successive committed snapshots.
  const makeLiveService = (params: {
    getDevices: () => readonly HomeMembershipDeviceInput[];
    logger?: PinoLogger;
  }): HomeMembershipService => new HomeMembershipService({
    homesStore: createHomesStore(homeyLike),
    assignmentsStore: createDeviceHomeAssignmentsStore(homeyLike),
    getZoneTree: () => ZONES,
    getDevices: params.getDevices,
    getLogger: () => params.logger,
  });

  it('keeps membership through a one-cycle zone omission, with a structured debug log on retention use', () => {
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    const { debug, logger } = makeLoggerSpy();
    let devices: readonly HomeMembershipDeviceInput[] = [{ deviceId: 'dev1', zoneId: 'z2' }];
    const service = makeLiveService({ getDevices: () => devices, logger });

    service.recompute();
    expect(service.getHomeIdForDevice('dev1')).toBe('h_a');
    expect(debug).not.toHaveBeenCalled();

    // Fulfilled snapshot whose entry transiently omits zone: the previous
    // resolution holds — no one-cycle flap to main/'fallback'.
    devices = [{ deviceId: 'dev1', zoneId: null }];
    service.recompute();
    expect(service.getHomeIdForDevice('dev1')).toBe('h_a');
    expect(service.getDiagnostics().membershipByDeviceId.dev1.source).toBe('zone');
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({
      event: 'home_membership_zone_retained',
      deviceId: 'dev1',
      zoneId: 'z2',
    }));
    expect(debug).toHaveBeenCalledTimes(1);

    // Edge-triggered, not per-use: a persistently zone-omitting device must
    // NOT re-log on the next recompute (which can fire twice per refresh
    // cycle — snapshot refresh + zone-tree commit).
    service.recompute();
    expect(service.getHomeIdForDevice('dev1')).toBe('h_a');
    expect(debug).toHaveBeenCalledTimes(1);

    // Zone back in the snapshot: no retention read, membership unchanged —
    // and the log edge re-arms...
    debug.mockClear();
    devices = [{ deviceId: 'dev1', zoneId: 'z2' }];
    service.recompute();
    expect(service.getHomeIdForDevice('dev1')).toBe('h_a');
    expect(debug).not.toHaveBeenCalled();

    // ...so a NEW omission episode logs exactly once more.
    devices = [{ deviceId: 'dev1', zoneId: null }];
    service.recompute();
    expect(service.getHomeIdForDevice('dev1')).toBe('h_a');
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('prunes retention when a device genuinely leaves the snapshot', () => {
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    let devices: readonly HomeMembershipDeviceInput[] = [
      { deviceId: 'dev1', zoneId: 'z2' },
      { deviceId: 'dev2', zoneId: 'z3' },
    ];
    const service = makeLiveService({ getDevices: () => devices });

    service.recompute();
    expect(service.getHomeIdForDevice('dev1')).toBe('h_a');

    // dev1 genuinely removed: membership and retention both drop it.
    devices = [{ deviceId: 'dev2', zoneId: 'z3' }];
    service.recompute();
    expect(service.getMembershipMap()).toEqual({ dev2: 'main' });

    // Re-added with zone omitted: retention was pruned, so this is a real
    // unknown-zone device — fail-safe to main, visibly.
    devices = [
      { deviceId: 'dev1', zoneId: null },
      { deviceId: 'dev2', zoneId: 'z3' },
    ];
    service.recompute();
    expect(service.getHomeIdForDevice('dev1')).toBe('main');
    expect(service.getDiagnostics().membershipByDeviceId.dev1.source).toBe('fallback');
  });

  it('follows a zone move — a later omission retains the moved-to zone, not the original', () => {
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    let devices: readonly HomeMembershipDeviceInput[] = [{ deviceId: 'dev1', zoneId: 'z2' }];
    const service = makeLiveService({ getDevices: () => devices });

    service.recompute();
    expect(service.getHomeIdForDevice('dev1')).toBe('h_a');

    devices = [{ deviceId: 'dev1', zoneId: 'z3' }];
    service.recompute();
    expect(service.getHomeIdForDevice('dev1')).toBe('main');

    devices = [{ deviceId: 'dev1', zoneId: null }];
    service.recompute();
    expect(service.getHomeIdForDevice('dev1')).toBe('main');
    expect(service.getDiagnostics().membershipByDeviceId.dev1.source).toBe('zone');
  });
});

describe('ui_homes payload', () => {
  it('composes homes + membership-with-source + zone tree + hasSubHomes from the service', async () => {
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    createDeviceHomeAssignmentsStore(homeyLike).write({ dev2: 'h_a' });
    const service = makeStaticService({
      getZoneTree: () => ZONES,
      devices: [
        { deviceId: 'dev1', zoneId: 'z2' },
        { deviceId: 'dev2', zoneId: 'z3' },
      ],
    });
    service.recompute();

    const homeyWithApp = {
      app: { homeMembership: service }, settings: mockHomeyInstance.settings,
    } as unknown as Homey.App['homey'];
    const expectedPayload = {
      homes: [SUB_HOME_A],
      membershipByDeviceId: {
        dev1: { homeId: 'h_a', source: 'zone' },
        dev2: { homeId: 'h_a', source: 'pin' },
      },
      zoneTree: ZONES,
      hasSubHomes: true,
      configDegraded: false,
    };
    expect(getSettingsUiHomesPayload({ homey: homeyWithApp })).toEqual(expectedPayload);
    // And the api.ts endpoint serves the same composition.
    await expect(api.ui_homes({ homey: homeyWithApp })).resolves.toEqual(expectedPayload);
  });

  it('serves the honest empty single-home shape — degraded — while the service is unassigned (boot window)', () => {
    const homeyWithoutService = {
      app: {}, settings: mockHomeyInstance.settings,
    } as unknown as Homey.App['homey'];
    expect(getSettingsUiHomesPayload({ homey: homeyWithoutService })).toEqual({
      homes: [],
      membershipByDeviceId: {},
      zoneTree: null,
      hasSubHomes: false,
      // Nothing can vouch for the persisted config in the boot window: the
      // settings UI must refuse whole-value homes_config writes.
      configDegraded: true,
    });
  });

  it('applies intent ops through the classified store: create allocates the id, edit and delete round-trip', async () => {
    // A healthy wired homey (not the boot-window degraded case, which now
    // refuses): create allocates `h_` + 8 hex, edit names the id, delete
    // round-trips.
    const homeyWired = makeWiredHealthyHomey();
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: 'meter1' } },
    })).toEqual({ ok: true });
    const afterCreate = createHomesStore(homeyLike).read();
    expect(afterCreate.state).toBe('present');
    if (afterCreate.state !== 'present') return;
    const created = afterCreate.value.subHomes[0];
    expect(created.homeId).toMatch(/^h_[0-9a-f]{8}$/);
    expect(created).toMatchObject({ name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: 'meter1' });
    // Edit names the id; delete is idempotent. The api.ts route serves the
    // same handler.
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { homeId: created.homeId, name: 'Renamed', rootZoneId: 'z2', meterDeviceId: 'meter1' } },
    })).toEqual({ ok: true });
    const afterEdit = createHomesStore(homeyLike).read();
    expect(afterEdit.state === 'present' && afterEdit.value.subHomes).toEqual([
      { homeId: created.homeId, name: 'Renamed', rootZoneId: 'z2', meterDeviceId: 'meter1' },
    ]);
    await expect(api.ui_homes_save({
      homey: homeyWired, body: { op: 'delete', homeId: created.homeId },
    })).resolves.toEqual({ ok: true });
    const afterDelete = createHomesStore(homeyLike).read();
    expect(afterDelete.state === 'present' && afterDelete.value.subHomes).toEqual([]);
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired, body: { op: 'delete', homeId: created.homeId },
    })).toEqual({ ok: true });
  });

  it('two upserts from independently stale panels both survive (intent ops cannot wipe siblings)', () => {
    const homeyWired = makeWiredHealthyHomey();
    // Both panels fetched the same empty list, then each saved its own area.
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: 'm1' } },
    })).toEqual({ ok: true });
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'Garage flat', rootZoneId: 'z3', meterDeviceId: 'm2' } },
    })).toEqual({ ok: true });
    const read = createHomesStore(homeyLike).read();
    expect(read.state === 'present' && read.value.subHomes.map((area) => area.name))
      .toEqual(['Upstairs', 'Garage flat']);
  });

  it('refuses on a suspect FRESH homes read without touching the persisted blob', () => {
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    // Wired healthy first (the recompute classifies the homes store 'present',
    // so the degraded predicate is clean): the FRESH-read TOCTOU gate is what
    // must catch the junk written afterwards.
    const homeyWired = makeWiredHealthyHomey();
    // Junk over the written-before marker classifies the fresh read 'suspect'.
    mockHomeyInstance.settings.set(HOMES_CONFIG, 'junk-blob');
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired, body: { op: 'delete', homeId: SUB_HOME_A.homeId },
    })).toEqual({ ok: false, reason: 'degraded' });
    // Nothing was written: the store still classifies suspect over the junk.
    expect(createHomesStore(homeyLike).read()).toEqual({ state: 'suspect' });
  });

  it('refuses an upsert whose root nests or duplicates an existing area; a disjoint upsert persists', () => {
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] }); // area rooted at z2
    const homeyWired = makeWiredHealthyHomey();
    // Identical root: a second area rooted at z2 would, by deepest-root
    // precedence, silently re-home z2's devices — refuse, persist nothing.
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'Also upstairs', rootZoneId: 'z2', meterDeviceId: 'm2' } },
    })).toEqual({ ok: false, reason: 'invalid' });
    const afterRefusal = createHomesStore(homeyLike).read();
    expect(afterRefusal.state === 'present' && afterRefusal.value.subHomes).toEqual([SUB_HOME_A]);
    // A disjoint root (z3, a sibling subtree) is accepted.
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'Garage flat', rootZoneId: 'z3', meterDeviceId: 'm3' } },
    })).toEqual({ ok: true });
    const afterAccept = createHomesStore(homeyLike).read();
    expect(afterAccept.state === 'present' && afterAccept.value.subHomes.map((area) => area.rootZoneId))
      .toEqual(['z2', 'z3']);
  });

  it('refuses an upsert while the membership service is unwired (boot-window degraded)', () => {
    expect(saveSettingsUiHomesConfig({
      homey: homeyNoService,
      body: { op: 'upsert', area: { name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: 'm1' } },
    })).toEqual({ ok: false, reason: 'degraded' });
    // Nothing persisted — the homes store is untouched.
    expect(createHomesStore(homeyLike).read()).toEqual({ state: 'unwritten' });
  });

  it('refuses an upsert while the device_home_assignments store classifies suspect', () => {
    // The homes store is clean, but a written-before pins store reading back
    // junk classifies 'suspect' — only the FULL degraded condition (either
    // store suspect) catches this, not a homes-store read alone.
    createDeviceHomeAssignmentsStore(homeyLike).write({ dev1: 'h_a' });
    mockHomeyInstance.settings.set(DEVICE_HOME_ASSIGNMENTS, 'not-a-pins-blob');
    const service = makeStaticService({ getZoneTree: () => ZONES, devices: [] });
    service.recompute();
    expect(service.getDiagnostics().configDegraded).toBe(true);
    const homeyWired = {
      app: { homeMembership: service }, settings: mockHomeyInstance.settings,
    } as unknown as Homey.App['homey'];
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: 'm1' } },
    })).toEqual({ ok: false, reason: 'degraded' });
    // The clean homes store stays untouched.
    expect(createHomesStore(homeyLike).read()).toEqual({ state: 'unwritten' });
  });

  it('refuses malformed ops and a zone-forest root as an area root', () => {
    expect(saveSettingsUiHomesConfig({ homey: homeyNoService, body: { op: 'upsert' } }))
      .toEqual({ ok: false, reason: 'invalid' });
    expect(saveSettingsUiHomesConfig({ homey: homeyNoService, body: undefined }))
      .toEqual({ ok: false, reason: 'invalid' });
    // Forest-root rejection needs a known tree (via the wired service):
    // an area rooted at z1 would swallow the whole home.
    const service = makeStaticService({ getZoneTree: () => ZONES, devices: [] });
    service.recompute();
    const homeyWithApp = {
      app: { homeMembership: service }, settings: mockHomeyInstance.settings,
    } as unknown as Homey.App['homey'];
    expect(saveSettingsUiHomesConfig({
      homey: homeyWithApp,
      body: { op: 'upsert', area: { name: 'Everything', rootZoneId: 'z1', meterDeviceId: null } },
    })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('surfaces configDegraded while a store read classifies suspect, and clears it on recovery', () => {
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    const service = makeStaticService({
      getZoneTree: () => ZONES,
      devices: [{ deviceId: 'dev1', zoneId: 'z2' }],
    });
    service.recompute();
    const homeyWithApp = {
      app: { homeMembership: service }, settings: mockHomeyInstance.settings,
    } as unknown as Homey.App['homey'];
    expect(getSettingsUiHomesPayload({ homey: homeyWithApp }).configDegraded).toBe(false);

    // Junk blob with the written-before marker present classifies 'suspect':
    // the payload keeps serving the cached homes but flags them degraded so
    // the UI refuses read-modify-write mutations over the stale view.
    mockHomeyInstance.settings.set(HOMES_CONFIG, 'not-a-homes-config');
    service.recompute();
    const degraded = getSettingsUiHomesPayload({ homey: homeyWithApp });
    expect(degraded.configDegraded).toBe(true);
    expect(degraded.homes).toEqual([SUB_HOME_A]);

    // Recovery: a plausible read clears the flag on the next recompute.
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    service.recompute();
    expect(getSettingsUiHomesPayload({ homey: homeyWithApp }).configDegraded).toBe(false);
  });
});

// R7b: the per-home capacity bundles gate EXECUTION on a committed zone tree.
// The registry fires each bundle's membership-ready apply-edge from this
// transition (decoupled from meter-sample arrival, so it works in flow mode).
describe('HomeMembershipService — zone-tree-commit readiness edge', () => {
  const unwrittenStore = { read: () => ({ state: 'unwritten' as const }) } as never;
  const buildService = (params: {
    getZoneTree: () => ZoneTree | null;
    onZoneTreeCommitReady: () => void;
  }): HomeMembershipService => new HomeMembershipService({
    homesStore: unwrittenStore,
    assignmentsStore: unwrittenStore,
    getZoneTree: params.getZoneTree,
    getDevices: () => [],
    getLogger: () => undefined,
    onZoneTreeCommitReady: params.onZoneTreeCommitReady,
  });

  it('fires onZoneTreeCommitReady exactly ONCE on the null→committed edge, decoupled from any sample', () => {
    let tree: ZoneTree | null = null;
    const onReady = vi.fn();
    const service = buildService({ getZoneTree: () => tree, onZoneTreeCommitReady: onReady });

    // No tree yet → not ready, edge not fired.
    service.recompute();
    expect(service.hasSeenZoneTreeCommit()).toBe(false);
    expect(onReady).not.toHaveBeenCalled();

    // Tree commits → readiness edge fires once (no meter sample involved).
    tree = ZONES as unknown as ZoneTree;
    service.recompute();
    expect(service.hasSeenZoneTreeCommit()).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);

    // Later recomputes — even a transient null read (last-good tree retained) —
    // never re-fire the once-only edge.
    tree = null;
    service.recompute();
    tree = ZONES as unknown as ZoneTree;
    service.recompute();
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});
