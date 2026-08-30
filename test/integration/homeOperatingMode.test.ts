// Integration coverage for the per-home operating mode (multi-home):
// - the settings→bundle seam: an `operating_mode:<homeId>` write routes
//   through the REAL settings handler to ONE bundle's mode rebuild — never to
//   main's mode handler, main's snapshot loader, or the global Flow trigger;
// - the resolution chain (per-home value → global default) observable in the
//   bundle diagnostics, with transitions edge-logged NAMING the home;
// - the stuck-cold guard: a pinned mode with no `mode_device_targets` record
//   follows the global mode — the effective mode always indexes a real
//   record, never an empty-object default;
// - the global mode fan-out still reaching every home without a pinned mode;
// - the rename seam: the UI publishes the new record alongside the old one
//   before a `mode_aliases` write fans out to sub-home plans, then removes the
//   old record only after every pin resolves to the new one — no intermediate
//   global fallback may actuate a warmer target;
// - the malformed-pin boundary: a non-string `operating_mode:<homeId>` value
//   fails safe onto the global mode — never read as an intentional unpin;
// - the priorities seam: a `capacity_priorities` reorder fans out to sub-home
//   plans, so a pinned area adopts its new shedding order without waiting for
//   an unrelated rebuild;
// - the read-failure boundary: a THROWN `operating_mode:<homeId>` settings
//   read is contained at the adapter, `HomeModeCatalog` reports its own
//   unavailability, and the mode-change rebuild still completes;
// - fulfilled `undefined` for an existing pin and a store-wide empty key list
//   are suspect reads that preserve a known pin; only a healthy key list that
//   omits the pin proves a genuine unpin;
// - the device-scoped reader feeding the overshoot default seed: a THROWN pin
//   read must SKIP the seed, never persist a default derived from the global
//   mode (that write outlives the transient failure).
// Pin faults (`unconfigured_mode`, `malformed_pin`) are NOT logged by any
// production path — `resolveOperatingModeForDevice` folds them into
// `unavailable` and skips the seed silently, so these tests assert the
// containment, not an event.
// Only outward seams are mocked: the shared mock Homey settings store backs
// the real homes store and settings handler; bundles run their real plan
// engine/service.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Homey from 'homey';
import type { AppContext } from '../../lib/app/appContext';
import {
  HOME_CONFIG_ACTIVATION_VERSION,
  type HomeConfig,
} from '../../lib/home/homeConfig';
import { HomeRuntimeRegistry } from '../../setup/homeRuntime/homeRuntimeRegistry';
import { resolveOperatingModeForDevice } from '../../setup/homeRuntime/homeOperatingMode';
import { disableUnsupportedDevices } from '../../setup/appDeviceSupport';
import { HomeMembershipService } from '../../setup/homeMembership';
import {
  createDeviceHomeAssignmentsStore,
  createHomesStore as createRawHomesStore,
} from '../../setup/homeRegistryAdapter';
import { initSettingsHandlerForApp } from '../../setup/appSettingsHelpers';
import { buildHomeRuntimeSettingsHooks } from '../../setup/appInit/wireHomeRuntimeRegistry';
import { PlanService } from '../../lib/plan/planService';
import { getLogger } from '../../lib/logging/logger';
import { resolveModeName } from '../../lib/utils/capacityHelpers';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import {
  CAPACITY_PRIORITIES,
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  MODE_ALIASES,
  MODE_DEVICE_TARGETS,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
  POWER_SOURCE,
} from '../../lib/utils/settingsKeys';
import {
  createHomeModeCatalog,
  getConfiguredPriorityFromHomeModeCatalog,
  readPersistedHomeModeCatalog,
  transferModeTargetsForOwnershipMoves,
} from '../../setup/homeRuntime/homeModeCatalog';
import { drainPending } from '../utils/asyncDrain';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import { mockHomeyInstance } from '../mocks/homey';

const homeyLike = mockHomeyInstance as unknown as Homey.App['homey'];

const HOME_A = { homeId: 'h_a', name: 'Annex', rootZoneId: 'z2', meterDeviceId: 'm-a' };
const HOME_B = { homeId: 'h_b', name: 'Cabin', rootZoneId: 'z3', meterDeviceId: 'm-b' };
const writeActiveHomesConfig = (config: HomeConfig): void => {
  createRawHomesStore(homeyLike).write({
    ...config,
    activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
  });
};

type Rig = { ctx: AppContext; registry: HomeRuntimeRegistry };

const buildRig = (): Rig => {
  const ctx = createAppContextMock({
    homey: homeyLike,
    deviceManager: {
      getSnapshot: () => [],
      getBinaryCommandConfirmationSnapshot: () => [],
      getAssociatedCar: () => undefined,
      requestBinaryControl: vi.fn(async () => undefined),
      requestTemperatureTarget: vi.fn(async (_deviceId: string, desired: number) => desired),
      resolveTemperatureTarget: vi.fn((_deviceId: string, desired: number) => desired),
      requestSteppedLoadStep: vi.fn(async () => ({ requested: false })),
    } as unknown as AppContext['deviceManager'],
    latestTargetSnapshot: [],
    // Route the mock's structured-log seam to the REAL root logger so the
    // shared captureLogger helper observes the accessor's transition events.
    getStructuredLogger: (component: string) => getLogger(component),
  });
  ctx.modeDeviceTargets = {
    Home: { 'dev-1': 21 },
    Cooler: { 'dev-1': 16 },
    Away: { 'dev-1': 12 },
  };
  ctx.capacityPriorities = {
    Home: { 'dev-1': 1 },
    Cooler: { 'dev-1': 7 },
  };
  const registry = new HomeRuntimeRegistry({
    ctx,
    isMembershipReady: () => true,
    isRuntimeActive: () => true,
  });
  return { ctx, registry };
};

const diagnosticsFor = (registry: HomeRuntimeRegistry, homeId: string) => {
  const entry = registry.getDiagnostics().find((diag) => diag.homeId === homeId);
  if (!entry) throw new Error(`no bundle diagnostics for ${homeId}`);
  return entry;
};

describe('per-home operating mode (settings → bundle seam)', () => {
  let rig: Rig;
  let logs: LoggerCapture;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'],
    });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 0));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    logs = captureLogger();
    rig = buildRig();
  });

  afterEach(async () => {
    rig.registry.teardownAll();
    await drainPending();
    rig.ctx.timers.clearAll();
    logs.restore();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('initializes an area catalog once, filters it by ownership, and commits the marker last', () => {
    rig.ctx.modeAliases = { cooler: 'Cooler' };
    rig.ctx.capacityPriorities = {
      Home: { 'dev-1': 1, 'dev-main': 2 },
      Cooler: { 'dev-main': 1, 'dev-1': 2 },
    };
    rig.ctx.modeDeviceTargets = {
      Home: { 'dev-1': 21, 'dev-main': 20 },
      Cooler: { 'dev-1': 16, 'dev-main': 18 },
    };
    rig.ctx.homeMembership = {
      isOwnershipReady: () => true,
      hasPendingOwnershipGeneration: () => false,
      getHomeIdForDevice: (deviceId: string) => deviceId === 'dev-1' ? 'h_a' : 'main',
    } as unknown as AppContext['homeMembership'];
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set');
    const catalog = createHomeModeCatalog(rig.ctx, 'h_a');

    catalog.reload();

    expect(catalog.isInitialized()).toBe(true);
    expect(catalog.getSnapshot()).toEqual({
      operatingMode: 'Home',
      aliases: { cooler: 'Cooler' },
      priorities: {
        Home: { 'dev-1': 1 },
        Cooler: { 'dev-1': 1 },
      },
      targets: {
        Home: { 'dev-1': 21 },
        Cooler: { 'dev-1': 16 },
      },
    });
    expect(setSpy.mock.calls.at(-1)).toEqual(['mode_catalog_initialized:h_a', true]);
    const writeCount = setSpy.mock.calls.length;
    catalog.reload();
    expect(setSpy).toHaveBeenCalledTimes(writeCount);
  });

  it('initializes an unwritten area catalog when Homey returns null for missing settings', () => {
    rig.ctx.homeMembership = {
      isOwnershipReady: () => true,
      hasPendingOwnershipGeneration: () => false,
      getHomeIdForDevice: (deviceId: string) => deviceId === 'dev-1' ? 'h_a' : 'main',
    } as unknown as AppContext['homeMembership'];
    const originalGet = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
    vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementation((key: string) => (
      originalGet(key) ?? null
    ));
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set');
    const catalog = createHomeModeCatalog(rig.ctx, 'h_a');

    catalog.reload();

    expect(catalog.isInitialized()).toBe(true);
    expect(catalog.getSnapshot()).toMatchObject({
      operatingMode: 'Home',
      priorities: { Home: { 'dev-1': 1 } },
      targets: { Home: { 'dev-1': 21 } },
    });
    expect(setSpy.mock.calls.at(-1)).toEqual(['mode_catalog_initialized:h_a', true]);
  });

  it('creates an independent Home mode instead of inheriting Main’s active mode', () => {
    rig.ctx.operatingMode = 'Away';
    rig.ctx.capacityPriorities = { Away: { 'dev-1': 1 } };
    rig.ctx.modeDeviceTargets = { Away: { 'dev-1': 12 } };
    rig.ctx.homeMembership = {
      isOwnershipReady: () => true,
      hasPendingOwnershipGeneration: () => false,
      getHomeIdForDevice: () => 'h_a',
    } as unknown as AppContext['homeMembership'];
    const catalog = createHomeModeCatalog(rig.ctx, 'h_a');

    catalog.reload();

    expect(catalog.getSnapshot()).toMatchObject({
      operatingMode: 'Home',
      priorities: {
        Away: { 'dev-1': 1 },
        Home: {},
      },
      targets: {
        Away: { 'dev-1': 12 },
        Home: {},
      },
    });
    expect(mockHomeyInstance.settings.get(`${OPERATING_MODE_SETTING}:h_a`)).toBe('Home');
  });

  it('keeps the new Home mode literal when Main previously renamed Home', () => {
    rig.ctx.operatingMode = 'Work';
    rig.ctx.modeAliases = { home: 'Work' };
    rig.ctx.capacityPriorities = { Work: { 'dev-1': 1 } };
    rig.ctx.modeDeviceTargets = { Work: { 'dev-1': 20 } };
    const catalog = createHomeModeCatalog(rig.ctx, 'h_a');

    catalog.reload();

    expect(catalog.getSnapshot()).toMatchObject({
      operatingMode: 'Home',
      aliases: {},
      priorities: { Home: {} },
      targets: { Home: {} },
    });
  });

  it('rejects an active mode that has priorities but no target record', () => {
    mockHomeyInstance.settings.set('mode_catalog_initialized:h_a', true);
    mockHomeyInstance.settings.set('mode_aliases:h_a', {});
    mockHomeyInstance.settings.set('capacity_priorities:h_a', {
      Home: { 'dev-1': 1 },
      Cooler: { 'dev-1': 2 },
    });
    mockHomeyInstance.settings.set('mode_device_targets:h_a', {
      Home: { 'dev-1': 21 },
    });
    mockHomeyInstance.settings.set('operating_mode:h_a', 'Cooler');

    const catalog = createHomeModeCatalog(rig.ctx, 'h_a');
    catalog.reload();

    expect(catalog.getSnapshot().operatingMode).toBe('Home');
  });

  it('initializes area catalogs before owner-aware mode resolution', () => {
    writeActiveHomesConfig({ subHomes: [HOME_A] });
    rig.ctx.operatingMode = 'Away';
    rig.ctx.homeMembership = {
      isOwnershipReady: () => true,
      hasPendingOwnershipGeneration: () => false,
      getHomeIdForDevice: () => 'h_a',
    } as unknown as AppContext['homeMembership'];
    const originalGet = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
    vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementation((key: string) => (
      originalGet(key) ?? null
    ));

    expect(rig.registry.prepareModeCatalogsForOwnership()).toBe(true);

    expect(mockHomeyInstance.settings.get('mode_catalog_initialized:h_a')).toBe(true);
    expect(resolveOperatingModeForDevice(rig.ctx, 'dev-1')).toMatchObject({
      state: 'resolved',
      mode: 'Home',
      homeId: 'h_a',
      catalogHomeId: 'h_a',
    });
  });

  it('carries the configured target, not a lowered live setpoint, across an area move', () => {
    mockHomeyInstance.settings.set('mode_catalog_initialized:h_a', true);
    mockHomeyInstance.settings.set('mode_aliases:h_a', {});
    mockHomeyInstance.settings.set('capacity_priorities:h_a', { Home: { 'dev-1': 1 } });
    mockHomeyInstance.settings.set('mode_device_targets:h_a', { Home: { 'dev-1': 22 } });
    mockHomeyInstance.settings.set('operating_mode:h_a', 'Home');
    mockHomeyInstance.settings.set('mode_catalog_initialized:h_b', true);
    mockHomeyInstance.settings.set('mode_aliases:h_b', {});
    mockHomeyInstance.settings.set('capacity_priorities:h_b', { Home: {} });
    mockHomeyInstance.settings.set('mode_device_targets:h_b', { Home: {} });
    mockHomeyInstance.settings.set('operating_mode:h_b', 'Home');

    const result = transferModeTargetsForOwnershipMoves(rig.ctx, [{
      deviceId: 'dev-1',
      fromHomeId: 'h_a',
      toHomeId: 'h_b',
    }]);

    expect(result).toEqual({ completedDeviceIds: ['dev-1'], failedDeviceIds: [] });
    expect(mockHomeyInstance.settings.get('mode_device_targets:h_b')).toEqual({
      Home: { 'dev-1': 22 },
    });
  });

  it.each([undefined, null])(
    'never recopies Main when the existing initialization marker reads %s',
    (ambiguousMarker) => {
      const catalog = createHomeModeCatalog(rig.ctx, 'h_a');
      catalog.reload();
      mockHomeyInstance.settings.set(`${OPERATING_MODE_SETTING}:h_a`, 'Cooler');
      catalog.reload();
      expect(catalog.getSnapshot().operatingMode).toBe('Cooler');
      const writeCount = vi.spyOn(mockHomeyInstance.settings, 'set').mock.calls.length;
      const originalGet = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
      vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementation((key: string) => (
        key === 'mode_catalog_initialized:h_a' ? ambiguousMarker : originalGet(key)
      ));

      catalog.reload();

      expect(catalog.getSnapshot().operatingMode).toBe('Cooler');
      expect(mockHomeyInstance.settings.set).toHaveBeenCalledTimes(writeCount);
      expect(logs.findEvent('home_mode_catalog_unavailable')).toMatchObject({ homeId: 'h_a' });
    },
  );

  it('waits rather than overwriting a pre-migration area selection on an ambiguous read', () => {
    const pinKey = `${OPERATING_MODE_SETTING}:h_a`;
    mockHomeyInstance.settings.set(pinKey, 'Cooler');
    const originalGet = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
    const getSpy = vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementation((key: string) => (
      key === pinKey ? undefined : originalGet(key)
    ));
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set');
    const catalog = createHomeModeCatalog(rig.ctx, 'h_a');

    catalog.reload();

    expect(catalog.isInitialized()).toBe(false);
    expect(setSpy).not.toHaveBeenCalled();
    getSpy.mockRestore();
    catalog.reload();
    expect(catalog.getSnapshot().operatingMode).toBe('Cooler');
  });

  // Mirror of the real `loadCapacitySettings` for the rename seam: reload
  // aliases + targets from the settings store into the ctx state the accessor
  // closures read — same order as the app's loader.
  const reloadCapacitySettingsFromStore = (): void => {
    const aliasesRaw = mockHomeyInstance.settings.get('mode_aliases') as
      Record<string, string> | null;
    const aliases = Object.fromEntries(
      Object.entries(aliasesRaw ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const targets = mockHomeyInstance.settings.get('mode_device_targets') as
      Record<string, Record<string, number>> | null;
    if (targets) rig.ctx.modeDeviceTargets = targets;
    const configuredModes = new Set(Object.keys(targets ?? rig.ctx.modeDeviceTargets));
    vi.mocked(rig.ctx.resolveModeName)
      .mockImplementation((name: string) => resolveModeName(name, aliases, configuredModes));
  };

  it('routes a suffixed operating_mode write to ONE bundle; main\'s mode dispatch never runs', async () => {
    writeActiveHomesConfig({ subHomes: [HOME_A, HOME_B] });
    rig.registry.reconcile();
    await drainPending();
    const rebuild = vi.spyOn(PlanService.prototype, 'rebuildPlanFromCache');

    const settingsHandler = initSettingsHandlerForApp(
      rig.ctx,
      {
        ...buildHomeRuntimeSettingsHooks(() => rig.registry),
        onPvForecastSourceObserved: () => {},
      },
    );
    try {
      mockHomeyInstance.settings.set(`${OPERATING_MODE_SETTING}:h_a`, 'Cooler');
      await drainPending();

      expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Cooler');
      // The sibling home keeps following the global mode.
      expect(diagnosticsFor(rig.registry, 'h_b').operatingMode).toBe('Home');
      // Exactly ONE bundle re-planned on the mode write.
      expect(rebuild.mock.calls.filter(
        ([trigger, options]) => trigger === 'settings' && options?.detail === 'mode_targets',
      ))
        .toHaveLength(1);

      // Mutation guards: the suffixed write must never fall through to the
      // main home's exact-key dispatch.
      expect(rig.ctx.operatingMode).toBe('Home');
      expect(rig.ctx.loadCapacitySettings).not.toHaveBeenCalled();
      expect(rig.ctx.notifyOperatingModeChanged).not.toHaveBeenCalled();

      // The transition is edge-logged, naming the home.
      const transitions = logs.findEvents('home_operating_mode_changed')
        .filter((event) => event.homeId === 'h_a');
      expect(transitions.at(-1)).toMatchObject({
        homeId: 'h_a',
        mode: 'Cooler',
        previousMode: 'Home',
        source: 'per_home',
      });
    } finally {
      settingsHandler.stop();
    }
  });

  it('rebuilds the owning bundle when a per-home operating mode pin is unset', async () => {
    writeActiveHomesConfig({ subHomes: [HOME_A] });
    mockHomeyInstance.settings.set(`${OPERATING_MODE_SETTING}:h_a`, 'Cooler');
    rig.registry.reconcile();
    await drainPending();
    expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Cooler');
    const rebuild = vi.spyOn(PlanService.prototype, 'rebuildPlanFromCache');

    const settingsHandler = initSettingsHandlerForApp(
      rig.ctx,
      {
        ...buildHomeRuntimeSettingsHooks(() => rig.registry),
        onPvForecastSourceObserved: () => {},
      },
    );
    try {
      mockHomeyInstance.settings.unset(`${OPERATING_MODE_SETTING}:h_a`);
      await drainPending();

      expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Home');
      expect(rebuild.mock.calls.filter(
        ([trigger, options]) => trigger === 'settings' && options?.detail === 'mode_targets',
      ))
        .toHaveLength(1);
      expect(rig.ctx.loadCapacitySettings).not.toHaveBeenCalled();
      expect(rig.ctx.notifyOperatingModeChanged).not.toHaveBeenCalled();
    } finally {
      settingsHandler.stop();
    }
  });

  it('keeps an area on a configured local mode when an invalid active mode is written', async () => {
    writeActiveHomesConfig({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();

    mockHomeyInstance.settings.set(`${OPERATING_MODE_SETTING}:h_a`, 'Ghost');
    rig.registry.onHomeScopedSettingChanged(OPERATING_MODE_SETTING, 'h_a');
    await drainPending();

    const effectiveMode = diagnosticsFor(rig.registry, 'h_a').operatingMode;
    expect(effectiveMode).toBe('Home');
    const targets = mockHomeyInstance.settings.get(`${MODE_DEVICE_TARGETS}:h_a`) as
      Record<string, Record<string, number>>;
    expect(targets[effectiveMode]).toEqual({ 'dev-1': 21 });
  });

  it('an additive mode rename never rebuilds a pinned area through the global fallback', async () => {
    writeActiveHomesConfig({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();

    // The mock ctx loader is inert; mirror the real `loadCapacitySettings` so
    // the handler's reload updates what the accessor closures read.
    vi.mocked(rig.ctx.loadCapacitySettings)
      .mockImplementation(reloadCapacitySettingsFromStore);

    const settingsHandler = initSettingsHandlerForApp(
      rig.ctx,
      {
        ...buildHomeRuntimeSettingsHooks(() => rig.registry),
        onPvForecastSourceObserved: () => {},
      },
    );
    try {
      mockHomeyInstance.settings.set(`${OPERATING_MODE_SETTING}:h_a`, 'Cooler');
      await drainPending();
      expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Cooler');

      const rebuild = vi.spyOn(PlanService.prototype, 'rebuildPlanFromCache');
      const countModeRebuilds = (): number => rebuild.mock.calls
        .filter(([trigger, options]) => trigger === 'settings' && options?.detail === 'mode_targets')
        .length;
      const transitionsBefore = logs.findEvents('home_operating_mode_changed')
        .filter((event) => event.homeId === 'h_a').length;

      // The rename flow mutates only this area's catalog and first adds the
      // new record alongside the old one.
      mockHomeyInstance.settings.set(`${MODE_DEVICE_TARGETS}:h_a`, {
        Home: { 'dev-1': 21 },
        Cooler: { 'dev-1': 16 },
        Chill: { 'dev-1': 16 },
        Away: { 'dev-1': 12 },
      });
      await drainPending();
      const additiveRebuilds = countModeRebuilds();
      expect(additiveRebuilds).toBeGreaterThan(0);
      expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Cooler');

      // The alias commit switches the pin to the new, already-present record.
      mockHomeyInstance.settings.set(`${MODE_ALIASES}:h_a`, { cooler: 'Chill' });
      await drainPending();
      expect(countModeRebuilds()).toBeGreaterThan(additiveRebuilds);

      // Only after aliases resolve every old pin does the UI remove the old
      // record. That final targets write must keep the area on Chill.
      mockHomeyInstance.settings.set(`${MODE_DEVICE_TARGETS}:h_a`, {
        Home: { 'dev-1': 21 },
        Chill: { 'dev-1': 16 },
        Away: { 'dev-1': 12 },
      });
      await drainPending();
      expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Chill');

      // The entire transition has exactly one effective-mode edge:
      // Cooler → Chill. In particular, no intermediate Home/global rebuild
      // can command a warmer target and add load.
      const transitions = logs.findEvents('home_operating_mode_changed')
        .filter((event) => event.homeId === 'h_a')
        .slice(transitionsBefore);
      expect(transitions).toHaveLength(1);
      expect(transitions.at(-1)).toMatchObject({ mode: 'Chill', source: 'per_home' });
      } finally {
      settingsHandler.stop();
    }
  });

  it('an area priority reorder rebuilds only that area with its new order', async () => {
    writeActiveHomesConfig({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();

    const settingsHandler = initSettingsHandlerForApp(
      rig.ctx,
      {
        ...buildHomeRuntimeSettingsHooks(() => rig.registry),
        onPvForecastSourceObserved: () => {},
      },
    );
    try {
      mockHomeyInstance.settings.set(`${OPERATING_MODE_SETTING}:h_a`, 'Cooler');
      await drainPending();
      expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Cooler');

      const rebuild = vi.spyOn(PlanService.prototype, 'rebuildPlanFromCache');
      const countBundleRebuilds = (): number => rebuild.mock.calls
        .filter(([trigger, options]) => trigger === 'settings' && options?.detail === 'mode_targets')
        .length;

      // Reorder the pinned mode's ranking. Priorities are ranked per mode and
      // a sub-home resolves them through its OWN effective mode, so this write
      // must re-run the pinned area's planner — an area whose meter is silent
      // gets no power-driven rebuild to pick the new order up later.
      mockHomeyInstance.settings.set(`${CAPACITY_PRIORITIES}:h_a`, {
        Home: { 'dev-1': 1 },
        Cooler: { 'dev-2': 1, 'dev-1': 2 },
      });
      await drainPending();

      // Without the fan-out the pinned area keeps its previous shedding order
      // until an unrelated rebuild.
      expect(countBundleRebuilds()).toBeGreaterThan(0);
      const persisted = readPersistedHomeModeCatalog(rig.ctx, 'h_a');
      expect(persisted.state).toBe('resolved');
      if (persisted.state === 'resolved') {
        expect(getConfiguredPriorityFromHomeModeCatalog(persisted.snapshot, 'dev-1')).toBe(2);
      }
    } finally {
      settingsHandler.stop();
    }
  });

  it('fails a malformed area active-mode value safe onto Home', async () => {
    writeActiveHomesConfig({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();

    mockHomeyInstance.settings.set(`${OPERATING_MODE_SETTING}:h_a`, 42);
    rig.registry.onHomeScopedSettingChanged(OPERATING_MODE_SETTING, 'h_a');
    await drainPending();

    const effectiveMode = diagnosticsFor(rig.registry, 'h_a').operatingMode;
    expect(effectiveMode).toBe('Home');
    // Corrupt persisted input never becomes a planner lookup key.
    const targets = mockHomeyInstance.settings.get(`${MODE_DEVICE_TARGETS}:h_a`) as
      Record<string, Record<string, number>>;
    expect(targets[effectiveMode]).toBeDefined();
  });

  it('contains a THROWN pinned-mode read: last-known mode held, catalog reports unavailable, rebuild completes', async () => {
    writeActiveHomesConfig({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();
    mockHomeyInstance.settings.set(`${OPERATING_MODE_SETTING}:h_a`, 'Cooler');
    rig.registry.onHomeScopedSettingChanged(OPERATING_MODE_SETTING, 'h_a');
    await drainPending();
    expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Cooler');
    const transitionsBefore = logs.findEvents('home_operating_mode_changed')
      .filter((event) => event.homeId === 'h_a').length;

    // A transient settings-backend failure for the pin key only.
    const passthroughGet = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
    const readSpy = vi.spyOn(mockHomeyInstance.settings, 'get')
      .mockImplementation((key: string) => {
        if (key === `${OPERATING_MODE_SETTING}:h_a`) {
          throw new Error('settings backend unavailable');
        }
        return passthroughGet(key);
      });

    // The mode-change rebuild fan-out must complete despite the failing read:
    // an escaping exception fails the rebuild with NO retry, and a silent-meter
    // area gets no power-driven rebuild to self-heal from that miss.
    rig.registry.onHomeScopedSettingChanged(OPERATING_MODE_SETTING, 'h_a');
    await drainPending();
    expect(logs.findEvents('home_mode_targets_rebuild_failed')).toHaveLength(0);

    // The persisted pin truth is unknown: hold the LAST-KNOWN effective mode
    // (never a flip to the global fallback), with its own surfaced fault.
    expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Cooler');
    expect(logs.findEvent('home_mode_catalog_unavailable')).toMatchObject({ homeId: 'h_a' });

    // Edge-triggered: repeated failing resolves surface ONE fault, and holding
    // the last-known mode is never logged as a mode transition.
    rig.registry.onHomeScopedSettingChanged(OPERATING_MODE_SETTING, 'h_a');
    await drainPending();
    expect(logs.findEvents('home_mode_catalog_unavailable')).toHaveLength(1);
    expect(logs.findEvents('home_operating_mode_changed')
      .filter((event) => event.homeId === 'h_a')).toHaveLength(transitionsBefore);

    // Recovery: the next successful read re-adopts the pin, no residue.
    readSpy.mockRestore();
    rig.registry.onHomeScopedSettingChanged(OPERATING_MODE_SETTING, 'h_a');
    await drainPending();
    expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Cooler');
  });

  it.each([
    ['a fulfilled undefined for the existing key', false],
    ['a transient store-wide empty key list', true],
  ])('holds an established pin across %s', async (_label, emptyKeys) => {
    writeActiveHomesConfig({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();
    const pinKey = `${OPERATING_MODE_SETTING}:h_a`;
    mockHomeyInstance.settings.set(pinKey, 'Cooler');
    rig.registry.onHomeScopedSettingChanged(OPERATING_MODE_SETTING, 'h_a');
    await drainPending();
    expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Cooler');
    const transitionsBefore = logs.findEvents('home_operating_mode_changed')
      .filter((event) => event.homeId === 'h_a').length;

    const originalGet = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
    const originalGetKeys = mockHomeyInstance.settings.getKeys.bind(mockHomeyInstance.settings);
    const getSpy = vi.spyOn(mockHomeyInstance.settings, 'get')
      .mockImplementation((key: string) => (key === pinKey ? undefined : originalGet(key)));
    const getKeysSpy = vi.spyOn(mockHomeyInstance.settings, 'getKeys')
      .mockImplementation(() => (emptyKeys ? [] : originalGetKeys()));

    // A fulfilled miss is not positive evidence that the user cleared the
    // pin. The one-shot fan-out must keep the established Cooler mode, never
    // rebuild against the warmer global Home targets.
    rig.registry.onHomeScopedSettingChanged(OPERATING_MODE_SETTING, 'h_a');
    await drainPending();
    expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Cooler');
    expect(logs.findEvents('home_operating_mode_changed')
      .filter((event) => event.homeId === 'h_a')).toHaveLength(transitionsBefore);
    expect(logs.findEvent('home_mode_catalog_unavailable')).toMatchObject({ homeId: 'h_a' });

    getSpy.mockRestore();
    getKeysSpy.mockRestore();
    rig.registry.onHomeScopedSettingChanged(OPERATING_MODE_SETTING, 'h_a');
    await drainPending();
    expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Cooler');
  });

  it('a global mode change leaves every initialized area catalog independent', async () => {
    writeActiveHomesConfig({ subHomes: [HOME_A, HOME_B] });
    rig.registry.reconcile();
    await drainPending();
    mockHomeyInstance.settings.set(`${OPERATING_MODE_SETTING}:h_a`, 'Cooler');
    rig.registry.onHomeScopedSettingChanged(OPERATING_MODE_SETTING, 'h_a');
    await drainPending();

    // The real app updates ctx.operatingMode in loadCapacitySettings before
    // the fan-out; the mock's loader is inert, so the rig mirrors that order.
    rig.ctx.operatingMode = 'Away';
    rig.registry.onModeSettingsChanged();
    await drainPending();

    expect(diagnosticsFor(rig.registry, 'h_b').operatingMode).toBe('Home');
    expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Cooler');
    const followerTransitions = logs.findEvents('home_operating_mode_changed')
      .filter((event) => event.homeId === 'h_b');
    expect(followerTransitions).toHaveLength(0);
  });

  it('treats a pinned-mode write for an unknown homeId as transient (no throw, no teardown)', async () => {
    writeActiveHomesConfig({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();

    expect(() => rig.registry.onHomeScopedSettingChanged(OPERATING_MODE_SETTING, 'h_ghost'))
      .not.toThrow();
    expect(rig.registry.getBundleHomeIds()).toEqual(['h_a']);
  });
});

// The device-scoped reader (`resolveOperatingModeForDevice`) feeds the only
// consumer that PERSISTS a mode-derived value: the overshoot default seed in
// `setup/appDeviceSupport.ts`. Unlike `HomeModeCatalog`, which a registered
// bundle reads and which can hold its last-known mode, this reader is
// stateless: a failed pin read has no last-known mode to hold — and a default
// seeded under the global fallback outlives the transient failure, because
// every later refresh keeps the entry that is already there.
// Only outward seams are mocked: the shared mock settings store backs the real
// membership service and the real seed pass.
describe('per-home operating mode (device-scoped overshoot seed)', () => {
  const ZONES = {
    z1: { id: 'z1', name: 'Home', parent: null },
    z2: { id: 'z2', name: 'Annex', parent: 'z1' },
  };
  // Temperature device with no `onoff`: the class the seed pass enforces a
  // `set_temperature` default for. In zone z2, so it belongs to HOME_A.
  const SUB_HOME_HEATER = {
    id: 'vt-1',
    name: 'Annex panel heater',
    deviceType: 'temperature',
    deviceClass: 'airtreatment',
    powerCapable: true,
    capabilities: ['target_temperature', 'measure_power'],
    targets: [{ id: 'target_temperature', value: 22, unit: '°C' }],
  } as unknown as TargetDeviceSnapshot;
  // Three distinguishable defaults (target − 3 °C, floored at 16 °C):
  //   pinned 'Cooler' → 17, global 'Home' → 21, device setpoint only → 19.
  const MODE_TARGETS = { Home: { 'vt-1': 24 }, Cooler: { 'vt-1': 20 } };

  let ctx: AppContext;
  let membership: HomeMembershipService;

  const buildMembership = (
    getZoneTree: () => typeof ZONES | null,
    onOwnershipReadyBeforePlanWork?: (service: HomeMembershipService) => void,
  ): HomeMembershipService => (
    new HomeMembershipService({
      homesStore: createRawHomesStore(homeyLike),
      assignmentsStore: createDeviceHomeAssignmentsStore(homeyLike),
      getZoneTree,
      getDevices: () => [{ deviceId: 'vt-1', zoneId: 'z2' }],
      getLogger: () => undefined,
      getMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: null }),
      getConfiguredPowerSource: () => ({ state: 'resolved', value: 'homey_energy' }),
      legacyMultiHomeEnabled: true,
      onOwnershipReadyBeforePlanWork,
    })
  );

  const readOvershootEntry = (): unknown => (
    (mockHomeyInstance.settings.get(OVERSHOOT_BEHAVIORS) as Record<string, unknown> | null)?.['vt-1']
  );

  const runSeedPass = (): void => {
    disableUnsupportedDevices({
      snapshot: [SUB_HOME_HEATER],
      settings: homeyLike.settings,
      resolveOperatingModeForDevice: (deviceId) => resolveOperatingModeForDevice(ctx, deviceId),
      debugStructured: vi.fn(),
    });
  };

  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    mockHomeyInstance.settings.set(MANAGED_DEVICES, { 'vt-1': true });
    mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { 'vt-1': true });
    mockHomeyInstance.settings.set('mode_device_targets', MODE_TARGETS);
    writeActiveHomesConfig({ subHomes: [HOME_A] });
    mockHomeyInstance.settings.set(`${OPERATING_MODE_SETTING}:h_a`, 'Cooler');

    membership = buildMembership(() => ZONES);
    membership.recompute();

    ctx = createAppContextMock({ homey: homeyLike, homeMembership: membership });
    ctx.modeDeviceTargets = MODE_TARGETS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('classifies a failed Main operating-mode read as unavailable', () => {
    const passthroughGet = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
    const readSpy = vi.spyOn(mockHomeyInstance.settings, 'get')
      .mockImplementation((key: string) => {
        if (key === OPERATING_MODE_SETTING) throw new Error('settings backend unavailable');
        return passthroughGet(key);
      });

    expect(resolveOperatingModeForDevice(ctx, 'main-device')).toEqual({ state: 'unavailable' });
    readSpy.mockRestore();
  });

  it('skips the overshoot seed while the pinned mode read throws, then seeds under the PIN once it recovers', () => {
    // Precondition: the device really is a sub-home member, so the seed would
    // otherwise resolve through the pin.
    expect(membership.getHomeIdForDevice('vt-1')).toBe('h_a');

    const passthroughGet = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
    const readSpy = vi.spyOn(mockHomeyInstance.settings, 'get')
      .mockImplementation((key: string) => {
        if (key === `${OPERATING_MODE_SETTING}:h_a`) {
          throw new Error('settings backend unavailable');
        }
        return passthroughGet(key);
      });

    runSeedPass();

    // Nothing persisted: not the global-mode default (21 °C), not a
    // setpoint-only default (19 °C). A missing entry is recoverable; a
    // wrong-mode one is not, because the next pass keeps whatever exists.
    expect(readOvershootEntry()).toBeUndefined();

    // Recovery: the very next pass seeds from the home's OWN pinned mode.
    readSpy.mockRestore();
    runSeedPass();
    expect(readOvershootEntry()).toEqual({ action: 'set_temperature', temperature: 17 });
  });

  it('skips the overshoot seed while the pinned mode targets are unavailable, then retries', () => {
    // The effective mode already resolved from the producer-owned snapshot,
    // but the second settings read that supplies its target transiently has no
    // value. Treating that as "no device target" would persist the 19 °C
    // setpoint fallback and keep it even after the configured 20 °C Cooler
    // target becomes readable again.
    const passthroughGet = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
    const readSpy = vi.spyOn(mockHomeyInstance.settings, 'get')
      .mockImplementation((key: string) => (
        key === 'mode_device_targets' ? undefined : passthroughGet(key)
      ));

    runSeedPass();
    expect(readOvershootEntry()).toBeUndefined();

    readSpy.mockRestore();
    runSeedPass();
    expect(readOvershootEntry()).toEqual({ action: 'set_temperature', temperature: 17 });
  });

  it('uses the current setpoint when a valid targets blob has no active-mode map', () => {
    mockHomeyInstance.settings.set('mode_device_targets', {
      Home: MODE_TARGETS.Home,
    });

    runSeedPass();

    expect(readOvershootEntry()).toEqual({ action: 'set_temperature', temperature: 19 });
  });

  it('skips the overshoot seed until zone-based device ownership is committed', () => {
    let zoneTree: typeof ZONES | null = null;
    membership = buildMembership(
      () => zoneTree,
      () => runSeedPass(),
    );
    ctx = createAppContextMock({ homey: homeyLike, homeMembership: membership });
    ctx.modeDeviceTargets = MODE_TARGETS;
    membership.recompute();

    // Before the detached zone-tree result lands, the membership lookup's Main
    // answer is deliberately provisional and cannot select the global mode.
    expect(membership.isOwnershipReady()).toBe(false);
    expect(membership.getHomeIdForDevice('vt-1')).toBe('main');
    runSeedPass();
    expect(readOvershootEntry()).toBeUndefined();

    zoneTree = ZONES;
    membership.recompute();
    expect(membership.isOwnershipReady()).toBe(true);
    expect(membership.getHomeIdForDevice('vt-1')).toBe('h_a');
    // The producer retries the previously deferred seed synchronously before
    // it notifies plan consumers about the committed ownership map.
    expect(readOvershootEntry()).toEqual({ action: 'set_temperature', temperature: 17 });
  });

  it('skips the overshoot seed between rename target and alias commits', () => {
    const renamedTargets = { Home: { 'vt-1': 24 }, Chill: { 'vt-1': 20 } };
    mockHomeyInstance.settings.set('mode_device_targets', renamedTargets);
    ctx.modeDeviceTargets = renamedTargets;

    // The targets write removed `Cooler`, but the alias write has not landed.
    // The bundle may follow a logged global fallback; a persisted default may
    // not, because it would survive after the rename completes.
    runSeedPass();
    expect(readOvershootEntry()).toBeUndefined();

    ctx.resolveModeName = (name: string) => resolveModeName(
      name,
      { cooler: 'Chill' },
      new Set(Object.keys(renamedTargets)),
    );
    runSeedPass();
    expect(readOvershootEntry()).toEqual({ action: 'set_temperature', temperature: 17 });
  });

  it('seeds from the home\'s pinned mode when the read succeeds (never the global mode)', () => {
    runSeedPass();
    expect(readOvershootEntry()).toEqual({ action: 'set_temperature', temperature: 17 });
  });
});
