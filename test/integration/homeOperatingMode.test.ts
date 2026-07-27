// Integration coverage for the per-home operating mode (multi-home):
// - the settings→bundle seam: an `operating_mode:<homeId>` write routes
//   through the REAL settings handler to ONE bundle's mode rebuild — never to
//   main's mode handler, main's snapshot loader, or the global Flow trigger;
// - the resolution chain (per-home value → global default) observable in the
//   bundle diagnostics, with transitions edge-logged NAMING the home;
// - the stuck-cold guard: a pinned mode with no `mode_device_targets` record
//   follows the global mode and surfaces a fault — the effective mode always
//   indexes a real record, never an empty-object default;
// - the global mode fan-out still reaching every home without a pinned mode;
// - the rename seam: the UI publishes the new record alongside the old one
//   before a `mode_aliases` write fans out to sub-home plans, then removes the
//   old record only after every pin resolves to the new one — no intermediate
//   global fallback may actuate a warmer target;
// - the malformed-pin boundary: a non-string `operating_mode:<homeId>` value
//   fails safe onto the global mode with its own surfaced fault — never read
//   as an intentional unpin;
// - the priorities seam: a `capacity_priorities` reorder fans out to sub-home
//   plans, so a pinned area adopts its new shedding order without waiting for
//   an unrelated rebuild;
// - the read-failure boundary: a THROWN `operating_mode:<homeId>` settings
//   read is contained at the adapter — the accessor holds a last-known pin or
//   follows the current global mode when no pin was known, with a distinct
//   surfaced fault, and the mode-change rebuild still completes;
// - fulfilled `undefined` for an existing pin and a store-wide empty key list
//   are suspect reads that preserve a known pin; only a healthy key list that
//   omits the pin proves a genuine unpin;
// - the per-home priority resolver ranking by the home's OWN effective mode;
// - the device-scoped reader feeding the overshoot default seed: a THROWN pin
//   read must SKIP the seed, never persist a default derived from the global
//   mode (that write outlives the transient failure).
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
import {
  createHomeOperatingModeAccessor,
  resolveOperatingModeForDevice,
} from '../../setup/homeRuntime/homeOperatingMode';
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
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
  POWER_SOURCE,
} from '../../lib/utils/settingsKeys';
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
    deviceManager: { getSnapshot: () => [] } as unknown as AppContext['deviceManager'],
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
      buildHomeRuntimeSettingsHooks(() => rig.registry),
    );
    try {
      mockHomeyInstance.settings.set(`${OPERATING_MODE_SETTING}:h_a`, 'Cooler');
      await drainPending();

      expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Cooler');
      // The sibling home keeps following the global mode.
      expect(diagnosticsFor(rig.registry, 'h_b').operatingMode).toBe('Home');
      // Exactly ONE bundle re-planned on the mode write.
      expect(rebuild.mock.calls.filter(([reason]) => reason === 'settings:mode_targets'))
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
      buildHomeRuntimeSettingsHooks(() => rig.registry),
    );
    try {
      mockHomeyInstance.settings.unset(`${OPERATING_MODE_SETTING}:h_a`);
      await drainPending();

      expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Home');
      expect(rebuild.mock.calls.filter(([reason]) => reason === 'settings:mode_targets'))
        .toHaveLength(1);
      expect(rig.ctx.loadCapacitySettings).not.toHaveBeenCalled();
      expect(rig.ctx.notifyOperatingModeChanged).not.toHaveBeenCalled();
    } finally {
      settingsHandler.stop();
    }
  });

  it('follows the global mode with a surfaced fault when the pinned mode has no targets record', async () => {
    writeActiveHomesConfig({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();

    mockHomeyInstance.settings.set(`${OPERATING_MODE_SETTING}:h_a`, 'Ghost');
    rig.registry.onHomeScopedSettingChanged(OPERATING_MODE_SETTING, 'h_a');
    await drainPending();

    const effectiveMode = diagnosticsFor(rig.registry, 'h_a').operatingMode;
    expect(effectiveMode).toBe('Home');
    // The stuck-cold guard: the effective mode always indexes a REAL record in
    // the global blob — never the pinned name whose record is missing.
    expect(rig.ctx.modeDeviceTargets[effectiveMode]).toEqual({ 'dev-1': 21 });
    expect(logs.findEvent('home_operating_mode_unconfigured')).toMatchObject({
      homeId: 'h_a',
      requestedMode: 'Ghost',
      fallbackMode: 'Home',
    });
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
      buildHomeRuntimeSettingsHooks(() => rig.registry),
    );
    try {
      mockHomeyInstance.settings.set(`${OPERATING_MODE_SETTING}:h_a`, 'Cooler');
      await drainPending();
      expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Cooler');

      const rebuild = vi.spyOn(PlanService.prototype, 'rebuildPlanFromCache');
      const countModeRebuilds = (): number => rebuild.mock.calls
        .filter(([reason]) => reason === 'settings:mode_targets').length;
      const transitionsBefore = logs.findEvents('home_operating_mode_changed')
        .filter((event) => event.homeId === 'h_a').length;

      // The rename flow first adds the new record ALONGSIDE the old one. The
      // old pin therefore stays valid while this write rebuilds the bundle.
      mockHomeyInstance.settings.set('mode_device_targets', {
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
      mockHomeyInstance.settings.set('mode_aliases', { cooler: 'Chill' });
      await drainPending();
      expect(countModeRebuilds()).toBeGreaterThan(additiveRebuilds);

      // Only after aliases resolve every old pin does the UI remove the old
      // record. That final targets write must keep the area on Chill.
      mockHomeyInstance.settings.set('mode_device_targets', {
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
      expect(logs.findEvents('home_operating_mode_unconfigured')).toHaveLength(0);
    } finally {
      settingsHandler.stop();
    }
  });

  it('a capacity_priorities reorder fans out to sub-home plans so a pinned area adopts the new order', async () => {
    writeActiveHomesConfig({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();

    // Mirror the slice of the real `loadCapacitySettings` this seam needs:
    // reload the priorities blob into the ctx state the accessor closures read.
    vi.mocked(rig.ctx.loadCapacitySettings).mockImplementation(() => {
      const priorities = mockHomeyInstance.settings.get('capacity_priorities') as
        Record<string, Record<string, number>> | null;
      if (priorities) rig.ctx.capacityPriorities = priorities;
    });

    const settingsHandler = initSettingsHandlerForApp(
      rig.ctx,
      buildHomeRuntimeSettingsHooks(() => rig.registry),
    );
    try {
      mockHomeyInstance.settings.set(`${OPERATING_MODE_SETTING}:h_a`, 'Cooler');
      await drainPending();
      expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Cooler');

      const rebuild = vi.spyOn(PlanService.prototype, 'rebuildPlanFromCache');
      const countBundleRebuilds = (): number => rebuild.mock.calls
        .filter(([reason]) => reason === 'settings:mode_targets').length;

      // Reorder the pinned mode's ranking. Priorities are ranked per mode and
      // a sub-home resolves them through its OWN effective mode, so this write
      // must re-run the pinned area's planner — an area whose meter is silent
      // gets no power-driven rebuild to pick the new order up later.
      mockHomeyInstance.settings.set('capacity_priorities', {
        Home: { 'dev-1': 1 },
        Cooler: { 'dev-1': 3 },
      });
      await drainPending();

      // Without the fan-out the pinned area keeps its previous shedding order
      // until an unrelated rebuild.
      expect(countBundleRebuilds()).toBeGreaterThan(0);
      // The rebuilt plan ranks by the reloaded blob under the home's own mode.
      const accessor = createHomeOperatingModeAccessor(rig.ctx, 'h_a');
      expect(accessor.getPriorityForDevice('dev-1')).toBe(3);
    } finally {
      settingsHandler.stop();
    }
  });

  it('fails a MALFORMED pin (non-string value) safe onto the global mode with its own surfaced fault', async () => {
    writeActiveHomesConfig({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();

    mockHomeyInstance.settings.set(`${OPERATING_MODE_SETTING}:h_a`, 42);
    rig.registry.onHomeScopedSettingChanged(OPERATING_MODE_SETTING, 'h_a');
    await drainPending();

    const effectiveMode = diagnosticsFor(rig.registry, 'h_a').operatingMode;
    expect(effectiveMode).toBe('Home');
    // Corrupt persisted input is never read as an intentional unpin: it gets
    // its own fault event, distinct from the unconfigured-pin one.
    expect(logs.findEvent('home_operating_mode_pin_malformed')).toMatchObject({
      homeId: 'h_a',
      valueType: 'number',
      fallbackMode: 'Home',
    });
    expect(logs.findEvents('home_operating_mode_unconfigured')).toHaveLength(0);
  });

  it('contains a THROWN pinned-mode read: last-known mode held, fault surfaced once, rebuild completes', async () => {
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
    rig.registry.onModeSettingsChanged();
    await drainPending();
    expect(logs.findEvents('home_mode_targets_rebuild_failed')).toHaveLength(0);

    // The persisted pin truth is unknown: hold the LAST-KNOWN effective mode
    // (never a flip to the global fallback), with its own surfaced fault.
    expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Cooler');
    expect(logs.findEvent('home_operating_mode_read_failed')).toMatchObject({
      homeId: 'h_a',
      fallbackMode: 'Cooler',
    });

    // Edge-triggered: repeated failing resolves surface ONE fault, and holding
    // the last-known mode is never logged as a mode transition.
    rig.registry.onModeSettingsChanged();
    await drainPending();
    expect(logs.findEvents('home_operating_mode_read_failed')).toHaveLength(1);
    expect(logs.findEvents('home_operating_mode_changed')
      .filter((event) => event.homeId === 'h_a')).toHaveLength(transitionsBefore);

    // Recovery: the next successful read re-adopts the pin, no residue.
    readSpy.mockRestore();
    rig.registry.onModeSettingsChanged();
    await drainPending();
    expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Cooler');
  });

  it.each([
    ['a fulfilled undefined for the existing key', false, 'missing_existing_key'],
    ['a transient store-wide empty key list', true, 'empty_key_list'],
  ])('holds an established pin across %s', async (_label, emptyKeys, reason) => {
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
    rig.registry.onModeSettingsChanged();
    await drainPending();
    expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Cooler');
    expect(logs.findEvents('home_operating_mode_changed')
      .filter((event) => event.homeId === 'h_a')).toHaveLength(transitionsBefore);
    expect(logs.findEvent('home_operating_mode_read_suspect')).toMatchObject({
      homeId: 'h_a',
      reason,
      fallbackMode: 'Cooler',
    });

    getSpy.mockRestore();
    getKeysSpy.mockRestore();
    rig.registry.onModeSettingsChanged();
    await drainPending();
    expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Cooler');
  });

  it('unpins only when a healthy key list confirms genuine absence', () => {
    const pinKey = `${OPERATING_MODE_SETTING}:h_a`;
    mockHomeyInstance.settings.set(pinKey, 'Cooler');
    const accessor = createHomeOperatingModeAccessor(rig.ctx, 'h_a');
    expect(accessor.getOperatingMode()).toBe('Cooler');

    mockHomeyInstance.settings.unset(pinKey);

    expect(mockHomeyInstance.settings.getKeys()).not.toContain(pinKey);
    expect(accessor.getOperatingMode()).toBe('Home');
  });

  it('falls back to the global mode when the FIRST pin read throws (nothing known to hold)', () => {
    const passthroughGet = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
    vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementation((key: string) => {
      if (key === `${OPERATING_MODE_SETTING}:h_a`) {
        throw new Error('settings backend unavailable');
      }
      return passthroughGet(key);
    });

    const accessor = createHomeOperatingModeAccessor(rig.ctx, 'h_a');
    expect(accessor.getOperatingMode()).toBe('Home');
    // Priorities resolve under the fallback mode — never an escaping throw.
    expect(accessor.getPriorityForDevice('dev-1')).toBe(1);
    expect(logs.findEvent('home_operating_mode_read_failed')).toMatchObject({
      homeId: 'h_a',
      fallbackMode: 'Home',
    });
  });

  it('keeps following a changed global mode when an unpinned read throws', () => {
    const accessor = createHomeOperatingModeAccessor(rig.ctx, 'h_a');
    expect(accessor.getOperatingMode()).toBe('Home');

    rig.ctx.operatingMode = 'Away';
    const passthroughGet = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
    vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementation((key: string) => {
      if (key === `${OPERATING_MODE_SETTING}:h_a`) {
        throw new Error('settings backend unavailable');
      }
      return passthroughGet(key);
    });

    // The last successful read proved this area was a global follower. A
    // transient failure must not freeze the old Home mode, especially for a
    // silent-meter area with no later power-driven rebuild.
    expect(accessor.getOperatingMode()).toBe('Away');
    expect(accessor.getPriorityForDevice('dev-1')).toBe(100);
    expect(logs.findEvent('home_operating_mode_read_failed')).toMatchObject({
      homeId: 'h_a',
      fallbackMode: 'Away',
    });
  });

  it('a global mode change reaches homes without a pinned mode; a pinned home keeps its own', async () => {
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

    expect(diagnosticsFor(rig.registry, 'h_b').operatingMode).toBe('Away');
    expect(diagnosticsFor(rig.registry, 'h_a').operatingMode).toBe('Cooler');
    const followerTransitions = logs.findEvents('home_operating_mode_changed')
      .filter((event) => event.homeId === 'h_b');
    expect(followerTransitions.at(-1)).toMatchObject({
      homeId: 'h_b',
      mode: 'Away',
      previousMode: 'Home',
      source: 'global',
    });
  });

  it('treats a pinned-mode write for an unknown homeId as transient (no throw, no teardown)', async () => {
    writeActiveHomesConfig({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();

    expect(() => rig.registry.onHomeScopedSettingChanged(OPERATING_MODE_SETTING, 'h_ghost'))
      .not.toThrow();
    expect(rig.registry.getBundleHomeIds()).toEqual(['h_a']);
  });

  it('ranks device priority by the home\'s OWN effective mode', () => {
    const accessorA = createHomeOperatingModeAccessor(rig.ctx, 'h_a');
    const accessorB = createHomeOperatingModeAccessor(rig.ctx, 'h_b');

    // Unpinned: both homes rank by the global mode.
    expect(accessorA.getPriorityForDevice('dev-1')).toBe(1);
    expect(accessorB.getPriorityForDevice('dev-1')).toBe(1);

    mockHomeyInstance.settings.set(`${OPERATING_MODE_SETTING}:h_a`, 'Cooler');
    expect(accessorA.getPriorityForDevice('dev-1')).toBe(7);
    expect(accessorB.getPriorityForDevice('dev-1')).toBe(1);

    // A device the pinned mode does not rank falls to the lowest tier — it
    // must not inherit the global mode's rank.
    expect(accessorA.getPriorityForDevice('dev-2')).toBe(100);
  });
});

// The device-scoped reader (`resolveOperatingModeForDevice`) feeds the only
// consumer that PERSISTS a mode-derived value: the overshoot default seed in
// `setup/appDeviceSupport.ts`. Unlike the bundle accessor it is stateless, so
// a failed pin read has no last-known mode to hold — and a default seeded
// under the global fallback outlives the transient failure, because every
// later refresh keeps the entry that is already there.
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
