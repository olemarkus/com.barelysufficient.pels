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
import {
  HOME_CONFIG_ACTIVATION_VERSION,
  type DeviceHomeAssignmentsStore,
  type HomeConfig,
  type HomesStore,
  type ZoneTree,
} from '../../lib/home/homeConfig';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { MainMeterSelection } from '../../packages/contracts/src/mainMeterSelection';
import { createSettingsHandler, type SettingsHandlerDeps } from '../../lib/utils/settingsHandlers';
import {
  DEVICE_HOME_ASSIGNMENTS,
  DEVICE_HOME_ASSIGNMENTS_INITIALIZED,
  HOMEY_ENERGY_METER_DEVICE_ID,
  HOMES_CONFIG,
  HOMES_CONFIG_INITIALIZED,
  POWER_SOURCE,
  POWER_TRACKER_STATE,
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
import { POWER_SAMPLE_STALE_THRESHOLD_MS } from '../../packages/shared-domain/src/powerFreshness';
import type { ConfiguredPowerSourceRead } from '../../setup/powerSourceSettings';
import type { StableSampleRevision } from '../../setup/powerSamplePipeline';
import type { AppContext } from '../../lib/app/appContext';
import { getSettingsUiHomesPayload, saveSettingsUiHomesConfig } from '../../setup/settingsUiHomesApi';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import {
  buildStarvedRescueDevices,
  hasMainHomeSmartTaskAuthority,
  isSmartTaskDeviceInMainHome,
  resolveSmartTaskHomeScope,
} from '../../setup/appInit/smartTaskHomeScope';
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

/**
 * Converging main after membership settles used to be a distinct
 * `planService.reconcileLatestPlanState()` call; it is now
 * `rebuildPlanFromCache('home_membership_settled', shouldAbort, onAbort)`, because
 * re-applying a committed plan without re-deciding it is exactly the lane that
 * breached the hard cap in production (inc_26449fb9). Count those calls where
 * these tests used to count reconciles.
 */
const countSettleRebuilds = (spy: { mock: { calls: unknown[][] } }): number => (
  spy.mock.calls.filter((call) => call[0] === 'home_membership_settled').length
);

/** Ownership-generation rebuilds only — excludes the settle rebuild above. */
const countGenerationRebuilds = (spy: { mock: { calls: unknown[][] } }): number => (
  spy.mock.calls.filter((call) => call[0] !== 'home_membership_settled').length
);
const loggerMock: Logger = {
  log: noop,
  debug: noop,
  error: noop,
  structuredLog: { info: noop, error: noop, debug: noop, warn: noop } as unknown as Logger['structuredLog'],
};
const silentApiLogger = {
  error: noop,
} as unknown as PinoLogger;

const ZONES = {
  z1: { id: 'z1', name: 'Home', parent: null },
  z2: { id: 'z2', name: 'First floor', parent: 'z1' },
  z3: { id: 'z3', name: 'Garage', parent: 'z1' },
};
const SUB_HOME_A = {
  homeId: 'h_a', name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: null,
};
const SUB_HOME_B = {
  homeId: 'h_b', name: 'Garage flat', rootZoneId: 'z3', meterDeviceId: null,
};
const LEGACY_MULTI_HOME_ENABLED = 'multi_home_enabled';

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
  legacyMultiHomeEnabled?: boolean;
}): HomeMembershipService => new HomeMembershipService({
  homesStore: createHomesStore(homeyLike),
  assignmentsStore: createDeviceHomeAssignmentsStore(homeyLike),
  getZoneTree: params.getZoneTree,
  getDevices: () => params.devices,
  getLogger: () => params.logger,
  getMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: null }),
  // Most pre-existing scenarios model the formerly enabled feature. Upgrade
  // hold cases opt out explicitly below.
  legacyMultiHomeEnabled: params.legacyMultiHomeEnabled ?? true,
});

// A homey whose app carries a WIRED, non-degraded membership service (real
// stores over the mock settings seam, ZONES committed) AND the mock settings
// store — the save endpoint's HEALTHY path: the forest-root + nested-root
// checks have a known tree, and the shared degraded predicate reads a clean
// config. The service caches whatever the stores hold at construction time.
type WiredHealthyHomey = Homey.App['homey'] & {
  app: {
    homeMembership: HomeMembershipService;
    getApiStructuredLogger: () => PinoLogger | undefined;
  };
};

const MAIN_METER_ID = 'm-main-home';

const makeWiredHealthyHomey = (legacyMultiHomeEnabled = true): WiredHealthyHomey => {
  // The healthy path models the Homey Energy owner: area saves are refused
  // outright on the Flow source (and unset resolves to Flow), so an absent
  // source would turn every upsert scenario into the exclusion refusal.
  // Setting it also keeps the key list non-empty, which positively proves an
  // absent optional Main meter setting is truly unwritten, not a store-wide
  // transient miss. Flow-source scenarios seed 'flow' before calling this.
  // Gate on key presence, not on the read value: an unset key reads back as
  // `null`, and so does the Main meter's explicit "Automatic" — seeding on the
  // value would overwrite the selection scenarios below deliberately set.
  // `getKeys()` is the same authority the production readers cross-check on.
  if (!mockHomeyInstance.settings.getKeys().includes(POWER_SOURCE)) {
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
  }
  // The healthy path now includes the Main home naming its own meter: on the
  // Homey Energy source an area upsert is refused while Main is on Automatic
  // because Automatic cannot prove which physical meter belongs to Main. Tests
  // that pin a specific Main meter set it before calling this.
  if (!mockHomeyInstance.settings.getKeys().includes(HOMEY_ENERGY_METER_DEVICE_ID)) {
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, MAIN_METER_ID);
  }
  const service = makeStaticService({
    getZoneTree: () => ZONES,
    devices: [],
    legacyMultiHomeEnabled,
  });
  service.recompute();
  return {
    app: {
      homeMembership: service,
      getApiStructuredLogger: () => silentApiLogger,
    },
    settings: mockHomeyInstance.settings,
  } as unknown as WiredHealthyHomey;
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
  // A non-empty live key snapshot proves the two home-store keys are absent.
  // The empty snapshot has its own degraded-path coverage below.
  mockHomeyInstance.settings.set('test_fixture_initialized', true);
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
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [SUB_HOME_A],
    });
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
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [SUB_HOME_A],
    });
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
      timers: new TimerRegistry(),
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
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [SUB_HOME_A],
    });
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
      timers: new TimerRegistry(),
      getStructuredLogger: () => logger,
    } as unknown as AppContext;
    const onSubHomeMembershipChanged = vi.fn();
    const wiring = wireHomeMembership(
      ctxStub,
      emitter,
      { onSubHomeMembershipChanged },
    );

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
    expect(onSubHomeMembershipChanged).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it('a realtime device.update that moves the device across zones recomputes membership immediately', async () => {
    const device = addZonedHeater('z2');
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [SUB_HOME_A],
    });
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
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [SUB_HOME_A],
    });
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
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [SUB_HOME_A],
    });
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
    reloadExpectedPowerOverrides: vi.fn(),
    rebuildPlanFromCache: vi.fn().mockResolvedValue(undefined),
    refreshTargetDevicesSnapshot: vi.fn().mockResolvedValue(undefined),
    loadPowerTracker: vi.fn(),
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
      getMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: null }),
      legacyMultiHomeEnabled: true,
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
    getMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: null }),
    legacyMultiHomeEnabled: true,
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
      runtimeActive: true,
      configDegraded: false,
      mainMeterConflictAreaName: null,
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
      runtimeActive: false,
      // Nothing can vouch for the persisted config in the boot window: the
      // settings UI must refuse whole-value homes_config writes.
      configDegraded: true,
      mainMeterConflictAreaName: null,
    });
  });

  // One meter may not own two homes: the runtime fences EVERY Main-home write
  // while it does, and no other surface reports that. 2.17 had no cross-store
  // guard, so an upgraded config can arrive in exactly this state.
  it('reports the area holding Main\u2019s meter so the silent Main-home fence is visible', () => {
    createHomesStore(homeyLike).write({
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'shared_meter' }],
    });
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'shared_meter');
    const service = makeStaticService({ getZoneTree: () => ZONES, devices: [] });
    service.recompute();
    const homeyWithApp = {
      app: { homeMembership: service }, settings: mockHomeyInstance.settings,
    } as unknown as Homey.App['homey'];

    expect(getSettingsUiHomesPayload({ homey: homeyWithApp }).mainMeterConflictAreaName)
      .toBe('Upstairs');

    // Main on its own meter is the healthy configuration.
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'main_meter');
    expect(getSettingsUiHomesPayload({ homey: homeyWithApp }).mainMeterConflictAreaName)
      .toBeNull();

    // The Flow source carries no meter identity, so the selection lies dormant
    // and the runtime does not fence: claiming a clash there would be a false
    // alarm on a config that is doing nothing.
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'shared_meter');
    mockHomeyInstance.settings.set(POWER_SOURCE, 'flow');
    expect(getSettingsUiHomesPayload({ homey: homeyWithApp }).mainMeterConflictAreaName)
      .toBeNull();

    // A degraded snapshot serves a RETAINED subHomes cache of an unknown
    // persisted truth; combining it with live meter settings could name an
    // obsolete area. No clash may be claimed from an unvouched-for roster.
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(DEVICE_HOME_ASSIGNMENTS, 'not-a-pins-blob');
    service.recompute();
    expect(service.getDiagnostics().configDegraded).toBe(true);
    expect(getSettingsUiHomesPayload({ homey: homeyWithApp }).mainMeterConflictAreaName)
      .toBeNull();
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

  it('refuses stale upserts that would assign one meter to two areas', () => {
    const homeyWired = makeWiredHealthyHomey();
    // Both panels fetched the same empty list and independently chose m1.
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: 'm1' } },
    })).toEqual({ ok: true });
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'Garage flat', rootZoneId: 'z3', meterDeviceId: 'm1' } },
    })).toEqual({ ok: false, reason: 'invalid' });

    const read = createHomesStore(homeyLike).read();
    expect(read.state === 'present' && read.value.subHomes).toHaveLength(1);
    expect(read.state === 'present' && read.value.subHomes[0]).toMatchObject({
      name: 'Upstairs',
      meterDeviceId: 'm1',
    });
  });

  it('refuses an area upsert that reuses Main’s explicit meter before any config side effect', () => {
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'm-main');
    const homeyWired = makeWiredHealthyHomey();
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set');

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: {
        op: 'upsert',
        area: { name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: 'm-main' },
      },
    })).toEqual({ ok: false, reason: 'invalid' });

    expect(createHomesStore(homeyLike).read()).toEqual({ state: 'unwritten' });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['an existing Main meter key returns undefined', false],
    ['the settings key list is transiently empty', true],
  ])('refuses an area upsert as degraded before side effects when %s', (_label, emptyKeyList) => {
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'm-main');
    const homeyWired = makeWiredHealthyHomey();
    const originalGet = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
    const originalGetKeys = mockHomeyInstance.settings.getKeys.bind(mockHomeyInstance.settings);
    vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementation((key) => (
      key === HOMEY_ENERGY_METER_DEVICE_ID ? undefined : originalGet(key)
    ));
    if (emptyKeyList) {
      vi.spyOn(mockHomeyInstance.settings, 'getKeys').mockReturnValue([]);
    } else {
      vi.spyOn(mockHomeyInstance.settings, 'getKeys').mockImplementation(originalGetKeys);
    }
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set');

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: {
        op: 'upsert',
        area: { name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: 'm-sub' },
      },
    })).toEqual({ ok: false, reason: 'degraded' });

    expect(createHomesStore(homeyLike).read()).toEqual({
      state: emptyKeyList ? 'suspect' : 'unwritten',
    });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('refuses an area upsert while the Main home is still on Automatic (Homey Energy)', () => {
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, null);
    const homeyWired = makeWiredHealthyHomey();
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set');

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: 'm-sub' } },
    })).toEqual({ ok: false, reason: 'main_meter_required' });
    expect(createHomesStore(homeyLike).read()).toEqual({ state: 'unwritten' });
    expect(setSpy).not.toHaveBeenCalled();

    // Naming Main's own meter unblocks exactly the same save.
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, MAIN_METER_ID);
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: 'm-sub' } },
    })).toEqual({ ok: true });
  });

  it('refuses honestly when the whole-home meter is a proven id-less aggregate', () => {
    // The membership service latched the transport's proof that the report's
    // only cumulative item carries no id: main_meter_required would name a
    // remedy the picker can never satisfy, so the refusal states the situation.
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, null);
    const homeyWired = makeWiredHealthyHomey();
    homeyWired.app.homeMembership.noteHomeMeterArrangement('idless_aggregate_only');

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: 'm-sub' } },
    })).toEqual({ ok: false, reason: 'meter_unnameable' });
    expect(createHomesStore(homeyLike).read()).toEqual({ state: 'unwritten' });

    // An SDK miss or ambiguous read must never flip the proven arrangement in
    // either direction: the honest refusal stands.
    homeyWired.app.homeMembership.noteHomeMeterArrangement('unproven');
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: 'm-sub' } },
    })).toEqual({ ok: false, reason: 'meter_unnameable' });

    // A later read proving an id-bearing whole-home meter restores the
    // ordinary remedy — the picker can offer it now.
    homeyWired.app.homeMembership.noteHomeMeterArrangement('identified');
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: 'm-sub' } },
    })).toEqual({ ok: false, reason: 'main_meter_required' });
  });

  it('refuses an area save on the Flow source, whatever the Main meter says', () => {
    // Mutual exclusion, area side: a Flow reading carries no meter identity,
    // so the area would never receive samples. An explicitly named Main meter
    // does not soften it.
    mockHomeyInstance.settings.set(POWER_SOURCE, 'flow');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, MAIN_METER_ID);
    const homeyWired = makeWiredHealthyHomey();
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set');

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: 'm-sub' } },
    })).toEqual({ ok: false, reason: 'homey_energy_required' });
    expect(createHomesStore(homeyLike).read()).toEqual({ state: 'unwritten' });
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();

    // On Automatic the refusal must be the SAME one: main_meter_required would
    // name the whole-home meter picker, which is hidden on the Flow source,
    // so the source refusal wins the ordering.
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, null);
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: 'm-sub' } },
    })).toEqual({ ok: false, reason: 'homey_energy_required' });

    // Switching the source (with Main named) unblocks exactly the same save.
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, MAIN_METER_ID);
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: 'm-sub' } },
    })).toEqual({ ok: true });
  });

  it('keeps delete as the Flow-source escape hatch while edits stay refused', () => {
    // A config that predates the exclusion: areas saved, source now Flow. The
    // refusal copy says "remove your meter areas first", so removal must work
    // on any source; an edit would keep an unmeasurable area alive.
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-sub' }],
    });
    mockHomeyInstance.settings.set(POWER_SOURCE, 'flow');
    const homeyWired = makeWiredHealthyHomey();

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: {
        op: 'upsert',
        area: {
          homeId: SUB_HOME_A.homeId, name: 'Renamed', rootZoneId: 'z2', meterDeviceId: 'm-sub',
        },
      },
    })).toEqual({ ok: false, reason: 'homey_energy_required' });

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired, body: { op: 'delete', homeId: SUB_HOME_A.homeId },
    })).toEqual({ ok: true });
    const read = createHomesStore(homeyLike).read();
    expect(read.state === 'present' && read.value.subHomes).toEqual([]);
  });

  it('refuses switching the power source to Flow while meter areas are running', () => {
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-sub' }],
    });
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, MAIN_METER_ID);
    const homeyWired = makeWiredHealthyHomey();

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired, body: { op: 'set_power_source', source: 'flow' },
    })).toEqual({ ok: false, reason: 'homey_energy_required' });
    expect(mockHomeyInstance.settings.get(POWER_SOURCE)).toBe('homey_energy');

    // Removing the last area unblocks exactly the same switch.
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired, body: { op: 'delete', homeId: SUB_HOME_A.homeId },
    })).toEqual({ ok: true });
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired, body: { op: 'set_power_source', source: 'flow' },
    })).toEqual({ ok: true });
    expect(mockHomeyInstance.settings.get(POWER_SOURCE)).toBe('flow');
  });

  it('lets a dormant (never-activated) config through the Flow switch and never blocks Homey Energy', () => {
    // Marker-less config with the legacy flag latched false: multi-home is
    // deliberately holding the saved pre-GA areas dormant, so they are not
    // running and must not block the switch.
    createHomesStore(homeyLike).write({
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-sub' }],
    });
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    const homeyWired = makeWiredHealthyHomey(false);
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired, body: { op: 'set_power_source', source: 'flow' },
    })).toEqual({ ok: true });
    expect(mockHomeyInstance.settings.get(POWER_SOURCE)).toBe('flow');

    // Switching TO Homey Energy is the remedy direction: allowed even while
    // areas are running (a legacy Flow-saved config's only road back).
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-sub' }],
    });
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired, body: { op: 'set_power_source', source: 'homey_energy' },
    })).toEqual({ ok: true });
    expect(mockHomeyInstance.settings.get(POWER_SOURCE)).toBe('homey_energy');
  });

  it('still refuses Flow when a marker-less config is running via the latched legacy flag', () => {
    createHomesStore(homeyLike).write({
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-sub' }],
    });
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    const homeyWired = makeWiredHealthyHomey(true);
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired, body: { op: 'set_power_source', source: 'flow' },
    })).toEqual({ ok: false, reason: 'homey_energy_required' });
    expect(mockHomeyInstance.settings.get(POWER_SOURCE)).toBe('homey_energy');
  });

  it('answers the Flow switch from the fresh read in the boot window, and refuses to guess without the marker', () => {
    // Marker-activated config: the proof travels in the same read as subHomes,
    // so even an unwired membership service refuses with the specific reason.
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-sub' }],
    });
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    expect(saveSettingsUiHomesConfig({
      homey: homeyNoService, body: { op: 'set_power_source', source: 'flow' },
    })).toEqual({ ok: false, reason: 'homey_energy_required' });

    // No marker: activation may still come from the retired legacy flag, and
    // that answer is the unwired membership service's — neither yes nor no
    // may be guessed.
    createHomesStore(homeyLike).write({
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-sub' }],
    });
    expect(saveSettingsUiHomesConfig({
      homey: homeyNoService, body: { op: 'set_power_source', source: 'flow' },
    })).toEqual({ ok: false, reason: 'degraded' });
    expect(mockHomeyInstance.settings.get(POWER_SOURCE)).toBe('homey_energy');

    // Homey Energy needs no area answer, so the boot window never blocks it.
    expect(saveSettingsUiHomesConfig({
      homey: homeyNoService, body: { op: 'set_power_source', source: 'homey_energy' },
    })).toEqual({ ok: true });
  });

  it('refuses the Flow switch as degraded when the homes store reads suspect', () => {
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMES_CONFIG, 'not-a-homes-config');
    expect(saveSettingsUiHomesConfig({
      homey: homeyNoService, body: { op: 'set_power_source', source: 'flow' },
    })).toEqual({ ok: false, reason: 'degraded' });
    expect(mockHomeyInstance.settings.get(POWER_SOURCE)).toBe('homey_energy');
  });

  it('refuses a malformed power-source payload instead of coercing a default', () => {
    const homeyWired = makeWiredHealthyHomey();
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired, body: { op: 'set_power_source', source: 'garbage' },
    })).toEqual({ ok: false, reason: 'invalid' });
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired, body: { op: 'set_power_source' },
    })).toEqual({ ok: false, reason: 'invalid' });
    expect(mockHomeyInstance.settings.get(POWER_SOURCE)).toBe('homey_energy');
  });

  it('refuses an area upsert on a suspect power-source read rather than guessing the source', () => {
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, null);
    const homeyWired = makeWiredHealthyHomey();
    const originalGet = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
    vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementation((key) => (
      key === POWER_SOURCE ? undefined : originalGet(key)
    ));

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: 'm-sub' } },
    })).toEqual({ ok: false, reason: 'degraded' });
    expect(createHomesStore(homeyLike).read()).toEqual({ state: 'unwritten' });
  });

  it('refuses going back to Automatic while meter areas exist', () => {
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-sub' }],
    });
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, MAIN_METER_ID);
    const homeyWired = makeWiredHealthyHomey();

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired, body: { op: 'set_main_meter', meterDeviceId: null },
    })).toEqual({ ok: false, reason: 'main_meter_required' });
    expect(mockHomeyInstance.settings.get(HOMEY_ENERGY_METER_DEVICE_ID)).toBe(MAIN_METER_ID);

    // Removing the last area makes Automatic selectable again.
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired, body: { op: 'delete', homeId: SUB_HOME_A.homeId },
    })).toEqual({ ok: true });
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired, body: { op: 'set_main_meter', meterDeviceId: null },
    })).toEqual({ ok: true });
    expect(mockHomeyInstance.settings.get(HOMEY_ENERGY_METER_DEVICE_ID)).toBeNull();
  });

  it('still refuses Automatic when the legacy activation flag read throws', () => {
    // A legacy-enabled pre-GA config (flag true, areas present, no
    // activationVersion) IS running. Re-reading `multi_home_enabled` here would
    // fail closed to false and silently permit the save; the answer comes from
    // the membership service, which latched it at wiring time.
    createHomesStore(homeyLike).write({
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-sub' }],
    });
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, MAIN_METER_ID);
    const homeyWired = makeWiredHealthyHomey(true);
    const originalGet = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
    vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementation((key) => {
      if (key === LEGACY_MULTI_HOME_ENABLED) throw new Error('settings read failed');
      return originalGet(key);
    });

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired, body: { op: 'set_main_meter', meterDeviceId: null },
    })).toEqual({ ok: false, reason: 'main_meter_required' });
    expect(mockHomeyInstance.settings.get(HOMEY_ENERGY_METER_DEVICE_ID)).toBe(MAIN_METER_ID);
  });

  it('logs every refusal with its op and reason so a support report is diagnosable', () => {
    const info = vi.fn();
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, null);
    const service = makeStaticService({ getZoneTree: () => ZONES, devices: [] });
    service.recompute();
    const homeyWired = {
      app: {
        homeMembership: service,
        getApiStructuredLogger: () => ({ ...silentApiLogger, info } as unknown as PinoLogger),
      },
      settings: mockHomeyInstance.settings,
    } as unknown as Homey.App['homey'];

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: 'm-sub' } },
    })).toEqual({ ok: false, reason: 'main_meter_required' });
    expect(saveSettingsUiHomesConfig({ homey: homeyWired, body: { nonsense: true } }))
      .toEqual({ ok: false, reason: 'invalid' });

    expect(info.mock.calls.map(([fields]) => fields)).toEqual([
      { event: 'homes_save_refused', op: 'upsert', reason: 'main_meter_required' },
      { event: 'homes_save_refused', op: 'unparsed', reason: 'invalid' },
    ]);

    // An applied op logs nothing, and a throwing logger never changes a refusal.
    info.mockClear();
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, MAIN_METER_ID);
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'Upstairs', rootZoneId: 'z2', meterDeviceId: 'm-sub' } },
    })).toEqual({ ok: true });
    expect(info).not.toHaveBeenCalled();
    info.mockImplementation(() => { throw new Error('logger down'); });
    expect(saveSettingsUiHomesConfig({ homey: homeyWired, body: { op: 'nope' } }))
      .toEqual({ ok: false, reason: 'invalid' });
  });

  it('answers Automatic from the fresh read while no membership service is wired', () => {
    // A marker-activated config proves "areas are running" atomically with the
    // subHomes read itself, so even the boot window refuses with the specific
    // remedy rather than punting to degraded.
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-sub' }],
    });
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, MAIN_METER_ID);
    expect(saveSettingsUiHomesConfig({
      homey: homeyNoService, body: { op: 'set_main_meter', meterDeviceId: null },
    })).toEqual({ ok: false, reason: 'main_meter_required' });

    // Without the marker, activation may still come from the retired legacy
    // flag — that answer is the membership service's, and it is not wired, so
    // neither yes nor no may be guessed.
    createHomesStore(homeyLike).write({
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-sub' }],
    });
    expect(saveSettingsUiHomesConfig({
      homey: homeyNoService, body: { op: 'set_main_meter', meterDeviceId: null },
    })).toEqual({ ok: false, reason: 'degraded' });
    // Picking an explicit meter — the remedy every refusal names — still works.
    expect(saveSettingsUiHomesConfig({
      homey: homeyNoService, body: { op: 'set_main_meter', meterDeviceId: 'm-other' },
    })).toEqual({ ok: true });
  });

  it('refuses Automatic from the fresh read while the activation snapshot is degraded', () => {
    // The service's only recompute saw a suspect homes read, so `runtimeActive`
    // is still the field's initial `false` while `configDegraded` is true. That
    // `false` is a stale non-answer, not "areas are not running".
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-sub' }],
    });
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, MAIN_METER_ID);
    mockHomeyInstance.settings.set(HOMES_CONFIG, 'not-a-homes-config');
    const service = makeStaticService({ getZoneTree: () => ZONES, devices: [] });
    service.recompute();
    expect(service.getDiagnostics()).toMatchObject({ configDegraded: true, runtimeActive: false });
    const homeyWired = {
      app: { homeMembership: service, getApiStructuredLogger: () => silentApiLogger },
      settings: mockHomeyInstance.settings,
    } as unknown as Homey.App['homey'];

    // The store recovers before the next recompute, so the save seam's own
    // fresh read sees an ACTIVATED (marker-carrying) config with an area while
    // the cached activation snapshot still reads "not running". The marker
    // rides the same fresh read as the area list, so the refusal is the
    // specific one, not a degraded punt.
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-sub' }],
    });
    expect(service.getDiagnostics().runtimeActive).toBe(false);

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired, body: { op: 'set_main_meter', meterDeviceId: null },
    })).toEqual({ ok: false, reason: 'main_meter_required' });
    expect(mockHomeyInstance.settings.get(HOMEY_ENERGY_METER_DEVICE_ID)).toBe(MAIN_METER_ID);

    // A markerless (legacy-activation-candidate) config cannot be answered
    // from the fresh read; the degraded snapshot then refuses as degraded.
    createHomesStore(homeyLike).write({
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-sub' }],
    });
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired, body: { op: 'set_main_meter', meterDeviceId: null },
    })).toEqual({ ok: false, reason: 'degraded' });
    expect(mockHomeyInstance.settings.get(HOMEY_ENERGY_METER_DEVICE_ID)).toBe(MAIN_METER_ID);

    // Picking an explicit meter is never gated on activation: the remedy every
    // other refusal names must stay reachable while diagnostics are degraded.
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired, body: { op: 'set_main_meter', meterDeviceId: 'm-other' },
    })).toEqual({ ok: true });
    expect(mockHomeyInstance.settings.get(HOMEY_ENERGY_METER_DEVICE_ID)).toBe('m-other');
  });

  it('refuses Automatic in the window between an activating upsert and its recompute', () => {
    // The exact TOCTOU: a dormant config is activated by Edit → Save (every
    // upsert stamps the activation marker), and a set_main_meter arrives while
    // the recompute that upsert queued is still pending — the latched snapshot
    // is HEALTHY and still says "not running". The static service here never
    // recomputes on settings changes, which models that window exactly.
    createHomesStore(homeyLike).write({
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-sub' }],
    });
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, MAIN_METER_ID);
    const service = makeStaticService({
      getZoneTree: () => ZONES, devices: [], legacyMultiHomeEnabled: false,
    });
    service.recompute();
    expect(service.getDiagnostics()).toMatchObject({ configDegraded: false, runtimeActive: false });
    const homeyWired = {
      app: { homeMembership: service, getApiStructuredLogger: () => silentApiLogger },
      settings: mockHomeyInstance.settings,
    } as unknown as Homey.App['homey'];

    // Edit → Save activates the held config through the real seam.
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { ...SUB_HOME_A, meterDeviceId: 'm-sub' } },
    })).toEqual({ ok: true });
    // The race window: the store carries the marker, the snapshot does not.
    expect(service.getDiagnostics().runtimeActive).toBe(false);

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired, body: { op: 'set_main_meter', meterDeviceId: null },
    })).toEqual({ ok: false, reason: 'main_meter_required' });
    expect(mockHomeyInstance.settings.get(HOMEY_ENERGY_METER_DEVICE_ID)).toBe(MAIN_METER_ID);
  });

  it('still allows Automatic while a pre-GA area config is held dormant', () => {
    // No activationVersion and no legacy flag: multi-home is not running, so
    // the combined total IS the whole home and Automatic is the right answer.
    createHomesStore(homeyLike).write({
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-sub' }],
    });
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, MAIN_METER_ID);

    expect(saveSettingsUiHomesConfig({
      homey: makeWiredHealthyHomey(false), body: { op: 'set_main_meter', meterDeviceId: null },
    })).toEqual({ ok: true });
    expect(mockHomeyInstance.settings.get(HOMEY_ENERGY_METER_DEVICE_ID)).toBeNull();
  });

  it('judges the name of the area being written, not a legacy name elsewhere', () => {
    // Names that predate the rules (nothing enforced them before) must not
    // refuse an unrelated, compliant edit with copy about an unseen area.
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [
        { homeId: 'h_legacy', name: 'Main home', rootZoneId: 'z2', meterDeviceId: 'm-legacy' },
        { ...SUB_HOME_B, meterDeviceId: 'm-b' },
      ],
    });
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, MAIN_METER_ID);
    const homeyWired = makeWiredHealthyHomey();

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { ...SUB_HOME_B, meterDeviceId: 'm-b', name: 'Garage flat 2' } },
    })).toEqual({ ok: true });
    // Rewriting the offending entry itself is still refused.
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: {
        op: 'upsert',
        area: {
          homeId: 'h_legacy', name: 'Main home', rootZoneId: 'z2', meterDeviceId: 'm-legacy',
        },
      },
    })).toEqual({ ok: false, reason: 'name_reserved', reservedName: 'Main home' });
  });

  it('enforces the area name rules server-side, not only in the editor', () => {
    const homeyWired = makeWiredHealthyHomey();
    const upsertNamed = (name: string, meterDeviceId: string, rootZoneId = 'z2') => (
      saveSettingsUiHomesConfig({
        homey: homeyWired, body: { op: 'upsert', area: { name, rootZoneId, meterDeviceId } },
      })
    );

    expect(upsertNamed('   ', 'm1')).toEqual({ ok: false, reason: 'name_required' });
    expect(upsertNamed('a'.repeat(41), 'm1')).toEqual({
      ok: false, reason: 'name_too_long', maxLength: 40,
    });
    expect(upsertNamed('main HOME', 'm1')).toEqual({
      ok: false, reason: 'name_reserved', reservedName: 'Main home',
    });
    expect(createHomesStore(homeyLike).read()).toEqual({ state: 'unwritten' });

    // A saved area's name then blocks a case-variant duplicate in another zone.
    expect(upsertNamed('  Garage flat  ', 'm1')).toEqual({ ok: true });
    expect(upsertNamed('GARAGE FLAT', 'm2', 'z3')).toEqual({
      ok: false, reason: 'name_duplicate', otherName: 'Garage flat',
    });
    const read = createHomesStore(homeyLike).read();
    // The persisted name is the trimmed one the rules judged.
    expect(read.state === 'present' && read.value.subHomes.map(({ name }) => name))
      .toEqual(['Garage flat']);
  });

  it('caps the number of meter areas but still allows editing one at the cap', () => {
    // Nine disjoint sibling zones so the cap, not root overlap, is what speaks.
    const capZones: ZoneTree = {
      z1: { id: 'z1', name: 'Home', parent: null },
      ...Object.fromEntries(Array.from({ length: 9 }, (_unused, index) => [
        `zc${index}`, { id: `zc${index}`, name: `Zone ${index}`, parent: 'z1' },
      ])),
    };
    const atCap = Array.from({ length: 8 }, (_unused, index) => ({
      homeId: `h_cap${index}`,
      name: `Area ${index}`,
      rootZoneId: `zc${index}`,
      meterDeviceId: `m-cap${index}`,
    }));
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: atCap,
    });
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, MAIN_METER_ID);
    const service = makeStaticService({ getZoneTree: () => capZones, devices: [] });
    service.recompute();
    const homeyWired = {
      app: { homeMembership: service, getApiStructuredLogger: () => silentApiLogger },
      settings: mockHomeyInstance.settings,
    } as unknown as Homey.App['homey'];

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'One too many', rootZoneId: 'zc8', meterDeviceId: 'm-extra' } },
    })).toEqual({ ok: false, reason: 'area_limit_reached', maxCount: 8 });

    // Editing an existing area does not grow the list, so it stays allowed.
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { ...atCap[0], name: 'Renamed at the cap' } },
    })).toEqual({ ok: true });
  });

  it('lets an over-cap config repair an area without deleting one first', () => {
    // Nothing capped `homes_config` before this seam did, so an upgraded
    // install can hold more areas than the cap. The cap bounds GROWTH; a rename
    // or a re-meter of an existing area must not be a dead end.
    const capZones: ZoneTree = {
      z1: { id: 'z1', name: 'Home', parent: null },
      ...Object.fromEntries(Array.from({ length: 10 }, (_unused, index) => [
        `zo${index}`, { id: `zo${index}`, name: `Zone ${index}`, parent: 'z1' },
      ])),
    };
    const overCap = Array.from({ length: 9 }, (_unused, index) => ({
      homeId: `h_over${index}`,
      name: `Area ${index}`,
      rootZoneId: `zo${index}`,
      meterDeviceId: `m-over${index}`,
    }));
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: overCap,
    });
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, MAIN_METER_ID);
    const service = makeStaticService({ getZoneTree: () => capZones, devices: [] });
    service.recompute();
    const homeyWired = {
      app: { homeMembership: service, getApiStructuredLogger: () => silentApiLogger },
      settings: mockHomeyInstance.settings,
    } as unknown as Homey.App['homey'];

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { ...overCap[0], name: 'Repaired', meterDeviceId: 'm-fixed' } },
    })).toEqual({ ok: true });
    const read = createHomesStore(homeyLike).read();
    expect(read.state === 'present' && read.value.subHomes).toHaveLength(9);
    expect(read.state === 'present' && read.value.subHomes[0])
      .toMatchObject({ name: 'Repaired', meterDeviceId: 'm-fixed' });

    // Growing it further is still refused.
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'upsert', area: { name: 'One more', rootZoneId: 'zo9', meterDeviceId: 'm-extra' } },
    })).toEqual({ ok: false, reason: 'area_limit_reached', maxCount: 8 });
  });

  it('refuses a later Main-meter selection owned by an area and normalizes accepted ids', async () => {
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-shared' }],
    });
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'm-original');
    const homeyWired = makeWiredHealthyHomey();

    await expect(api.ui_homes_save({
      homey: homeyWired,
      body: { op: 'set_main_meter', meterDeviceId: 'm-shared' },
    })).resolves.toEqual({ ok: false, reason: 'meter_in_use', otherName: 'Upstairs' });
    expect(mockHomeyInstance.settings.get(HOMEY_ENERGY_METER_DEVICE_ID)).toBe('m-original');

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'set_main_meter', meterDeviceId: '  m-main  ' },
    })).toEqual({ ok: true });
    expect(mockHomeyInstance.settings.get(HOMEY_ENERGY_METER_DEVICE_ID)).toBe('m-main');

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'set_main_meter', meterDeviceId: '   ' },
    })).toEqual({ ok: false, reason: 'invalid' });
    expect(mockHomeyInstance.settings.get(HOMEY_ENERGY_METER_DEVICE_ID)).toBe('m-main');

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'set_main_meter', meterDeviceId: 'meter|other' },
    })).toEqual({ ok: false, reason: 'invalid' });
    expect(mockHomeyInstance.settings.get(HOMEY_ENERGY_METER_DEVICE_ID)).toBe('m-main');
  });

  it('clears tracker freshness before committing a meter reassignment and keeps accounting', () => {
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [SUB_HOME_A],
    });
    const trackerKey = `${POWER_TRACKER_STATE}:${SUB_HOME_A.homeId}`;
    const tracker: PowerTrackerState = {
      lastTimestamp: 1_700_000_000_000,
      lastPowerW: 2_400,
      buckets: { '2026-01-15T12': 2.5 },
      dailyTotals: { '2026-01-14': 7.25 },
    };
    mockHomeyInstance.settings.set(trackerKey, tracker);
    const homeyWired = makeWiredHealthyHomey();
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set');

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: {
        op: 'upsert',
        area: {
          ...SUB_HOME_A,
          meterDeviceId: 'replacement-meter',
        },
      },
    })).toEqual({ ok: true });

    const trackerWriteIndex = setSpy.mock.calls.findIndex(([key]) => key === trackerKey);
    const configWriteIndex = setSpy.mock.calls.findIndex(([key]) => key === HOMES_CONFIG);
    expect(trackerWriteIndex).toBeGreaterThanOrEqual(0);
    expect(configWriteIndex).toBeGreaterThan(trackerWriteIndex);
    const reset = mockHomeyInstance.settings.get(trackerKey) as PowerTrackerState;
    expect(reset.lastTimestamp).toBeUndefined();
    expect(reset.lastPowerW).toBeUndefined();
    expect(reset.buckets).toEqual(tracker.buckets);
    expect(reset.dailyTotals).toEqual(tracker.dailyTotals);
  });

  it('restores tracker freshness after a config write mutates and then throws', () => {
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [SUB_HOME_A],
    });
    const trackerKey = `${POWER_TRACKER_STATE}:${SUB_HOME_A.homeId}`;
    const tracker: PowerTrackerState = {
      lastTimestamp: 1_700_000_000_000,
      lastPowerW: 2_400,
      buckets: { '2026-01-15T12': 2.5 },
      dailyTotals: { '2026-01-14': 7.25 },
    };
    mockHomeyInstance.settings.set(trackerKey, tracker);
    const homeyWired = makeWiredHealthyHomey();
    const apiLogger = makeLoggerSpy();
    homeyWired.app.getApiStructuredLogger = () => apiLogger.logger;
    const originalSet = mockHomeyInstance.settings.set.bind(mockHomeyInstance.settings);
    let configWriteAttempts = 0;
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set').mockImplementation((key, value) => {
      if (key === HOMES_CONFIG) {
        originalSet(key, value);
        if (configWriteAttempts++ === 0) {
          throw new Error('config write unavailable after mutation');
        }
        return;
      }
      originalSet(key, value);
    });

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: {
        op: 'upsert',
        area: {
          ...SUB_HOME_A,
          meterDeviceId: 'replacement-meter',
        },
      },
    })).toEqual({ ok: false, reason: 'degraded' });

    const trackerWrites = setSpy.mock.calls.filter(([key]) => key === trackerKey);
    expect(setSpy.mock.calls.filter(([key]) => key === HOMES_CONFIG)).toHaveLength(2);
    expect(trackerWrites).toHaveLength(2);
    expect(trackerWrites[0]?.[1]).toMatchObject({
      lastTimestamp: undefined,
      lastPowerW: undefined,
    });
    expect(trackerWrites[1]?.[1]).toEqual(tracker);
    expect(mockHomeyInstance.settings.get(trackerKey)).toEqual(tracker);
    const config = createHomesStore(homeyLike).read();
    expect(config.state === 'present' && config.value).toEqual({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [SUB_HOME_A],
    });
    expect(apiLogger.error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'home_tracker_config_commit_failed',
      phase: 'config_write',
    }));
  });

  it('repairs a marker-first first-save failure so a later save can retry', () => {
    const trackerKey = `${POWER_TRACKER_STATE}:${SUB_HOME_A.homeId}`;
    const tracker: PowerTrackerState = {
      lastTimestamp: 1_700_000_000_000,
      lastPowerW: 2_400,
      dailyTotals: { '2026-01-14': 7.25 },
    };
    mockHomeyInstance.settings.set(trackerKey, tracker);
    const homeyWired = makeWiredHealthyHomey(false);
    const originalSet = mockHomeyInstance.settings.set.bind(mockHomeyInstance.settings);
    let configWriteAttempts = 0;
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set').mockImplementation((key, value) => {
      if (key === HOMES_CONFIG && configWriteAttempts++ === 0) {
        throw new Error('first config value write unavailable');
      }
      originalSet(key, value);
    });
    const request = {
      op: 'upsert',
      area: SUB_HOME_A,
    } as const;

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: request,
    })).toEqual({ ok: false, reason: 'degraded' });

    expect(createHomesStore(homeyLike).read()).toEqual({
      state: 'present',
      value: { subHomes: [] },
    });
    expect(mockHomeyInstance.settings.get(trackerKey)).toEqual(tracker);

    setSpy.mockRestore();
    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: request,
    })).toEqual({ ok: true });
    expect(createHomesStore(homeyLike).read()).toEqual({
      state: 'present',
      value: {
        activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
        subHomes: [SUB_HOME_A],
      },
    });
  });

  it('retains the safe tracker reset when config compensation is unavailable', () => {
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [SUB_HOME_A],
    });
    const trackerKey = `${POWER_TRACKER_STATE}:${SUB_HOME_A.homeId}`;
    const tracker: PowerTrackerState = {
      lastTimestamp: 1_700_000_000_000,
      lastPowerW: 2_400,
      buckets: { '2026-01-15T12': 2.5 },
    };
    mockHomeyInstance.settings.set(trackerKey, tracker);
    const homeyWired = makeWiredHealthyHomey();
    const apiLogger = makeLoggerSpy();
    apiLogger.error.mockImplementation(() => { throw new Error('logger unavailable'); });
    homeyWired.app.getApiStructuredLogger = () => apiLogger.logger;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(noop);
    const originalSet = mockHomeyInstance.settings.set.bind(mockHomeyInstance.settings);
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set').mockImplementation((key, value) => {
      if (key === HOMES_CONFIG) throw new Error('config write unavailable');
      originalSet(key, value);
    });

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: {
        op: 'upsert',
        area: {
          ...SUB_HOME_A,
          meterDeviceId: 'replacement-meter',
        },
      },
    })).toEqual({ ok: false, reason: 'degraded' });

    const trackerWrites = setSpy.mock.calls.filter(([key]) => key === trackerKey);
    expect(setSpy.mock.calls.filter(([key]) => key === HOMES_CONFIG)).toHaveLength(2);
    expect(trackerWrites).toHaveLength(1);
    expect(mockHomeyInstance.settings.get(trackerKey)).toEqual({
      ...tracker,
      lastTimestamp: undefined,
      lastPowerW: undefined,
    });
    expect(apiLogger.error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'home_tracker_config_commit_failed',
      phase: 'config_write',
    }));
    expect(apiLogger.error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'home_tracker_config_commit_failed',
      phase: 'config_compensation',
    }));
    expect(consoleError).toHaveBeenCalledWith(
      'settings UI homes config logger failed',
      expect.objectContaining({ phase: 'config_write' }),
      expect.any(Error),
    );
  });

  it('restores tracker state when its reset mutates before throwing', () => {
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [SUB_HOME_A],
    });
    const trackerKey = `${POWER_TRACKER_STATE}:${SUB_HOME_A.homeId}`;
    const tracker: PowerTrackerState = {
      lastTimestamp: 1_700_000_000_000,
      lastPowerW: 2_400,
      dailyTotals: { '2026-01-14': 7.25 },
    };
    mockHomeyInstance.settings.set(trackerKey, tracker);
    const homeyWired = makeWiredHealthyHomey();
    const apiLogger = makeLoggerSpy();
    homeyWired.app.getApiStructuredLogger = () => apiLogger.logger;
    const originalSet = mockHomeyInstance.settings.set.bind(mockHomeyInstance.settings);
    let trackerWriteAttempts = 0;
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set').mockImplementation((key, value) => {
      originalSet(key, value);
      if (key === trackerKey && trackerWriteAttempts++ === 0) {
        throw new Error('tracker reset reported unavailable');
      }
    });

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: {
        op: 'upsert',
        area: {
          ...SUB_HOME_A,
          meterDeviceId: 'replacement-meter',
        },
      },
    })).toEqual({ ok: false, reason: 'degraded' });

    expect(setSpy.mock.calls.filter(([key]) => key === trackerKey)).toHaveLength(2);
    expect(setSpy.mock.calls.filter(([key]) => key === HOMES_CONFIG)).toHaveLength(0);
    expect(mockHomeyInstance.settings.get(trackerKey)).toEqual(tracker);
    expect(apiLogger.error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'home_tracker_config_commit_failed',
      phase: 'tracker_reset',
      homeId: SUB_HOME_A.homeId,
    }));
  });

  it('attempts every tracker rollback and stays degraded when one restore fails', () => {
    const currentConfig: HomeConfig = {
      subHomes: [SUB_HOME_A, SUB_HOME_B],
    };
    createHomesStore(homeyLike).write(currentConfig);
    const trackerKeys = [
      `${POWER_TRACKER_STATE}:${SUB_HOME_A.homeId}`,
      `${POWER_TRACKER_STATE}:${SUB_HOME_B.homeId}`,
    ] as const;
    const trackers: readonly PowerTrackerState[] = [
      { lastTimestamp: 1_700_000_000_000, lastPowerW: 2_400 },
      { lastTimestamp: 1_700_000_100_000, lastPowerW: 1_200 },
    ];
    mockHomeyInstance.settings.set(trackerKeys[0], trackers[0]);
    mockHomeyInstance.settings.set(trackerKeys[1], trackers[1]);
    const homeyWired = makeWiredHealthyHomey(false);
    const apiLogger = makeLoggerSpy();
    homeyWired.app.getApiStructuredLogger = () => apiLogger.logger;
    const originalSet = mockHomeyInstance.settings.set.bind(mockHomeyInstance.settings);
    const trackerWriteAttempts = new Map<string, number>();
    let configWriteAttempts = 0;
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set').mockImplementation((key, value) => {
      if (key === HOMES_CONFIG && configWriteAttempts++ === 0) {
        throw new Error('config write unavailable');
      }
      if (trackerKeys.includes(key as (typeof trackerKeys)[number])) {
        const attempt = trackerWriteAttempts.get(key) ?? 0;
        trackerWriteAttempts.set(key, attempt + 1);
        if (key === trackerKeys[1] && attempt === 1) {
          throw new Error('tracker restore unavailable');
        }
      }
      originalSet(key, value);
    });

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: {
        op: 'upsert',
        area: { ...SUB_HOME_A, name: 'Renamed upstairs' },
      },
    })).toEqual({ ok: false, reason: 'degraded' });

    expect(setSpy.mock.calls.filter(([key]) => key === trackerKeys[0])).toHaveLength(2);
    expect(setSpy.mock.calls.filter(([key]) => key === trackerKeys[1])).toHaveLength(2);
    expect(mockHomeyInstance.settings.get(trackerKeys[0])).toEqual(trackers[0]);
    expect(mockHomeyInstance.settings.get(trackerKeys[1])).toEqual({
      ...trackers[1],
      lastTimestamp: undefined,
      lastPowerW: undefined,
    });
    expect(createHomesStore(homeyLike).read()).toEqual({
      state: 'present',
      value: currentConfig,
    });
    expect(apiLogger.error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'home_tracker_config_commit_failed',
      phase: 'tracker_restore',
      homeId: SUB_HOME_B.homeId,
    }));
  });

  it('restores earlier tracker resets when a later reset cannot be prepared', () => {
    const currentConfig: HomeConfig = {
      subHomes: [SUB_HOME_A, SUB_HOME_B],
    };
    createHomesStore(homeyLike).write(currentConfig);
    const trackerKeys = [
      `${POWER_TRACKER_STATE}:${SUB_HOME_A.homeId}`,
      `${POWER_TRACKER_STATE}:${SUB_HOME_B.homeId}`,
    ] as const;
    const trackers: readonly PowerTrackerState[] = [
      { lastTimestamp: 1_700_000_000_000, lastPowerW: 2_400 },
      { lastTimestamp: 1_700_000_100_000, lastPowerW: 1_200 },
    ];
    mockHomeyInstance.settings.set(trackerKeys[0], trackers[0]);
    mockHomeyInstance.settings.set(trackerKeys[1], trackers[1]);
    const homeyWired = makeWiredHealthyHomey(false);
    const originalSet = mockHomeyInstance.settings.set.bind(mockHomeyInstance.settings);
    const trackerWriteAttempts = new Map<string, number>();
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set').mockImplementation((key, value) => {
      if (trackerKeys.includes(key as (typeof trackerKeys)[number])) {
        const attempt = trackerWriteAttempts.get(key) ?? 0;
        trackerWriteAttempts.set(key, attempt + 1);
        if (key === trackerKeys[1] && attempt === 0) {
          throw new Error('second tracker reset unavailable');
        }
      }
      originalSet(key, value);
    });

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: {
        op: 'upsert',
        area: { ...SUB_HOME_A, name: 'Renamed upstairs' },
      },
    })).toEqual({ ok: false, reason: 'degraded' });

    expect(setSpy.mock.calls.filter(([key]) => key === trackerKeys[0])).toHaveLength(2);
    expect(setSpy.mock.calls.filter(([key]) => key === trackerKeys[1])).toHaveLength(2);
    expect(setSpy.mock.calls.filter(([key]) => key === HOMES_CONFIG)).toHaveLength(0);
    expect(mockHomeyInstance.settings.get(trackerKeys[0])).toEqual(trackers[0]);
    expect(mockHomeyInstance.settings.get(trackerKeys[1])).toEqual(trackers[1]);
    expect(createHomesStore(homeyLike).read()).toEqual({
      state: 'present',
      value: currentConfig,
    });
  });

  it('refuses a delete when an existing tracker key transiently reads undefined', () => {
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [SUB_HOME_A],
    });
    const trackerKey = `${POWER_TRACKER_STATE}:${SUB_HOME_A.homeId}`;
    const tracker: PowerTrackerState = {
      lastTimestamp: 1_700_000_000_000,
      lastPowerW: 2_400,
      dailyTotals: { '2026-01-14': 7.25 },
    };
    mockHomeyInstance.settings.set(trackerKey, tracker);
    const homeyWired = makeWiredHealthyHomey();
    const originalGet = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
    vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementation((key) => (
      key === trackerKey ? undefined : originalGet(key)
    ));

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: { op: 'delete', homeId: SUB_HOME_A.homeId },
    })).toEqual({ ok: false, reason: 'degraded' });

    const config = createHomesStore(homeyLike).read();
    expect(config.state === 'present' && config.value.subHomes).toEqual([SUB_HOME_A]);
    expect(originalGet(trackerKey)).toEqual(tracker);
  });

  it('clears a deleted homeId tracker before an explicit re-add can commit', () => {
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [SUB_HOME_B],
    });
    const trackerKey = `${POWER_TRACKER_STATE}:${SUB_HOME_A.homeId}`;
    const deletedTracker: PowerTrackerState = {
      lastTimestamp: 1_700_000_000_000,
      lastPowerW: 5_200,
      hourlySampleCounts: { '2026-01-15T12': 6 },
    };
    mockHomeyInstance.settings.set(trackerKey, deletedTracker);
    const homeyWired = makeWiredHealthyHomey();

    expect(saveSettingsUiHomesConfig({
      homey: homeyWired,
      body: {
        op: 'upsert',
        area: SUB_HOME_A,
      },
    })).toEqual({ ok: true });

    const reset = mockHomeyInstance.settings.get(trackerKey) as PowerTrackerState;
    expect(reset.lastTimestamp).toBeUndefined();
    expect(reset.lastPowerW).toBeUndefined();
    expect(reset.hourlySampleCounts).toEqual(deletedTracker.hourlySampleCounts);
    const config = createHomesStore(homeyLike).read();
    expect(config.state === 'present' && config.value.subHomes).toEqual([
      SUB_HOME_B,
      SUB_HOME_A,
    ]);
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
      legacyMultiHomeEnabled: false,
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

describe('legacy multi-home activation compatibility', () => {
  it.each([
    ['the historical absent default', undefined],
    ['an explicit false flag', false],
  ])('holds a populated pre-GA config inert for %s while keeping diagnostics visible', (_label, flag) => {
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    if (flag !== undefined) mockHomeyInstance.settings.set(LEGACY_MULTI_HOME_ENABLED, flag);
    const { service, teardown } = createHomeMembershipService({
      homey: homeyLike,
      emitter: new ObservedStateEmitter(),
      setOnZoneTreeCommitted: noop,
      setOnDeviceZoneChanged: noop,
      getZoneTree: () => ZONES,
      getDevices: () => [{ deviceId: 'dev1', zoneId: 'z2' }],
      getLogger: () => undefined,
    });

    // The settings view must retain the saved config + its diagnostic join so
    // the owner can deliberately edit/save it; control stays byte-identical to
    // the old flag-off path until that save.
    expect(service.getDiagnostics().subHomes).toEqual([SUB_HOME_A]);
    expect(service.getDiagnostics().membershipByDeviceId.dev1).toEqual({
      homeId: 'h_a',
      source: 'zone',
    });
    expect(service.isRuntimeActive()).toBe(false);
    expect(service.hasSubHomes()).toBe(false);
    expect(service.getHomeIdForDevice('dev1')).toBe('main');
    expect(service.getMembershipMap()).toEqual({});
    const homeyWithApp = {
      app: { homeMembership: service }, settings: mockHomeyInstance.settings,
    } as unknown as Homey.App['homey'];
    expect(getSettingsUiHomesPayload({ homey: homeyWithApp }).runtimeActive).toBe(false);
    teardown();
  });

  it('emits an explicit runtime-activation edge even with no sub-home device assignments', () => {
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    mockHomeyInstance.settings.set(LEGACY_MULTI_HOME_ENABLED, false);
    const onRuntimeActiveChanged = vi.fn();
    const { service, teardown } = createHomeMembershipService({
      homey: homeyLike,
      emitter: new ObservedStateEmitter(),
      setOnZoneTreeCommitted: noop,
      setOnDeviceZoneChanged: noop,
      getZoneTree: () => ZONES,
      getDevices: () => [],
      getLogger: () => undefined,
      onRuntimeActiveChanged,
    });
    expect(service.isRuntimeActive()).toBe(false);
    expect(onRuntimeActiveChanged).not.toHaveBeenCalled();

    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [SUB_HOME_A],
    });
    service.recompute();

    expect(service.isRuntimeActive()).toBe(true);
    expect(service.getMembershipMap()).toEqual({});
    expect(onRuntimeActiveChanged).toHaveBeenCalledOnce();
    expect(onRuntimeActiveChanged).toHaveBeenCalledWith(true);
    teardown();
  });

  it('an existing upsert atomically marks a held config active through homes_config', () => {
    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A] });
    mockHomeyInstance.settings.set(LEGACY_MULTI_HOME_ENABLED, false);
    const trackerKey = `${POWER_TRACKER_STATE}:${SUB_HOME_A.homeId}`;
    const dormantTracker: PowerTrackerState = {
      lastTimestamp: 1_700_000_000_000,
      lastPowerW: 3_100,
      buckets: { '2026-01-15T12': 1.5 },
    };
    mockHomeyInstance.settings.set(trackerKey, dormantTracker);
    const homey = makeWiredHealthyHomey(false);

    expect(saveSettingsUiHomesConfig({
      homey,
      body: {
        op: 'upsert',
        area: {
          homeId: SUB_HOME_A.homeId,
          name: SUB_HOME_A.name,
          rootZoneId: SUB_HOME_A.rootZoneId,
          meterDeviceId: SUB_HOME_A.meterDeviceId,
        },
      },
    })).toEqual({ ok: true });

    expect(mockHomeyInstance.settings.get(HOMES_CONFIG)).toEqual({
      activationVersion: 1,
      subHomes: [SUB_HOME_A],
    });
    const reset = mockHomeyInstance.settings.get(trackerKey) as PowerTrackerState;
    expect(reset.lastTimestamp).toBeUndefined();
    expect(reset.lastPowerW).toBeUndefined();
    expect(reset.buckets).toEqual(dormantTracker.buckets);
    const service = homey.app.homeMembership;
    service.recompute();
    expect(service.isRuntimeActive()).toBe(true);
    expect(service.hasSubHomes()).toBe(true);
  });

  it('delete preserves the current activation state instead of activating a held sibling or dropping active intent', () => {
    const deleteArea = (homey: Homey.App['homey']): void => {
      expect(saveSettingsUiHomesConfig({
        homey,
        body: { op: 'delete', homeId: SUB_HOME_A.homeId },
      })).toEqual({ ok: true });
    };

    createHomesStore(homeyLike).write({ subHomes: [SUB_HOME_A, SUB_HOME_B] });
    mockHomeyInstance.settings.set(LEGACY_MULTI_HOME_ENABLED, false);
    deleteArea(makeWiredHealthyHomey(false));
    expect(mockHomeyInstance.settings.get(HOMES_CONFIG)).toEqual({
      subHomes: [SUB_HOME_B],
    });

    mockHomeyInstance.settings.clear();
    mockHomeyInstance.settings.set(HOMES_CONFIG_INITIALIZED, true);
    mockHomeyInstance.settings.set(HOMES_CONFIG, {
      activationVersion: 1,
      subHomes: [SUB_HOME_A, SUB_HOME_B],
    });
    deleteArea(makeWiredHealthyHomey(false));
    expect(mockHomeyInstance.settings.get(HOMES_CONFIG)).toEqual({
      activationVersion: 1,
      subHomes: [SUB_HOME_B],
    });
  });
});

describe('HomeMembershipService — Main actuation ownership fence', () => {
  it('ignores dormant held-home collisions until activation but still fences unavailable authority', () => {
    createHomesStore(homeyLike).write({
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-shared' }],
    });
    let selection: MainMeterSelection = {
      state: 'resolved',
      meterDeviceId: 'm-shared',
    };
    const service = new HomeMembershipService({
      homesStore: createHomesStore(homeyLike),
      assignmentsStore: createDeviceHomeAssignmentsStore(homeyLike),
      getZoneTree: () => ZONES,
      getDevices: () => [],
      getLogger: () => undefined,
      getMainMeterSelection: () => selection,
      legacyMultiHomeEnabled: false,
    });
    service.recompute();

    expect(service.isRuntimeActive()).toBe(false);
    expect(service.isMainHomeActuationFenced()).toBe(false);
    selection = { state: 'unavailable' };
    expect(service.isMainHomeActuationFenced()).toBe(true);

    selection = { state: 'resolved', meterDeviceId: 'm-shared' };
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-shared' }],
    });
    service.recompute();
    expect(service.isRuntimeActive()).toBe(true);
    expect(service.isMainHomeActuationFenced()).toBe(true);
  });

  // Automatic (no explicit Main meter) resolves the whole-home reading from a
  // sole readable `cumulative` item or retains a meter proven by an earlier
  // unambiguous poll. That may still be a meter area's own meter when it is the
  // sole readable candidate. The CONFIGURED id is null and proves nothing, so
  // authority is resolved from the identity the poll actually sampled.
  describe('Automatic sampled-meter ownership', () => {
    const buildAutomaticService = (warn: (payload: unknown) => void = vi.fn()) => {
      createHomesStore(homeyLike).write({
        activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
        subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-area' }],
      });
      const service = new HomeMembershipService({
        homesStore: createHomesStore(homeyLike),
        assignmentsStore: createDeviceHomeAssignmentsStore(homeyLike),
        getZoneTree: () => ZONES,
        getDevices: () => [],
        getLogger: () => ({
          warn, info: vi.fn(), debug: vi.fn(), error: vi.fn(),
        }) as never,
        // Automatic.
        getMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: null }),
        legacyMultiHomeEnabled: true,
      });
      service.recompute();
      return service;
    };

    it('does NOT fence on an unknown sampled identity', () => {
      // Unknown is not a collision: an area meter always reports under its own
      // id, so a missing id cannot be one. Fencing here would close the seam for
      // the whole boot window — and this fence is shared with smart-task
      // authority, so it would report tasks unavailable on every start.
      const service = buildAutomaticService();
      expect(service.hasSeenZoneTreeCommit()).toBe(true);
      expect(service.isMainHomeActuationFenced()).toBe(false);
      service.noteResolvedHomeMeter(null, Date.now());
      expect(service.isMainHomeActuationFenced()).toBe(false);
    });

    it('does not fence when Automatic sampled a meter no area owns', () => {
      const service = buildAutomaticService();
      service.noteResolvedHomeMeter('m-main', Date.now());
      expect(service.isMainHomeActuationFenced()).toBe(false);
    });

    it('fences and warns when Automatic sampled a meter area\'s own meter', () => {
      const warn = vi.fn();
      const service = buildAutomaticService(warn);
      service.noteResolvedHomeMeter('m-area', Date.now());

      expect(service.isMainHomeActuationFenced()).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({
        event: 'main_home_sampled_meter_ownership_conflict',
        meterDeviceId: 'm-area',
        subHomeId: SUB_HOME_A.homeId,
      }));

      // Edge-triggered: a second resolution at the same state must not re-log.
      warn.mockClear();
      expect(service.isMainHomeActuationFenced()).toBe(true);
      expect(warn).not.toHaveBeenCalled();

      // The poll moving to Main's own meter repairs authority with no recompute.
      service.noteResolvedHomeMeter('m-main', Date.now());
      expect(service.isMainHomeActuationFenced()).toBe(false);
    });

    // The boundary is not a tuned number: the identity's expiry anchor IS the
    // colliding sample's ingest stamp, and while that sample is still `fresh`
    // a price/settings/realtime rebuild plans Main against the AREA's watts —
    // with the area's own controller using the same physical sample. Releasing
    // the fence before the sample goes stale would reopen Main's write seam
    // inside exactly that window; at the threshold the planner falls back to
    // synthetic headroom and the collision can no longer reach a decision.
    it('keeps the collision fenced for as long as its sample can still drive a decision', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-07-27T10:00:00Z'));
        const service = buildAutomaticService();
        service.noteResolvedHomeMeter('m-area', Date.now());
        expect(service.isMainHomeActuationFenced()).toBe(true);

        // One millisecond before the sample stops being fresh, still fenced.
        vi.advanceTimersByTime(POWER_SAMPLE_STALE_THRESHOLD_MS - 1);
        service.noteResolvedHomeMeter(null, Date.now());
        expect(service.isMainHomeActuationFenced()).toBe(true);

        // At the threshold the sample is no longer fresh (`hasLivePowerSample`
        // false, synthetic headroom), so the collision it proved can no longer
        // reach a decision and the identity may be dropped.
        vi.advanceTimersByTime(1);
        service.noteResolvedHomeMeter(null, Date.now());
        expect(service.isMainHomeActuationFenced()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('retains a PROVEN collision across id-less ingests until its own sample expires', () => {
      // An unknown identity arrives on any admitted sample whose payload could
      // not attribute the watts (e.g. an id-less cumulative aggregate).
      // Overwriting a proven identity with it would release Main's write seam
      // on a payload quirk.
      //
      // The window is elapsed TIME on purpose, anchored to the proven sample's
      // ingest stamp: a burst of unknown-identity ingests must not spend the
      // retention in report counts during exactly the shedding episode it
      // exists to protect.
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-07-27T10:00:00Z'));
        const service = buildAutomaticService();
        service.noteResolvedHomeMeter('m-area', Date.now());
        expect(service.isMainHomeActuationFenced()).toBe(true);

        // A burst of unreadable reads inside one second cannot release it.
        for (let i = 0; i < 10; i += 1) {
          vi.advanceTimersByTime(100);
          service.noteResolvedHomeMeter(null, Date.now());
          expect(service.isMainHomeActuationFenced()).toBe(true);
        }

        vi.advanceTimersByTime(POWER_SAMPLE_STALE_THRESHOLD_MS - 2_000);
        service.noteResolvedHomeMeter(null, Date.now());
        expect(service.isMainHomeActuationFenced()).toBe(true);

        // Sustained unreadability finally abandons the identity.
        vi.advanceTimersByTime(2_000);
        service.noteResolvedHomeMeter(null, Date.now());
        expect(service.isMainHomeActuationFenced()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a re-proven collision re-anchors the retention, so flapping never releases the fence', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-07-27T10:00:00Z'));
        const service = buildAutomaticService();
        service.noteResolvedHomeMeter('m-area', Date.now());
        for (let i = 0; i < 10; i += 1) {
          vi.advanceTimersByTime(POWER_SAMPLE_STALE_THRESHOLD_MS - 1_000);
          service.noteResolvedHomeMeter(null, Date.now());
          vi.advanceTimersByTime(POWER_SAMPLE_STALE_THRESHOLD_MS - 1_000);
          service.noteResolvedHomeMeter('m-area', Date.now());
          expect(service.isMainHomeActuationFenced()).toBe(true);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('a different proven identity replaces the retained one immediately', () => {
      const service = buildAutomaticService();
      service.noteResolvedHomeMeter('m-area', Date.now());
      expect(service.isMainHomeActuationFenced()).toBe(true);
      // A genuine meter change must not wait out the retention window.
      service.noteResolvedHomeMeter('m-main', Date.now());
      expect(service.isMainHomeActuationFenced()).toBe(false);
    });

    // A restart INSIDE the freshness window reloads the durable
    // `lastPowerW`/`lastTimestamp`, so the planner resumes treating pre-restart
    // watts as live — while the sampled-identity owner starts empty. Reading
    // that emptiness as "nothing was sampled" would authorize Main against
    // watts that may have come from a meter area's own meter, with the area's
    // own controller driving from the same physical sample.
    describe('watts restored across a restart', () => {
      const buildRestartedService = (
        getRestoredSampleAtMs: () => number | undefined,
        warn: (payload: unknown) => void = vi.fn(),
        subHomes = [{ ...SUB_HOME_A, meterDeviceId: 'm-area' }],
        getConfiguredPowerSource: () => ConfiguredPowerSourceRead = (
          () => ({ state: 'resolved', value: 'homey_energy' })
        ),
      ) => {
        createHomesStore(homeyLike).write({
          activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
          subHomes,
        });
        const service = new HomeMembershipService({
          homesStore: createHomesStore(homeyLike),
          assignmentsStore: createDeviceHomeAssignmentsStore(homeyLike),
          getZoneTree: () => ZONES,
          getDevices: () => [],
          getLogger: () => ({
            warn, info: vi.fn(), debug: vi.fn(), error: vi.fn(),
          }) as never,
          // Automatic.
          getMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: null }),
          getConfiguredPowerSource,
          getRestoredSampleAtMs,
          legacyMultiHomeEnabled: true,
        });
        service.recompute();
        return service;
      };

      it('fences Main until this process admits a sample of its own', () => {
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date('2026-07-27T10:00:00Z'));
          const restoredAtMs = Date.now() - 5_000;
          const warn = vi.fn();
          const service = buildRestartedService(() => restoredAtMs, warn);

          expect(service.isMainHomeActuationFenced()).toBe(true);
          expect(warn).toHaveBeenCalledWith(expect.objectContaining({
            event: 'main_home_restored_sample_provenance_unproven',
          }));

          // Edge-triggered: a second resolution at the same state must not re-log.
          warn.mockClear();
          expect(service.isMainHomeActuationFenced()).toBe(true);
          expect(warn).not.toHaveBeenCalled();

          // The first ADMITTED ingest re-proves provenance even when the payload
          // could not attribute it: an area meter always reports under its own
          // id, so an id-less sample this process admitted is not the hazard.
          service.noteResolvedHomeMeter(null, Date.now());
          expect(service.isMainHomeActuationFenced()).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });

      it('does not fence when the restored watts are already out of decision reach', () => {
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date('2026-07-27T10:00:00Z'));
          // A long outage: the reloaded sample is no longer `fresh`, the planner
          // is on synthetic headroom, and its provenance can reach no decision.
          const service = buildRestartedService(
            () => Date.now() - POWER_SAMPLE_STALE_THRESHOLD_MS,
          );
          expect(service.isMainHomeActuationFenced()).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });

      it('keeps the restart episode fenced after expiry until a replacement ingest', () => {
        // Expiry stops new plans from trusting the restored watts, but it does
        // not remove a shed already committed behind the fence.
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date('2026-07-27T10:00:00Z'));
          const restoredAtMs = Date.now();
          const service = buildRestartedService(() => restoredAtMs);

          vi.advanceTimersByTime(POWER_SAMPLE_STALE_THRESHOLD_MS - 1);
          expect(service.isMainHomeActuationFenced()).toBe(true);

          vi.advanceTimersByTime(1);
          expect(service.isMainHomeActuationFenced()).toBe(true);

          service.noteResolvedHomeMeter('m-main', Date.now());
          expect(service.isMainHomeActuationFenced()).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });

      it('starts the restart fence on a Flow switch before any earlier actuation check', () => {
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date('2026-07-27T10:00:00Z'));
          let powerSource: ConfiguredPowerSourceRead = {
            state: 'resolved',
            value: 'homey_energy',
          };
          const service = buildRestartedService(
            () => Date.now() - 5_000,
            vi.fn(),
            [{ ...SUB_HOME_A, meterDeviceId: 'm-area' }],
            () => powerSource,
          );

          // No actuation read has primed sampledFenceEpisode. The source switch
          // still cannot authorize Main against unattributable restored watts.
          powerSource = { state: 'resolved', value: 'flow' };
          expect(service.isMainHomeActuationFenced()).toBe(true);

          service.noteAdmittedFlowHomeSample();
          expect(service.isMainHomeActuationFenced()).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });

      it('records the restart fence as a reconcile debt and settles it on the first ingest', () => {
        // Main keeps BUILDING and COMMITTING plans while only the write seam is
        // nulled, and `maybeApplyPlanChanges` skips an unchanged shed signature
        // — so a shed planned behind the boot fence needs the same
        // rebuild-then-reconcile recovery a proven collision gets.
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date('2026-07-27T10:00:00Z'));
          const restoredAtMs = Date.now() - 5_000;
          const onMainAuthorityReopened = vi.fn();
          createHomesStore(homeyLike).write({
            activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
            subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-area' }],
          });
          const service = new HomeMembershipService({
            homesStore: createHomesStore(homeyLike),
            assignmentsStore: createDeviceHomeAssignmentsStore(homeyLike),
            getZoneTree: () => ZONES,
            getDevices: () => [],
            getLogger: () => undefined,
            getMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: null }),
            getRestoredSampleAtMs: () => restoredAtMs,
            legacyMultiHomeEnabled: true,
            onMainAuthorityReopened,
          });
          service.recompute();

          expect(service.isMainHomeActuationFenced()).toBe(true);
          expect(onMainAuthorityReopened).not.toHaveBeenCalled();

          service.noteResolvedHomeMeter('m-main', Date.now());
          expect(service.isMainHomeActuationFenced()).toBe(false);
          expect(onMainAuthorityReopened).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it('warns again when the first admitted sample turns the restart fence into a proven collision', () => {
        // The reason CHANGES while the seam stays closed. A boolean "already
        // logged" latch would swallow the collision warn — the one an operator
        // needs to see, because it names the area that owns the meter.
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date('2026-07-27T10:00:00Z'));
          const warn = vi.fn();
          const service = buildRestartedService(() => Date.now() - 5_000, warn);
          expect(service.isMainHomeActuationFenced()).toBe(true);
          warn.mockClear();

          service.noteResolvedHomeMeter('m-area', Date.now());
          expect(service.isMainHomeActuationFenced()).toBe(true);
          expect(warn).toHaveBeenCalledWith(expect.objectContaining({
            event: 'main_home_sampled_meter_ownership_conflict',
            meterDeviceId: 'm-area',
            subHomeId: SUB_HOME_A.homeId,
          }));
        } finally {
          vi.useRealTimers();
        }
      });

      it('SINGLE-HOME IDENTITY: a restart with no meter areas never gains the fence', () => {
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date('2026-07-27T10:00:00Z'));
          const service = buildRestartedService(() => Date.now() - 5_000, vi.fn(), []);
          expect(service.isMainHomeActuationFenced()).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it('SINGLE-HOME IDENTITY: Automatic with no meter areas never consults the sampled id', () => {
      // The byte-identical single-home guarantee: an ordinary Automatic install
      // has no area meter set to collide with, so it must not gain a boot fence.
      createHomesStore(homeyLike).write({
        activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
        subHomes: [],
      });
      const service = new HomeMembershipService({
        homesStore: createHomesStore(homeyLike),
        assignmentsStore: createDeviceHomeAssignmentsStore(homeyLike),
        getZoneTree: () => ZONES,
        getDevices: () => [],
        getLogger: () => undefined,
        getMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: null }),
        legacyMultiHomeEnabled: true,
      });
      service.recompute();

      // No sample ever reported, yet control is open.
      expect(service.isMainHomeActuationFenced()).toBe(false);
    });

    // The sampled clause reopens off a POLL — a different `cumulative` item won
    // the Automatic pick — with no settings event and no membership change. The
    // committed plan already carries the sheds it planned while the actuator was
    // nulled, and `maybeApplyPlanChanges` skips an unchanged shed signature
    // (`hasStablePlanActuation` covers restore/release/step only). Without a
    // recovery request on that edge Main stays unshed over its hard cap until an
    // unrelated device happens to change the plan.
    describe('blocked -> ready recovery edge', () => {
      const buildWithReopen = (
        onMainAuthorityReopened: () => void,
        overrides: {
          mainMeterSelection?: MainMeterSelection;
          getConfiguredPowerSource?: () => ConfiguredPowerSourceRead;
          warn?: (payload: unknown) => void;
        } = {},
      ) => {
        createHomesStore(homeyLike).write({
          activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
          subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-area' }],
        });
        const service = new HomeMembershipService({
          homesStore: createHomesStore(homeyLike),
          assignmentsStore: createDeviceHomeAssignmentsStore(homeyLike),
          getZoneTree: () => ZONES,
          getDevices: () => [],
          getLogger: () => (overrides.warn === undefined
            ? undefined
            : ({
              warn: overrides.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn(),
            }) as never),
          getMainMeterSelection: () => (
            overrides.mainMeterSelection ?? { state: 'resolved', meterDeviceId: null }
          ),
          ...(overrides.getConfiguredPowerSource === undefined
            ? {}
            : { getConfiguredPowerSource: overrides.getConfiguredPowerSource }),
          legacyMultiHomeEnabled: true,
          onMainAuthorityReopened,
        });
        service.recompute();
        // Model production's priming: the cached power source and Main-meter
        // selection the reopen predicate reads are populated by `resolve()`, and
        // every plan build already runs it (`filterDevicesForHome` ->
        // `getConfiguredMeterSources`, plus the write seam's own fence check).
        // No REAL edge can be missed by depending on it: `wasBlocked` can only
        // be true once `resolveForActuation` has returned 'blocked', which is
        // the same call that primes both fields.
        service.isMainHomeActuationFenced();
        return service;
      };

      it('requests recovery when a later sample repairs a proven collision', () => {
        const onMainAuthorityReopened = vi.fn();
        const service = buildWithReopen(onMainAuthorityReopened);

        service.noteResolvedHomeMeter('m-area', Date.now());
        expect(service.isMainHomeActuationFenced()).toBe(true);
        expect(onMainAuthorityReopened).not.toHaveBeenCalled();

        service.noteResolvedHomeMeter('m-main', Date.now());
        expect(service.isMainHomeActuationFenced()).toBe(false);
        expect(onMainAuthorityReopened).toHaveBeenCalledTimes(1);
      });

      it('requests recovery when an id-less ingest replaces an expired collision', () => {
        // Sustained id-less ingests never re-anchor the identity, so it expires
        // on its own sample's horizon. The later admitted ingest replaces those
        // watts and hands the latched episode to recovery.
        const onMainAuthorityReopened = vi.fn();
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date('2026-07-27T10:00:00Z'));
          const service = buildWithReopen(onMainAuthorityReopened);

          service.noteResolvedHomeMeter('m-area', Date.now());
          vi.advanceTimersByTime(10_000);
          service.noteResolvedHomeMeter(null, Date.now());
          vi.advanceTimersByTime(10_000);
          service.noteResolvedHomeMeter(null, Date.now());
          expect(onMainAuthorityReopened).not.toHaveBeenCalled();

          vi.advanceTimersByTime(POWER_SAMPLE_STALE_THRESHOLD_MS);
          service.noteResolvedHomeMeter(null, Date.now());
          expect(service.isMainHomeActuationFenced()).toBe(false);
          expect(onMainAuthorityReopened).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it('does not fire on ordinary samples that never fenced', () => {
        const onMainAuthorityReopened = vi.fn();
        const service = buildWithReopen(onMainAuthorityReopened);

        service.noteResolvedHomeMeter('m-main', Date.now());
        service.noteResolvedHomeMeter(null, Date.now());
        service.noteResolvedHomeMeter('m-other', Date.now());
        expect(onMainAuthorityReopened).not.toHaveBeenCalled();
      });

      it('re-arms BOTH the recovery edge and the conflict warn for a second episode', () => {
        const warn = vi.fn();
        const onMainAuthorityReopened = vi.fn();
        const service = buildWithReopen(onMainAuthorityReopened, { warn });
        const conflictWarns = () => warn.mock.calls.filter(
          ([payload]) => (payload as { event?: string }).event
            === 'main_home_sampled_meter_ownership_conflict',
        ).length;

        service.noteResolvedHomeMeter('m-area', Date.now());
        expect(service.isMainHomeActuationFenced()).toBe(true);
        expect(conflictWarns()).toBe(1);
        service.noteResolvedHomeMeter('m-main', Date.now());
        service.noteResolvedHomeMeter('m-area', Date.now());
        expect(service.isMainHomeActuationFenced()).toBe(true);
        service.noteResolvedHomeMeter('m-main', Date.now());

        expect(onMainAuthorityReopened).toHaveBeenCalledTimes(2);
        // A repair-then-recollision pair arriving BETWEEN two actuation
        // resolutions still warns the second time.
        expect(conflictWarns()).toBe(2);
      });

      // THE SWITCHOVER REGRESSION (PR #1887 review P1): the moment the user
      // replaces a colliding Automatic pick with a non-colliding EXPLICIT Main
      // meter, the configured id is proven clean — but the tracker still
      // serves the area's watts, because `handleHomeyEnergyMeterChange` starts
      // the replacement poll without awaiting it and rebuilds immediately. The
      // write seam must stay closed until a sample admitted under the new
      // selection proves the tracker serves Main's own watts.
      it('keeps the fence after switching to a clean explicit meter until its own sample is admitted', () => {
        const onMainAuthorityReopened = vi.fn();
        const overrides: { mainMeterSelection?: MainMeterSelection } = {};
        const service = buildWithReopen(onMainAuthorityReopened, overrides);

        // Automatic sampled the area's meter: fenced, no recovery yet.
        service.noteResolvedHomeMeter('m-area', Date.now());
        expect(service.isMainHomeActuationFenced()).toBe(true);

        // The user picks a non-colliding explicit Main meter. The replacement
        // poll has NOT landed: the admitted watts are still the area's.
        overrides.mainMeterSelection = { state: 'resolved', meterDeviceId: 'm-main' };
        expect(service.isMainHomeActuationFenced()).toBe(true);
        expect(onMainAuthorityReopened).not.toHaveBeenCalled();

        // The first sample admitted under the new selection settles the debt.
        service.noteResolvedHomeMeter('m-main', Date.now());
        expect(service.isMainHomeActuationFenced()).toBe(false);
        expect(onMainAuthorityReopened).toHaveBeenCalledTimes(1);
      });

      it('a failed replacement poll stays fenced after expiry until a sample replaces the plan input', () => {
        const onMainAuthorityReopened = vi.fn();
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date('2026-07-27T10:00:00Z'));
          const overrides: { mainMeterSelection?: MainMeterSelection } = {};
          const service = buildWithReopen(onMainAuthorityReopened, overrides);

          service.noteResolvedHomeMeter('m-area', Date.now());
          overrides.mainMeterSelection = { state: 'resolved', meterDeviceId: 'm-main' };
          expect(service.isMainHomeActuationFenced()).toBe(true);

          // No sample from the new meter ever lands. One ms before the area
          // sample stops being fresh, its watts can still reach a decision.
          vi.advanceTimersByTime(POWER_SAMPLE_STALE_THRESHOLD_MS - 1);
          expect(service.isMainHomeActuationFenced()).toBe(true);

          // At the threshold the planner stops trusting the sample, but the
          // already-committed shed still cannot be executed.
          vi.advanceTimersByTime(1);
          expect(service.isMainHomeActuationFenced()).toBe(true);

          service.noteResolvedHomeMeter('m-main', Date.now());
          expect(service.isMainHomeActuationFenced()).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });

      it('an explicit selection fences only while the admitted sample is a meter area\'s', () => {
        const onMainAuthorityReopened = vi.fn();
        const service = buildWithReopen(onMainAuthorityReopened, {
          mainMeterSelection: { state: 'resolved', meterDeviceId: 'm-main' },
        });
        expect(service.isMainHomeActuationFenced()).toBe(false);

        // The selection's own samples, and non-area meters, never fence.
        service.noteResolvedHomeMeter('m-main', Date.now());
        expect(service.isMainHomeActuationFenced()).toBe(false);
        service.noteResolvedHomeMeter('m-other', Date.now());
        expect(service.isMainHomeActuationFenced()).toBe(false);
        expect(onMainAuthorityReopened).not.toHaveBeenCalled();

        // An in-flight Automatic-era poll landing the AREA's sample after the
        // switch really does put the area's watts in the tracker: fence until
        // the next poll (which reads the explicit id) replaces it.
        service.noteResolvedHomeMeter('m-area', Date.now());
        expect(service.isMainHomeActuationFenced()).toBe(true);
        // A repeat of the colliding sample keeps the debt latched; settling it
        // here would claim a reopening while the seam is still closed.
        service.noteResolvedHomeMeter('m-area', Date.now());
        expect(onMainAuthorityReopened).not.toHaveBeenCalled();
        service.noteResolvedHomeMeter('m-main', Date.now());
        expect(service.isMainHomeActuationFenced()).toBe(false);
        expect(onMainAuthorityReopened).toHaveBeenCalledTimes(1);
      });

      // A late Homey-Energy ingest can overlap the switch to Flow. If it
      // identifies an area's meter, its watts reached the shared tracker and
      // must stay fenced until an admitted Flow sample replaces them.
      it('fences a late area-meter ingest in Flow mode until a Flow sample replaces it', () => {
        const onMainAuthorityReopened = vi.fn();
        const service = buildWithReopen(onMainAuthorityReopened, {
          getConfiguredPowerSource: () => ({ state: 'resolved', value: 'flow' }),
        });
        expect(service.isMainHomeActuationFenced()).toBe(false);

        service.noteResolvedHomeMeter('m-area', Date.now());
        expect(service.isMainHomeActuationFenced()).toBe(true);
        expect(onMainAuthorityReopened).not.toHaveBeenCalled();

        service.noteAdmittedFlowHomeSample();
        expect(service.isMainHomeActuationFenced()).toBe(false);
        expect(onMainAuthorityReopened).toHaveBeenCalledOnce();
      });

      // Switching the setting does not replace the old Homey-Energy watts.
      // The first admitted Flow sample does, and only then may fresh-plan
      // recovery take over the fence.
      it('keeps the fence through a Flow switch until the first Flow sample', () => {
        const onMainAuthorityReopened = vi.fn();
        let powerSource: ConfiguredPowerSourceRead = { state: 'resolved', value: 'homey_energy' };
        const service = buildWithReopen(onMainAuthorityReopened, {
          getConfiguredPowerSource: () => powerSource,
        });

        service.noteResolvedHomeMeter('m-area', Date.now());
        expect(service.isMainHomeActuationFenced()).toBe(true);
        expect(onMainAuthorityReopened).not.toHaveBeenCalled();

        powerSource = { state: 'resolved', value: 'flow' };
        expect(service.isMainHomeActuationFenced()).toBe(true);
        expect(onMainAuthorityReopened).not.toHaveBeenCalled();

        service.noteAdmittedFlowHomeSample();
        expect(service.isMainHomeActuationFenced()).toBe(false);
        expect(onMainAuthorityReopened).toHaveBeenCalledTimes(1);

        // Flow replaced the tracker watts, so a later switch back to Homey
        // Energy cannot resurrect the old area's identity.
        powerSource = { state: 'resolved', value: 'homey_energy' };
        expect(service.isMainHomeActuationFenced()).toBe(false);

        // Exactly once: a later Flow resolution finds no pending episode.
        powerSource = { state: 'resolved', value: 'flow' };
        expect(service.isMainHomeActuationFenced()).toBe(false);
        expect(onMainAuthorityReopened).toHaveBeenCalledTimes(1);
      });

      it('does NOT settle on source churn that cannot dissolve the collision', () => {
        // A transient unreadable source proves nothing about the collision, and
        // a re-proven homey_energy read leaves it in force. The reconcile debt
        // must survive both and settle exactly once when Flow finally resolves.
        const onMainAuthorityReopened = vi.fn();
        let powerSource: ConfiguredPowerSourceRead = { state: 'resolved', value: 'homey_energy' };
        const service = buildWithReopen(onMainAuthorityReopened, {
          getConfiguredPowerSource: () => powerSource,
        });

        service.noteResolvedHomeMeter('m-area', Date.now());
        expect(service.isMainHomeActuationFenced()).toBe(true);

        powerSource = {
          state: 'suspect', reason: 'read_failed', error: new Error('settings read failed'),
        };
        expect(service.isMainHomeActuationFenced()).toBe(true);
        powerSource = { state: 'resolved', value: 'homey_energy' };
        expect(service.isMainHomeActuationFenced()).toBe(true);
        expect(onMainAuthorityReopened).not.toHaveBeenCalled();

        powerSource = { state: 'resolved', value: 'flow' };
        expect(service.isMainHomeActuationFenced()).toBe(true);
        service.noteAdmittedFlowHomeSample();
        expect(service.isMainHomeActuationFenced()).toBe(false);
        expect(onMainAuthorityReopened).toHaveBeenCalledTimes(1);
      });

      it('stays silent while the Main meter selection has never resolved', () => {
        const onMainAuthorityReopened = vi.fn();
        const service = buildWithReopen(onMainAuthorityReopened, {
          mainMeterSelection: { state: 'unavailable' },
        });
        // Unproven authority already fences via 'retry'; the sampled clause is
        // not why, so repairing the sampled id must not claim a reopening.
        expect(service.isMainHomeActuationFenced()).toBe(true);

        service.noteResolvedHomeMeter('m-area', Date.now());
        service.noteResolvedHomeMeter('m-main', Date.now());
        expect(onMainAuthorityReopened).not.toHaveBeenCalled();
      });

      // Provenance expires at CHECK time when the colliding sample ages out,
      // but the actuation episode stays closed because a committed shed may
      // still exist. The first admitted ingest afterwards replaces the watts
      // and settles the episode — whatever identity it happens to carry.
      it('settles a silently expired fence episode on the next admitted ingest', () => {
        const onMainAuthorityReopened = vi.fn();
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date('2026-07-27T10:00:00Z'));
          const service = buildWithReopen(onMainAuthorityReopened);

          service.noteResolvedHomeMeter('m-area', Date.now());
          expect(service.isMainHomeActuationFenced()).toBe(true);

          // Blackout: no ingests at all. Expiry stops new plans from trusting
          // the sample, but the committed shed remains fenced.
          vi.advanceTimersByTime(POWER_SAMPLE_STALE_THRESHOLD_MS);
          expect(service.isMainHomeActuationFenced()).toBe(true);
          expect(onMainAuthorityReopened).not.toHaveBeenCalled();

          // Data resumes with an unattributable sample: still settles the
          // episode — committed-but-unactuated sheds must reach recovery.
          service.noteResolvedHomeMeter(null, Date.now());
          expect(onMainAuthorityReopened).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });

      // The episode latch has TWO writers on purpose. The note path covers an
      // identity that arrives already colliding; the resolve path covers a
      // fence that CLOSES without any note — a homes-config change adopting an
      // area whose meter is the already-retained identity. The settlement is
      // the same either way: the next admitted ingest that finds the fence
      // open hands the committed-but-unactuated plan to recovery.
      it('settles a fence that closed via a config change, not via a note', () => {
        const onMainAuthorityReopened = vi.fn();
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date('2026-07-27T10:00:00Z'));
          // Start with NO areas: the identity arrives collision-free.
          createHomesStore(homeyLike).write({
            activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
            subHomes: [],
          });
          const service = new HomeMembershipService({
            homesStore: createHomesStore(homeyLike),
            assignmentsStore: createDeviceHomeAssignmentsStore(homeyLike),
            getZoneTree: () => ZONES,
            getDevices: () => [],
            getLogger: () => undefined,
            getMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: null }),
            legacyMultiHomeEnabled: true,
            onMainAuthorityReopened,
          });
          service.recompute();
          service.isMainHomeActuationFenced();
          service.noteResolvedHomeMeter('m-area', Date.now());
          expect(service.isMainHomeActuationFenced()).toBe(false);

          // An area adopting that very meter closes the fence with no note.
          createHomesStore(homeyLike).write({
            activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
            subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-area' }],
          });
          service.recompute();
          expect(service.isMainHomeActuationFenced()).toBe(true);
          expect(onMainAuthorityReopened).not.toHaveBeenCalled();

          // The next admitted ingest with a different identity settles it.
          service.noteResolvedHomeMeter('m-main', Date.now());
          expect(service.isMainHomeActuationFenced()).toBe(false);
          expect(onMainAuthorityReopened).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it('anchors expiry to the SAMPLE timestamp, not the note call', () => {
        // The identity describes the sample, so its lifetime is the sample's:
        // an ingest stamped T0 expires at T0 + threshold even if the note
        // itself lands later. With ingest-time publication the two clocks are
        // the same call, so this pins the anchor choice against regression.
        const onMainAuthorityReopened = vi.fn();
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date('2026-07-27T10:00:00Z'));
          const sampleAtMs = Date.now();
          const service = buildWithReopen(onMainAuthorityReopened);

          // Note delivered 10s after the sample's own stamp.
          vi.advanceTimersByTime(10_000);
          service.noteResolvedHomeMeter('m-area', sampleAtMs);
          expect(service.isMainHomeActuationFenced()).toBe(true);

          // Threshold measured from the SAMPLE stamp: the provenance expires
          // 10s earlier than a note-call anchor would claim, but the episode
          // remains fenced until another admitted sample takes it over.
          vi.advanceTimersByTime(POWER_SAMPLE_STALE_THRESHOLD_MS - 10_000);
          expect(service.isMainHomeActuationFenced()).toBe(true);

          service.noteResolvedHomeMeter('m-main', Date.now());
          expect(service.isMainHomeActuationFenced()).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });
    });
  });

  it('fences a persisted explicit-meter collision and adopts a repair without recompute', () => {
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-shared' }],
    });
    let mainMeterDeviceId = 'm-shared';
    const service = new HomeMembershipService({
      homesStore: createHomesStore(homeyLike),
      assignmentsStore: createDeviceHomeAssignmentsStore(homeyLike),
      getZoneTree: () => ZONES,
      getDevices: () => [],
      getLogger: () => undefined,
      getMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: mainMeterDeviceId }),
      legacyMultiHomeEnabled: true,
    });
    service.recompute();

    // A committed tree proves this is the meter-ownership fence, not the boot
    // readiness fence. Point-of-use resolution closes a direct settings write
    // immediately and opens again immediately after the owner repairs it.
    expect(service.hasSeenZoneTreeCommit()).toBe(true);
    expect(service.isMainHomeActuationFenced()).toBe(true);
    mainMeterDeviceId = 'm-main';
    expect(service.isMainHomeActuationFenced()).toBe(false);
  });

  it('retains the last-good Main meter but fences single-home control while authority is unavailable', () => {
    const onMainAuthorityUnresolved = vi.fn();
    let selection: MainMeterSelection = {
      state: 'resolved',
      meterDeviceId: 'm-main',
    };
    const service = new HomeMembershipService({
      homesStore: createHomesStore(homeyLike),
      assignmentsStore: createDeviceHomeAssignmentsStore(homeyLike),
      getZoneTree: () => ZONES,
      getDevices: () => [],
      getLogger: () => undefined,
      getMainMeterSelection: () => selection,
      legacyMultiHomeEnabled: true,
      onMainAuthorityUnresolved,
    });
    service.recompute();

    expect(service.isMainHomeActuationFenced()).toBe(false);
    selection = { state: 'unavailable' };
    expect(service.getConfiguredMeterSources()).toEqual({
      state: 'unavailable',
      deviceIds: new Set(['m-main']),
    });
    expect(onMainAuthorityUnresolved).toHaveBeenCalledOnce();
    expect(service.isMainHomeActuationFenced()).toBe(true);
    selection = { state: 'resolved', meterDeviceId: 'm-main' };
    expect(service.isMainHomeActuationFenced()).toBe(false);
  });

  it('fences Main and smart-task eligibility while boundary authority is unavailable', () => {
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-sub' }],
    });
    let selection: MainMeterSelection = { state: 'unavailable' };
    const service = new HomeMembershipService({
      homesStore: createHomesStore(homeyLike),
      assignmentsStore: createDeviceHomeAssignmentsStore(homeyLike),
      getZoneTree: () => ZONES,
      getDevices: () => [{ deviceId: 'd-main', zoneId: 'z1' }],
      getLogger: () => undefined,
      getMainMeterSelection: () => selection,
      legacyMultiHomeEnabled: true,
    });
    service.recompute();
    const ctx = { homeMembership: service } as unknown as AppContext;

    expect(service.isMainHomeActuationFenced()).toBe(true);
    expect(isSmartTaskDeviceInMainHome(ctx, 'd-main')).toBe(true);
    expect(hasMainHomeSmartTaskAuthority(ctx, 'd-main')).toBe(false);

    selection = { state: 'resolved', meterDeviceId: 'm-main' };
    expect(service.isMainHomeActuationFenced()).toBe(false);
    expect(isSmartTaskDeviceInMainHome(ctx, 'd-main')).toBe(true);
    expect(hasMainHomeSmartTaskAuthority(ctx, 'd-main')).toBe(true);
  });
});

describe('HomeMembershipService — positive ownership readiness', () => {
  const ACTIVE_HOME_CONFIG: HomeConfig = {
    activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
    subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-sub' }],
  };
  const unwrittenAssignments: DeviceHomeAssignmentsStore = {
    read: () => ({ state: 'unwritten' }),
    write: vi.fn(),
  };

  it('treats a cached sub-home as unavailable while its ownership generation is pending', () => {
    createHomesStore(homeyLike).write(ACTIVE_HOME_CONFIG);
    const assignmentsStore = createDeviceHomeAssignmentsStore(homeyLike);
    const service = new HomeMembershipService({
      homesStore: createHomesStore(homeyLike),
      assignmentsStore,
      getZoneTree: () => ZONES,
      getDevices: () => [{ deviceId: 'd-moving', zoneId: 'z2' }],
      getLogger: () => undefined,
      getMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: null }),
      legacyMultiHomeEnabled: true,
    });
    service.recompute();
    const ctx = {
      homey: homeyLike,
      homeMembership: service,
      latestTargetSnapshot: [{
        id: 'd-moving',
        name: 'Moving heater',
        targets: [],
        binaryControl: { on: false },
      }],
      deviceDiagnosticsService: {
        getStarvedRescueEntries: () => [{
          deviceId: 'd-moving',
          starvation: { isStarved: true, accumulatedMs: 20 * 60_000 },
          intendedNormalTargetC: 60,
        }],
      },
      getNow: () => new Date('2026-01-15T12:00:00.000Z'),
    } as unknown as AppContext;

    expect(resolveSmartTaskHomeScope(ctx, 'd-moving')).toBe('sub_home');
    expect(buildStarvedRescueDevices(ctx)).toEqual([]);

    // The settings value has moved the device back to Main, but the producer
    // has not recomputed/prepared/committed that generation yet. Cached h_a is
    // provisional, not durable relocation evidence.
    assignmentsStore.write({ 'd-moving': 'main' });
    service.observeOwnershipConfigurationChanged();
    expect(service.hasPendingOwnershipGeneration()).toBe(true);
    expect(isSmartTaskDeviceInMainHome(ctx, 'd-moving')).toBe(true);
    expect(resolveSmartTaskHomeScope(ctx, 'd-moving')).toBe('unavailable');
    expect(buildStarvedRescueDevices(ctx)).toEqual([
      expect.objectContaining({
        deviceId: 'd-moving',
        smartTaskHomeScope: 'unavailable',
      }),
    ]);

    service.recompute();
    const generation = service.getObservedOwnershipGeneration();
    expect(service.commitPreparedOwnershipGeneration(generation)).toBe(true);
    expect(resolveSmartTaskHomeScope(ctx, 'd-moving')).toBe('main');
    expect(buildStarvedRescueDevices(ctx)).toEqual([
      expect.objectContaining({
        deviceId: 'd-moving',
        smartTaskHomeScope: 'main',
      }),
    ]);
  });

  it('keeps Main and sub-home readiness closed after a first suspect homes read', () => {
    let homesReadCount = 0;
    const homesStore: HomesStore = {
      read: () => {
        homesReadCount += 1;
        return homesReadCount === 1
          ? { state: 'suspect' }
          : { state: 'present', value: ACTIVE_HOME_CONFIG };
      },
      write: vi.fn(),
    };
    const onOwnershipReady = vi.fn();
    const service = new HomeMembershipService({
      homesStore,
      assignmentsStore: unwrittenAssignments,
      getZoneTree: () => ZONES,
      getDevices: () => [{ deviceId: 'd-sub', zoneId: 'z2' }],
      getLogger: () => undefined,
      getMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: 'm-main' }),
      legacyMultiHomeEnabled: true,
      onZoneTreeCommitReady: onOwnershipReady,
    });

    service.recompute();
    expect(service.getHomeIdForDevice('d-sub')).toBe('main');
    expect(service.isOwnershipReady()).toBe(false);
    expect(service.isMainHomeActuationFenced()).toBe(true);
    expect(onOwnershipReady).not.toHaveBeenCalled();

    service.recompute();
    expect(service.getHomeIdForDevice('d-sub')).toBe('h_a');
    expect(service.isOwnershipReady()).toBe(true);
    expect(service.isMainHomeActuationFenced()).toBe(false);
    expect(onOwnershipReady).toHaveBeenCalledTimes(1);
  });

  it('keeps both owners closed until a first suspect pin store reveals the durable pin', () => {
    let pinsReadCount = 0;
    const assignmentsStore: DeviceHomeAssignmentsStore = {
      read: () => {
        pinsReadCount += 1;
        return pinsReadCount === 1
          ? { state: 'suspect' }
          : { state: 'present', value: { 'd-pinned': 'h_a' } };
      },
      write: vi.fn(),
    };
    const onOwnershipReady = vi.fn();
    const service = new HomeMembershipService({
      homesStore: {
        read: () => ({ state: 'present', value: ACTIVE_HOME_CONFIG }),
        write: vi.fn(),
      },
      assignmentsStore,
      getZoneTree: () => ZONES,
      // Zone-only resolution says Main; the durable pin moves it behind the
      // sub-home meter once the assignments store becomes trustworthy.
      getDevices: () => [{ deviceId: 'd-pinned', zoneId: 'z1' }],
      getLogger: () => undefined,
      getMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: 'm-main' }),
      legacyMultiHomeEnabled: true,
      onZoneTreeCommitReady: onOwnershipReady,
    });
    const ctx = { homeMembership: service } as unknown as AppContext;

    service.recompute();
    expect(service.getHomeIdForDevice('d-pinned')).toBe('main');
    expect(service.isOwnershipReady()).toBe(false);
    expect(service.isMainHomeActuationFenced()).toBe(true);
    expect(isSmartTaskDeviceInMainHome(ctx, 'd-pinned')).toBe(true);
    expect(hasMainHomeSmartTaskAuthority(ctx, 'd-pinned')).toBe(false);
    expect(onOwnershipReady).not.toHaveBeenCalled();

    service.recompute();
    expect(service.getHomeIdForDevice('d-pinned')).toBe('h_a');
    expect(service.isOwnershipReady()).toBe(true);
    expect(service.isMainHomeActuationFenced()).toBe(false);
    expect(isSmartTaskDeviceInMainHome(ctx, 'd-pinned')).toBe(false);
    expect(hasMainHomeSmartTaskAuthority(ctx, 'd-pinned')).toBe(false);
    expect(onOwnershipReady).toHaveBeenCalledTimes(1);
  });

  it('requires a real zone tree for active sub-home ownership but not a resolved single home', () => {
    let zoneTree: ZoneTree | null = null;
    const onOwnershipReady = vi.fn();
    const activeService = new HomeMembershipService({
      homesStore: {
        read: () => ({ state: 'present', value: ACTIVE_HOME_CONFIG }),
        write: vi.fn(),
      },
      assignmentsStore: unwrittenAssignments,
      getZoneTree: () => zoneTree,
      getDevices: () => [{ deviceId: 'd-sub', zoneId: 'z2' }],
      getLogger: () => undefined,
      getMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: 'm-main' }),
      legacyMultiHomeEnabled: true,
      onZoneTreeCommitReady: onOwnershipReady,
    });
    activeService.recompute();
    expect(activeService.isOwnershipReady()).toBe(false);
    expect(activeService.isMainHomeActuationFenced()).toBe(true);
    expect(hasMainHomeSmartTaskAuthority(
      { homeMembership: activeService } as unknown as AppContext,
      'd-sub',
    )).toBe(false);

    zoneTree = ZONES;
    activeService.recompute();
    expect(activeService.isOwnershipReady()).toBe(true);
    expect(onOwnershipReady).toHaveBeenCalledTimes(1);

    const singleHomeService = new HomeMembershipService({
      homesStore: { read: () => ({ state: 'unwritten' }), write: vi.fn() },
      assignmentsStore: unwrittenAssignments,
      getZoneTree: () => null,
      getDevices: () => [{ deviceId: 'd-main', zoneId: null }],
      getLogger: () => undefined,
      getMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: null }),
      legacyMultiHomeEnabled: true,
    });
    singleHomeService.recompute();
    expect(singleHomeService.isOwnershipReady()).toBe(true);
    expect(singleHomeService.isMainHomeActuationFenced()).toBe(false);
    expect(isSmartTaskDeviceInMainHome(
      { homeMembership: singleHomeService } as unknown as AppContext,
      'd-main',
    )).toBe(true);
    expect(hasMainHomeSmartTaskAuthority(
      { homeMembership: singleHomeService } as unknown as AppContext,
      'd-main',
    )).toBe(true);
  });

  it('publishes readiness even when the deferred seed retry throws', () => {
    let zoneTree: ZoneTree | null = null;
    const { error, logger } = makeLoggerSpy();
    const onRecoveryNeeded = vi.fn();
    const onZoneTreeCommitReady = vi.fn();
    const service = new HomeMembershipService({
      homesStore: {
        read: () => ({ state: 'present', value: ACTIVE_HOME_CONFIG }),
        write: vi.fn(),
      },
      assignmentsStore: unwrittenAssignments,
      getZoneTree: () => zoneTree,
      getDevices: () => [{ deviceId: 'd-sub', zoneId: 'z2' }],
      getLogger: () => logger,
      getMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: 'm-main' }),
      legacyMultiHomeEnabled: true,
      onOwnershipReadyBeforePlanWork: () => {
        throw new Error('settings unavailable');
      },
      onMainAuthorityUnresolved: onRecoveryNeeded,
      onZoneTreeCommitReady,
    });

    service.recompute();
    zoneTree = ZONES;
    expect(() => service.recompute()).not.toThrow();

    expect(service.isOwnershipReady()).toBe(true);
    expect(onZoneTreeCommitReady).toHaveBeenCalledOnce();
    expect(onRecoveryNeeded).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'home_ownership_seed_retry_failed',
    }));
  });

  it('retries deferred seeds before preparing every later ownership generation', async () => {
    vi.useFakeTimers();
    createHomesStore(homeyLike).write(ACTIVE_HOME_CONFIG);
    createDeviceHomeAssignmentsStore(homeyLike).write({});
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'meter-main');

    const order: string[] = [];
    let failPendingSeedOnce = true;
    const retryDeferredOvershootSeed = vi.fn((
      _membership: HomeMembershipService,
      allowPending: boolean,
    ) => {
      order.push(`seed:${allowPending}`);
      if (allowPending && failPendingSeedOnce) {
        failPendingSeedOnce = false;
        throw new Error('overshoot settings unavailable');
      }
    });
    const prepare = vi.fn().mockImplementation(async () => {
      order.push('prepare');
      return true;
    });
    const rebuildPlanFromCache = vi.fn().mockImplementation(async (reason?: string) => {
      // Converging main after membership settles is a rebuild now — it used to be
      // a separate `reconcileLatestPlanState` call — so record which one ran to
      // keep the ordering assertion legible.
      order.push(reason === 'home_membership_settled' ? 'settle' : 'rebuild');
      return { failed: false, appliedActions: false };
    });
    const reconcilePrepared = vi.fn().mockResolvedValue(true);
    const timers = new TimerRegistry();
    const ctx = {
      homey: homeyLike,
      timers,
      deviceManager: {
        getZoneTree: () => ZONES,
        getSnapshot: () => [{ id: 'd-sub', zoneId: 'z2' }],
        setOnZoneTreeCommitted: vi.fn(),
        setOnDeviceZoneChanged: vi.fn(),
      },
      planService: { rebuildPlanFromCache },
      powerTracker: {},
      getStructuredLogger: () => undefined,
    } as unknown as AppContext;
    const wiring = wireHomeMembership(ctx, new ObservedStateEmitter(), {
      onOwnershipReadyBeforePlanWork: retryDeferredOvershootSeed,
      ownershipGenerationRuntime: {
        getMainStableSampleRevision: () => ({ state: 'stable', revision: 1 }),
        beginMainPreparedReconcile: () => () => undefined,
        prepare,
        isPreparedCurrent: () => true,
        reconcile: reconcilePrepared,
        flushMainShortfallSideEffect: async () => true,
      },
    });

    try {
      expect(retryDeferredOvershootSeed).toHaveBeenCalledWith(wiring.service, false);
      vi.clearAllMocks();
      order.length = 0;

      wiring.service.observeOwnershipConfigurationChanged();
      await vi.advanceTimersByTimeAsync(1_000);
      await flushHandlerQueue();

      expect(order).toEqual(['seed:true']);
      expect(prepare).not.toHaveBeenCalled();
      expect(rebuildPlanFromCache).not.toHaveBeenCalled();
      expect(wiring.service.hasPendingOwnershipGeneration()).toBe(true);
      expect(timers.has('mainOwnershipRecovery')).toBe(true);

      await vi.advanceTimersByTimeAsync(2_000);
      await flushHandlerQueue();

      expect(order).toEqual(['seed:true', 'seed:true', 'prepare', 'rebuild', 'settle']);
      expect(wiring.service.hasPendingOwnershipGeneration()).toBe(false);
      expect(timers.has('mainOwnershipRecovery')).toBe(false);
    } finally {
      wiring.teardown();
      vi.useRealTimers();
    }
  });

  it('re-probes a first suspect store and recovers readiness without another event', async () => {
    vi.useFakeTimers();
    createHomesStore(homeyLike).write(ACTIVE_HOME_CONFIG);
    // Written-before + absent value classifies the first assignments read
    // suspect. Zone membership is already h_a, so the later `{}` repair does
    // not change the map and cannot rely on the membership fingerprint.
    mockHomeyInstance.settings.set(DEVICE_HOME_ASSIGNMENTS_INITIALIZED, true);
    mockHomeyInstance.settings.unset(DEVICE_HOME_ASSIGNMENTS);
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({ failed: false });
    const emitter = new ObservedStateEmitter();
    const ctx = {
      homey: homeyLike,
      timers: new TimerRegistry(),
      deviceManager: {
        getZoneTree: () => ZONES,
        getSnapshot: () => [{ id: 'd-sub', zoneId: 'z2' }],
        setOnZoneTreeCommitted: vi.fn(),
        setOnDeviceZoneChanged: vi.fn(),
      },
      planService: { rebuildPlanFromCache },
      // A real app always carries a tracker; empty = no sample restored across
      // a restart, so the sampled clause has no unattributed watts to fence.
      powerTracker: {},
      getStructuredLogger: () => undefined,
    } as unknown as AppContext;
    const wiring = wireHomeMembership(ctx, emitter);
    try {
      expect(wiring.service.getHomeIdForDevice('d-sub')).toBe('h_a');
      expect(wiring.service.isOwnershipReady()).toBe(false);
      expect(ctx.timers.has('mainOwnershipRecovery')).toBe(true);
      expect(rebuildPlanFromCache).not.toHaveBeenCalled();

      // Repair the boundary only. No settings handler, snapshot, tree commit,
      // or direct service recompute follows; the owned retry must re-read it.
      createDeviceHomeAssignmentsStore(homeyLike).write({});
      await vi.advanceTimersByTimeAsync(1000);
      await flushHandlerQueue();

      expect(wiring.service.getHomeIdForDevice('d-sub')).toBe('h_a');
      expect(wiring.service.isOwnershipReady()).toBe(true);
      expect(countGenerationRebuilds(rebuildPlanFromCache)).toBe(1);
      expect(countGenerationRebuilds(rebuildPlanFromCache)).toBeGreaterThan(0);
      expect(countSettleRebuilds(rebuildPlanFromCache)).toBe(1);
      expect(ctx.timers.has('mainOwnershipRecovery')).toBe(false);
    } finally {
      wiring.teardown();
      vi.useRealTimers();
    }
  });

  it.each(['main_meter', 'area_meter'] as const)(
    'rebuilds and reconciles after a collision is repaired through %s without a sample',
    async (repairLane) => {
    vi.useFakeTimers();
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-shared' }],
    });
    createDeviceHomeAssignmentsStore(homeyLike).write({});
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'm-shared');
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({ failed: false });
    const ctx = {
      homey: homeyLike,
      timers: new TimerRegistry(),
      deviceManager: {
        getZoneTree: () => ZONES,
        getSnapshot: () => [],
        setOnZoneTreeCommitted: vi.fn(),
        setOnDeviceZoneChanged: vi.fn(),
      },
      planService: { rebuildPlanFromCache },
      // A real app always carries a tracker; empty = no sample restored across
      // a restart, so the sampled clause has no unattributed watts to fence.
      powerTracker: {},
      getStructuredLogger: () => undefined,
    } as unknown as AppContext;
    const wiring = wireHomeMembership(ctx, new ObservedStateEmitter());
    try {
      expect(wiring.service.isMainHomeActuationFenced()).toBe(true);
      if (repairLane === 'main_meter') {
        mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'm-main');
      } else {
        createHomesStore(homeyLike).write({
          activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
          subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-sub' }],
        });
      }
      wiring.requestMainAuthorityRecovery?.();

      await vi.advanceTimersByTimeAsync(1000);
      await flushHandlerQueue();

      expect(wiring.service.isMainHomeActuationFenced()).toBe(false);
      expect(countGenerationRebuilds(rebuildPlanFromCache)).toBeGreaterThan(0);
      expect(countSettleRebuilds(rebuildPlanFromCache)).toBe(1);
    } finally {
      wiring.teardown();
      vi.useRealTimers();
    }
    },
  );

  it('keeps the sampled-meter takeover fenced until a fresh rebuild succeeds', async () => {
    vi.useFakeTimers();
    createHomesStore(homeyLike).write({
      activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
      subHomes: [{ ...SUB_HOME_A, meterDeviceId: 'm-area' }],
    });
    createDeviceHomeAssignmentsStore(homeyLike).write({});
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, null);

    const rebuildPlanFromCache = vi.fn()
      .mockResolvedValueOnce({ failed: true })
      .mockResolvedValue({ failed: false });
    const timers = new TimerRegistry();
    const ctx = {
      homey: homeyLike,
      timers,
      deviceManager: {
        getZoneTree: () => ZONES,
        getSnapshot: () => [{ id: 'd-sub', zoneId: 'z2' }],
        setOnZoneTreeCommitted: vi.fn(),
        setOnDeviceZoneChanged: vi.fn(),
      },
      planService: { rebuildPlanFromCache },
      powerTracker: {},
      getStructuredLogger: () => undefined,
    } as unknown as AppContext;
    const wiring = wireHomeMembership(ctx, new ObservedStateEmitter());

    try {
      wiring.service.noteResolvedHomeMeter('m-area', Date.now());
      expect(wiring.service.isMainHomeActuationFenced()).toBe(true);

      // The replacement sample repairs provenance, but the synchronous
      // ownership-generation takeover keeps the old committed plan fenced.
      wiring.service.noteResolvedHomeMeter('m-main', Date.now());
      expect(wiring.service.hasPendingOwnershipGeneration()).toBe(true);
      expect(wiring.service.isMainHomeActuationFenced()).toBe(true);
      expect(timers.has('mainOwnershipRecovery')).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(countGenerationRebuilds(rebuildPlanFromCache)).toBe(1);
      expect(countSettleRebuilds(rebuildPlanFromCache)).toBe(0);
      expect(wiring.service.hasPendingOwnershipGeneration()).toBe(true);
      expect(wiring.service.isMainHomeActuationFenced()).toBe(true);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(countGenerationRebuilds(rebuildPlanFromCache)).toBe(2);
      expect(countSettleRebuilds(rebuildPlanFromCache)).toBe(1);
      expect(wiring.service.hasPendingOwnershipGeneration()).toBe(false);
      expect(wiring.service.isMainHomeActuationFenced()).toBe(false);
    } finally {
      wiring.teardown();
      vi.useRealTimers();
    }
  });

  it('re-probes a transient Main-meter read and retries a failed fresh rebuild without a sample', async () => {
    vi.useFakeTimers();
    createHomesStore(homeyLike).write(ACTIVE_HOME_CONFIG);
    createDeviceHomeAssignmentsStore(homeyLike).write({});
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'meter-main');

    const rebuildPlanFromCache = vi.fn()
      .mockResolvedValueOnce({ failed: true })
      .mockResolvedValue({ failed: false });
    const timers = new TimerRegistry();
    const emitter = new ObservedStateEmitter();
    const ctx = {
      homey: homeyLike,
      timers,
      deviceManager: {
        getZoneTree: () => ZONES,
        getSnapshot: () => [{ id: 'd-sub', zoneId: 'z2' }],
        setOnZoneTreeCommitted: vi.fn(),
        setOnDeviceZoneChanged: vi.fn(),
      },
      planService: { rebuildPlanFromCache },
      // A real app always carries a tracker; empty = no sample restored across
      // a restart, so the sampled clause has no unattributed watts to fence.
      powerTracker: {},
      getStructuredLogger: () => undefined,
    } as unknown as AppContext;
    const wiring = wireHomeMembership(ctx, emitter);
    const originalGet = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
    let failMainReadOnce = true;
    const getSpy = vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementation((key: string) => {
      if (key === HOMEY_ENERGY_METER_DEVICE_ID && failMainReadOnce) {
        failMainReadOnce = false;
        return undefined;
      }
      return originalGet(key);
    });

    try {
      // The explicit key still exists, so undefined is suspect and closes the
      // final Main write seam. That point-of-use read schedules its own retry;
      // no sample, refresh, or settings event follows.
      expect(wiring.service.isMainHomeActuationFenced()).toBe(true);
      expect(timers.has('mainOwnershipRecovery')).toBe(true);
      expect(rebuildPlanFromCache).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(countGenerationRebuilds(rebuildPlanFromCache)).toBe(1);
      expect(countSettleRebuilds(rebuildPlanFromCache)).toBe(0);
      expect(timers.has('mainOwnershipRecovery')).toBe(true);

      await vi.advanceTimersByTimeAsync(2000);
      expect(countGenerationRebuilds(rebuildPlanFromCache)).toBe(2);
      expect(countGenerationRebuilds(rebuildPlanFromCache)).toBeGreaterThan(0);
      expect(countSettleRebuilds(rebuildPlanFromCache)).toBe(1);
      expect(timers.has('mainOwnershipRecovery')).toBe(false);
    } finally {
      getSpy.mockRestore();
      wiring.teardown();
      vi.useRealTimers();
    }
  });

  it('preserves a retry requested by the final actuator while reconcile is in flight', async () => {
    vi.useFakeTimers();
    createHomesStore(homeyLike).write(ACTIVE_HOME_CONFIG);
    createDeviceHomeAssignmentsStore(homeyLike).write({});
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'meter-main');

    const timers = new TimerRegistry();
    const emitter = new ObservedStateEmitter();
    let wiring: ReturnType<typeof wireHomeMembership> | undefined = undefined;
    let mainReadUnavailable = true;
    let settleRebuilds = 0;
    const rebuildPlanFromCache = vi.fn().mockImplementation(async (reason?: string) => {
      if (reason !== 'home_membership_settled') return { failed: false, appliedActions: false };
      settleRebuilds += 1;
      if (settleRebuilds === 1) {
        // Model the final actuator's point-of-use fence closing AFTER the
        // recovery's pre-convergence check. It schedules a newer recovery request
        // even though PlanService reports the rebuild as completed.
        mainReadUnavailable = true;
        if (!wiring) throw new Error('membership wiring is not initialized');
        expect(wiring.service.isMainHomeActuationFenced()).toBe(true);
      }
      return { failed: false, appliedActions: false };
    });
    const ctx = {
      homey: homeyLike,
      timers,
      deviceManager: {
        getZoneTree: () => ZONES,
        getSnapshot: () => [{ id: 'd-sub', zoneId: 'z2' }],
        setOnZoneTreeCommitted: vi.fn(),
        setOnDeviceZoneChanged: vi.fn(),
      },
      planService: { rebuildPlanFromCache },
      // A real app always carries a tracker; empty = no sample restored across
      // a restart, so the sampled clause has no unattributed watts to fence.
      powerTracker: {},
      getStructuredLogger: () => undefined,
    } as unknown as AppContext;
    wiring = wireHomeMembership(ctx, emitter);
    const originalGet = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
    const getSpy = vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementation((key: string) => (
      key === HOMEY_ENERGY_METER_DEVICE_ID && mainReadUnavailable
        ? undefined
        : originalGet(key)
    ));

    try {
      expect(wiring.service.isMainHomeActuationFenced()).toBe(true);
      mainReadUnavailable = false;
      await vi.advanceTimersByTimeAsync(1000);

      expect(countGenerationRebuilds(rebuildPlanFromCache)).toBe(1);
      expect(countSettleRebuilds(rebuildPlanFromCache)).toBe(1);
      // The in-reconcile fence requested a retry. Completion must not clear it.
      expect(timers.has('mainOwnershipRecovery')).toBe(true);

      mainReadUnavailable = false;
      await vi.advanceTimersByTimeAsync(2000);
      expect(countGenerationRebuilds(rebuildPlanFromCache)).toBe(2);
      expect(countSettleRebuilds(rebuildPlanFromCache)).toBe(2);
      expect(timers.has('mainOwnershipRecovery')).toBe(false);
    } finally {
      getSpy.mockRestore();
      wiring.teardown();
      vi.useRealTimers();
    }
  });

  it('rolls back a generation when the post-reconcile shortfall flush rejects, then accepts later generations', async () => {
    vi.useFakeTimers();
    createHomesStore(homeyLike).write(ACTIVE_HOME_CONFIG);
    createDeviceHomeAssignmentsStore(homeyLike).write({});
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'meter-main');

    const rebuildPlanFromCache = vi.fn().mockResolvedValue({ failed: false });
    const prepare = vi.fn().mockResolvedValue(true);
    const reconcilePrepared = vi.fn().mockResolvedValue(true);
    let rejectNextFlush = false;
    const flushMainShortfallSideEffect = vi.fn().mockImplementation(async () => {
      if (!rejectNextFlush) return true;
      rejectNextFlush = false;
      throw new Error('shortfall trigger unavailable');
    });
    const timers = new TimerRegistry();
    const ctx = {
      homey: homeyLike,
      timers,
      deviceManager: {
        getZoneTree: () => ZONES,
        getSnapshot: () => [{ id: 'd-sub', zoneId: 'z2' }],
        setOnZoneTreeCommitted: vi.fn(),
        setOnDeviceZoneChanged: vi.fn(),
      },
      planService: { rebuildPlanFromCache },
      // A real app always carries a tracker; empty = no sample restored across
      // a restart, so the sampled clause has no unattributed watts to fence.
      powerTracker: {},
      getStructuredLogger: () => undefined,
    } as unknown as AppContext;
    const wiring = wireHomeMembership(ctx, new ObservedStateEmitter(), {
      ownershipGenerationRuntime: {
        getMainStableSampleRevision: () => ({ state: 'stable', revision: 1 }),
        beginMainPreparedReconcile: () => () => undefined,
        prepare,
        isPreparedCurrent: () => true,
        reconcile: reconcilePrepared,
        flushMainShortfallSideEffect,
      },
    });

    try {
      await flushHandlerQueue();
      vi.clearAllMocks();

      rejectNextFlush = true;
      wiring.service.observeOwnershipConfigurationChanged();
      await vi.advanceTimersByTimeAsync(1_000);
      await flushHandlerQueue();

      expect(wiring.service.hasPendingOwnershipGeneration()).toBe(true);
      expect(wiring.service.isMainHomeActuationFenced()).toBe(true);
      expect(timers.has('mainOwnershipRecovery')).toBe(true);

      await vi.advanceTimersByTimeAsync(2_000);
      await flushHandlerQueue();

      expect(wiring.service.hasPendingOwnershipGeneration()).toBe(false);
      expect(wiring.service.isMainHomeActuationFenced()).toBe(false);
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(reconcilePrepared).toHaveBeenCalledTimes(2);

      wiring.service.observeOwnershipConfigurationChanged();
      await vi.advanceTimersByTimeAsync(1_000);
      await flushHandlerQueue();

      expect(wiring.service.hasPendingOwnershipGeneration()).toBe(false);
      expect(wiring.service.isMainHomeActuationFenced()).toBe(false);
      expect(prepare).toHaveBeenCalledTimes(3);
      expect(reconcilePrepared).toHaveBeenCalledTimes(3);
    } finally {
      wiring.teardown();
      vi.useRealTimers();
    }
  });

  it('never reopens an intermediate ownership generation while a newer one waits', async () => {
    vi.useFakeTimers();
    createHomesStore(homeyLike).write(ACTIVE_HOME_CONFIG);
    createDeviceHomeAssignmentsStore(homeyLike).write({});
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'meter-main');

    let releaseFirstPrepare: (value: boolean) => void = () => undefined;
    const firstPrepare = new Promise<boolean>((resolve) => {
      releaseFirstPrepare = resolve;
    });
    const prepare = vi.fn()
      .mockImplementationOnce(() => firstPrepare)
      .mockResolvedValue(true);
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({ failed: false });
    const reconcilePrepared = vi.fn().mockResolvedValue(true);
    const timers = new TimerRegistry();
    const ctx = {
      homey: homeyLike,
      timers,
      deviceManager: {
        getZoneTree: () => ZONES,
        getSnapshot: () => [{ id: 'd-sub', zoneId: 'z2' }],
        setOnZoneTreeCommitted: vi.fn(),
        setOnDeviceZoneChanged: vi.fn(),
      },
      planService: { rebuildPlanFromCache },
      // A real app always carries a tracker; empty = no sample restored across
      // a restart, so the sampled clause has no unattributed watts to fence.
      powerTracker: {},
      getStructuredLogger: () => undefined,
    } as unknown as AppContext;
    const wiring = wireHomeMembership(ctx, new ObservedStateEmitter(), {
      ownershipGenerationRuntime: {
        getMainStableSampleRevision: () => ({ state: 'stable', revision: 1 }),
        beginMainPreparedReconcile: () => () => undefined,
        prepare,
        isPreparedCurrent: () => true,
        reconcile: reconcilePrepared,
        flushMainShortfallSideEffect: async () => true,
      },
    });

    try {
      await flushHandlerQueue();
      vi.clearAllMocks();

      wiring.service.observeOwnershipConfigurationChanged();
      await vi.advanceTimersByTimeAsync(1_000);
      await flushHandlerQueue();
      expect(prepare).toHaveBeenCalledTimes(1);

      wiring.service.observeOwnershipConfigurationChanged();
      releaseFirstPrepare(true);
      await flushHandlerQueue();

      expect(wiring.service.hasPendingOwnershipGeneration()).toBe(true);
      expect(wiring.service.isMainHomeActuationFenced()).toBe(true);
      expect(rebuildPlanFromCache).not.toHaveBeenCalled();
      expect(countSettleRebuilds(rebuildPlanFromCache)).toBe(0);
      expect(reconcilePrepared).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);
      await flushHandlerQueue();

      expect(prepare).toHaveBeenCalledTimes(2);
      expect(countGenerationRebuilds(rebuildPlanFromCache)).toBe(1);
      expect(countSettleRebuilds(rebuildPlanFromCache)).toBe(1);
      expect(reconcilePrepared).toHaveBeenCalledTimes(1);
      expect(wiring.service.hasPendingOwnershipGeneration()).toBe(false);
      expect(wiring.service.isMainHomeActuationFenced()).toBe(false);
      expect(timers.has('mainOwnershipRecovery')).toBe(false);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(countGenerationRebuilds(rebuildPlanFromCache)).toBe(1);
      expect(reconcilePrepared).toHaveBeenCalledTimes(1);
    } finally {
      wiring.teardown();
      vi.useRealTimers();
    }
  });

  it('retries a generation when the Main sample is superseded during dispatch', async () => {
    vi.useFakeTimers();
    createHomesStore(homeyLike).write(ACTIVE_HOME_CONFIG);
    createDeviceHomeAssignmentsStore(homeyLike).write({});
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'meter-main');

    let mainSample: StableSampleRevision = { state: 'stable', revision: 1 };
    let supersedeDuringDispatch = false;
    const rebuildPlanFromCache = vi.fn().mockImplementation(async (
      reason?: string,
      shouldAbort?: () => boolean,
    ) => {
      if (reason !== 'home_membership_settled') return { failed: false, appliedActions: false };
      if (supersedeDuringDispatch) {
        supersedeDuringDispatch = false;
        expect(shouldAbort?.()).toBe(false);
        mainSample = { state: 'pending' };
      }
      return { failed: false, appliedActions: false };
    });
    const prepare = vi.fn().mockResolvedValue(true);
    const reconcilePrepared = vi.fn().mockResolvedValue(true);
    const flushMainShortfallSideEffect = vi.fn().mockResolvedValue(true);
    const timers = new TimerRegistry();
    const ctx = {
      homey: homeyLike,
      timers,
      deviceManager: {
        getZoneTree: () => ZONES,
        getSnapshot: () => [{ id: 'd-sub', zoneId: 'z2' }],
        setOnZoneTreeCommitted: vi.fn(),
        setOnDeviceZoneChanged: vi.fn(),
      },
      planService: { rebuildPlanFromCache },
      // A real app always carries a tracker; empty = no sample restored across
      // a restart, so the sampled clause has no unattributed watts to fence.
      powerTracker: {},
      getStructuredLogger: () => undefined,
    } as unknown as AppContext;
    const wiring = wireHomeMembership(ctx, new ObservedStateEmitter(), {
      ownershipGenerationRuntime: {
        getMainStableSampleRevision: () => mainSample,
        beginMainPreparedReconcile: () => () => undefined,
        prepare,
        isPreparedCurrent: () => true,
        reconcile: reconcilePrepared,
        flushMainShortfallSideEffect,
      },
    });

    try {
      await flushHandlerQueue();
      vi.clearAllMocks();

      supersedeDuringDispatch = true;
      wiring.service.observeOwnershipConfigurationChanged();
      await vi.advanceTimersByTimeAsync(1_000);
      await flushHandlerQueue();

      expect(wiring.service.hasPendingOwnershipGeneration()).toBe(true);
      expect(wiring.service.isMainHomeActuationFenced()).toBe(true);
      expect(flushMainShortfallSideEffect).not.toHaveBeenCalled();
      expect(timers.has('mainOwnershipRecovery')).toBe(true);

      mainSample = { state: 'stable', revision: 2 };
      await vi.advanceTimersByTimeAsync(2_000);
      await flushHandlerQueue();

      expect(countGenerationRebuilds(rebuildPlanFromCache)).toBe(2);
      expect(countSettleRebuilds(rebuildPlanFromCache)).toBe(2);
      expect(reconcilePrepared).toHaveBeenCalledTimes(2);
      expect(flushMainShortfallSideEffect).toHaveBeenCalledOnce();
      expect(wiring.service.hasPendingOwnershipGeneration()).toBe(false);
      expect(wiring.service.isMainHomeActuationFenced()).toBe(false);
    } finally {
      wiring.teardown();
      vi.useRealTimers();
    }
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
    getMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: null }),
    legacyMultiHomeEnabled: true,
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
