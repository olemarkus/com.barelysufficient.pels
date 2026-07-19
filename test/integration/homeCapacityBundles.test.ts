// Integration coverage for the R7b per-home capacity runtime bundles
// (`setup/homeRuntime/homeRuntimeRegistry.ts` + `createHomeCapacityBundle.ts`):
// - registry lifecycle against `homes_config` (create / teardown / suspect-keeps);
// - per-meter sample routing (each bundle's guard sees ONLY its own meter; a
//   missing reading yields NO sample — never a fabricated zero);
// - suffix-hook dispatch (capacity scalars reload into the guard, main's
//   in-memory capacity snapshot untouched; unknown homeId is transient);
// - own-write echo suppression for `power_tracker_state:<homeId>` and
//   adoption of a genuinely external tracker write;
// - suffixed persistence round-trip: tracker + `device_last_controlled_ms`
//   hydration on (re)creation;
// - the boot-window execution gate (forced dry-run until membership has
//   resolved from a committed zone tree);
// - the fail-closed sub-home device path (`filterDevicesForHome`);
// - the provenance-free restore lanes the orphaned-shed adoption relies on
//   (binary + stepped candidates carry no shed-provenance fields).
// Only outward seams are mocked: the shared mock Homey settings store backs
// the real homes store, capacity store, and suffixed persistence; the bundles
// run their REAL plan engine/service/guard/pipeline.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Homey from 'homey';
import type { AppContext } from '../../lib/app/appContext';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { HomeRuntimeRegistry } from '../../setup/homeRuntime/homeRuntimeRegistry';
import { filterDevicesForHome } from '../../setup/homeMembership';
import { createHomesStore } from '../../setup/homeRegistryAdapter';
import {
  isBinaryRestoreCandidate,
  isOffSteppedRestoreCandidate,
  isSteppedRestoreCandidate,
} from '../../lib/plan/restore/devices';
import { PlanService } from '../../lib/plan/planService';
import { createPlanRebuildOutcome } from '../../lib/plan/planRebuildMetrics';
import { SnapshotWarmupGate } from '../../lib/plan/snapshotWarmupGate';
import { POWER_SAMPLE_STALE_SHED_TIMEOUT_MS } from '../../lib/plan/planPowerFreshness';
import type { PlanRebuildOutcome } from '../../lib/plan/planTypes';
import { buildPlanDevice, steppedPlanDevice } from '../utils/planTestUtils';
import {
  CAPACITY_LIMIT_KW,
  DEVICE_LAST_CONTROLLED_MS,
  MAIN_HOME_ID,
  POWER_SOURCE,
  POWER_TRACKER_STATE,
} from '../../lib/utils/settingsKeys';
import { VOLATILE_WRITE_THROTTLE_MS } from '../../lib/utils/timingConstants';
import { drainPending, drainUntil } from '../utils/asyncDrain';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import { mockHomeyInstance } from '../mocks/homey';

const homeyLike = mockHomeyInstance as unknown as Homey.App['homey'];

const HOME_A = { homeId: 'h_a', name: 'Annex', rootZoneId: 'z2', meterDeviceId: 'm-a' };
const HOME_B = { homeId: 'h_b', name: 'Cabin', rootZoneId: 'z3', meterDeviceId: 'm-b' };

type Rig = {
  ctx: AppContext;
  registry: HomeRuntimeRegistry;
  setMembershipReady: (ready: boolean) => void;
};

const buildRig = (): Rig => {
  const ctx = createAppContextMock({
    homey: homeyLike,
    // `getSnapshot` lets a real plan rebuild complete (the status writer reads
    // the raw snapshot via `deviceManager.getSnapshot()`); without it the rebuild
    // throws and resolves `{ failed: true }`, masking the ready-edge/status paths.
    deviceManager: { getSnapshot: () => [] } as unknown as AppContext['deviceManager'],
    latestTargetSnapshot: [],
  });
  let membershipReady = true;
  const registry = new HomeRuntimeRegistry({
    ctx,
    isMembershipReady: () => membershipReady,
  });
  return { ctx, registry, setMembershipReady: (ready) => { membershipReady = ready; } };
};

const diagnosticsFor = (registry: HomeRuntimeRegistry, homeId: string) => {
  const entry = registry.getDiagnostics().find((diag) => diag.homeId === homeId);
  if (!entry) throw new Error(`no bundle diagnostics for ${homeId}`);
  return entry;
};

describe('HomeRuntimeRegistry (per-home capacity bundles)', () => {
  let rig: Rig;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'],
    });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 0));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    // Sub-home meter fan-out only runs under the Homey Energy poll; the registry
    // now mirrors the poll source's power-source discard guard, so the harness
    // reflects the sole production routing condition.
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    rig = buildRig();
  });

  afterEach(async () => {
    rig.registry.teardownAll();
    await drainPending();
    rig.ctx.timers.clearAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reconciles bundles from the homes registry: create, update-in-place, teardown removed', async () => {
    createHomesStore(homeyLike).write({ subHomes: [HOME_A, HOME_B] });
    rig.registry.reconcile();
    await drainPending();
    expect(rig.registry.getBundleHomeIds().sort()).toEqual(['h_a', 'h_b']);
    expect(rig.registry.getMeterDeviceIds().sort()).toEqual(['m-a', 'm-b']);

    // Meter change reconciles in place (same bundle identity, new routing).
    createHomesStore(homeyLike).write({
      subHomes: [{ ...HOME_A, meterDeviceId: 'm-a2' }, HOME_B],
    });
    rig.registry.reconcile();
    expect(rig.registry.getBundleHomeIds().sort()).toEqual(['h_a', 'h_b']);
    expect(rig.registry.getMeterDeviceIds().sort()).toEqual(['m-a2', 'm-b']);

    // Removal tears the bundle down and its home-scoped timers with it.
    createHomesStore(homeyLike).write({ subHomes: [HOME_B] });
    rig.registry.reconcile();
    await drainPending();
    expect(rig.registry.getBundleHomeIds()).toEqual(['h_b']);
    expect(rig.ctx.timers.has('home:h_a:trackerPruneInterval')).toBe(false);
    expect(rig.ctx.timers.has('home:h_b:trackerPruneInterval')).toBe(true);
  });

  it('keeps running bundles on a SUSPECT homes-config read (never a destructive teardown)', async () => {
    createHomesStore(homeyLike).write({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();
    expect(rig.registry.getBundleHomeIds()).toEqual(['h_a']);

    // Junk blob with the written-before marker set → the store classifies
    // 'suspect'; the registry must keep the current bundles.
    mockHomeyInstance.settings.set('homes_config', 'garbage');
    rig.registry.reconcile();
    expect(rig.registry.getBundleHomeIds()).toEqual(['h_a']);
  });

  it('routes each meter reading to its own bundle; a missing reading yields NO sample', async () => {
    createHomesStore(homeyLike).write({ subHomes: [HOME_A, HOME_B] });
    rig.registry.reconcile();
    await drainPending();

    rig.registry.routeMeterReadings({ 'm-a': 3000, 'm-b': 1200 }, Date.now());
    await drainPending();
    expect(diagnosticsFor(rig.registry, 'h_a').lastMeterPowerKw).toBeCloseTo(3);
    expect(diagnosticsFor(rig.registry, 'h_b').lastMeterPowerKw).toBeCloseTo(1.2);

    // m-b produced no finite reading this poll: h_b keeps its last value —
    // no fabricated zero ever reaches its guard.
    rig.registry.routeMeterReadings({ 'm-a': 500 }, Date.now() + 10_000);
    await drainPending();
    expect(diagnosticsFor(rig.registry, 'h_a').lastMeterPowerKw).toBeCloseTo(0.5);
    expect(diagnosticsFor(rig.registry, 'h_b').lastMeterPowerKw).toBeCloseTo(1.2);
  });

  it('suffix hook reloads ONE bundle\'s capacity scalars; main\'s snapshot stays untouched', async () => {
    createHomesStore(homeyLike).write({ subHomes: [HOME_A, HOME_B] });
    rig.registry.reconcile();
    await drainPending();
    const mainCapacityBefore = { ...rig.ctx.capacitySettings };

    mockHomeyInstance.settings.set(`${CAPACITY_LIMIT_KW}:h_a`, 7);
    rig.registry.onHomeScopedSettingChanged(CAPACITY_LIMIT_KW, 'h_a');
    await drainPending();

    expect(diagnosticsFor(rig.registry, 'h_a').capacityScalars.limitKw).toBe(7);
    // The sibling bundle and the MAIN home's in-memory snapshot are untouched.
    expect(diagnosticsFor(rig.registry, 'h_b').capacityScalars.limitKw).toBe(10);
    expect(rig.ctx.capacitySettings).toEqual(mainCapacityBefore);
    expect(rig.ctx.loadCapacitySettings).not.toHaveBeenCalled();
  });

  it('treats an unknown homeId as transient: one reconcile, no teardown, no throw', async () => {
    createHomesStore(homeyLike).write({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();

    expect(() => rig.registry.onHomeScopedSettingChanged(CAPACITY_LIMIT_KW, 'h_ghost')).not.toThrow();
    expect(rig.registry.getBundleHomeIds()).toEqual(['h_a']);

    // A suffixed write racing ahead of the homes_config handler: the
    // dirty-mark reconcile picks the new home up from the registry.
    createHomesStore(homeyLike).write({ subHomes: [HOME_A, HOME_B] });
    mockHomeyInstance.settings.set(`${CAPACITY_LIMIT_KW}:h_b`, 4);
    rig.registry.onHomeScopedSettingChanged(CAPACITY_LIMIT_KW, 'h_b');
    await drainPending();
    expect(rig.registry.getBundleHomeIds().sort()).toEqual(['h_a', 'h_b']);
    expect(diagnosticsFor(rig.registry, 'h_b').capacityScalars.limitKw).toBe(4);
  });

  it('suppresses own-write tracker echoes but adopts a genuinely external tracker write', async () => {
    createHomesStore(homeyLike).write({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();
    const trackerKey = `${POWER_TRACKER_STATE}:h_a`;

    // Sample S1 → debounced persist lands (own write).
    rig.registry.routeMeterReadings({ 'm-a': 2000 }, Date.now());
    await drainPending();
    await vi.advanceTimersByTimeAsync(VOLATILE_WRITE_THROTTLE_MS + 1000);
    await drainPending();
    const persistedAfterS1 = mockHomeyInstance.settings.get(trackerKey) as PowerTrackerState;
    expect(persistedAfterS1?.lastTimestamp).toBeDefined();

    // Sample S2 accrues in memory (debounce pending) — then the un-deduped
    // suffix hook replays our OWN S1 write. Suppression must keep S2.
    const s2Ts = Date.now() + 5_000;
    rig.registry.routeMeterReadings({ 'm-a': 2500 }, s2Ts);
    await drainPending();
    rig.registry.onHomeScopedSettingChanged(POWER_TRACKER_STATE, 'h_a');
    await vi.advanceTimersByTimeAsync(VOLATILE_WRITE_THROTTLE_MS + 1000);
    await drainPending();
    const persistedAfterS2 = mockHomeyInstance.settings.get(trackerKey) as PowerTrackerState;
    expect(persistedAfterS2.lastTimestamp).toBe(s2Ts);

    // A genuinely external write (different payload) IS adopted.
    const externalState: PowerTrackerState = {
      lastTimestamp: s2Ts,
      dailyTotals: { '2020-01-01': 42 },
    };
    mockHomeyInstance.settings.set(trackerKey, externalState);
    rig.registry.onHomeScopedSettingChanged(POWER_TRACKER_STATE, 'h_a');
    // The adopted state is observable through the next persist round-trip.
    rig.registry.routeMeterReadings({ 'm-a': 1000 }, s2Ts + 10_000);
    await drainPending();
    await vi.advanceTimersByTimeAsync(VOLATILE_WRITE_THROTTLE_MS + 1000);
    await drainPending();
    const persistedAfterAdopt = mockHomeyInstance.settings.get(trackerKey) as PowerTrackerState;
    expect(persistedAfterAdopt.dailyTotals?.['2020-01-01']).toBe(42);
  });

  it('rehydrates suffixed tracker + last-controlled state on (re)creation; junk resolves empty', async () => {
    // Pre-seed both suffixed keys, then create the bundle — simulated restart.
    const seededTracker: PowerTrackerState = {
      lastTimestamp: Date.now() - 60_000,
      dailyTotals: { '2026-01-14': 7.5 },
    };
    mockHomeyInstance.settings.set(`${POWER_TRACKER_STATE}:h_a`, seededTracker);
    mockHomeyInstance.settings.set(`${DEVICE_LAST_CONTROLLED_MS}:h_a`, { 'dev-1': 123_456 });
    createHomesStore(homeyLike).write({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();

    expect(diagnosticsFor(rig.registry, 'h_a').lastDeviceControlledMs).toEqual({ 'dev-1': 123_456 });
    // Hydrated tracker survives the next persist round-trip.
    rig.registry.routeMeterReadings({ 'm-a': 800 }, Date.now());
    await drainPending();
    await vi.advanceTimersByTimeAsync(VOLATILE_WRITE_THROTTLE_MS + 1000);
    await drainPending();
    const persisted = mockHomeyInstance.settings.get(`${POWER_TRACKER_STATE}:h_a`) as PowerTrackerState;
    expect(persisted.dailyTotals?.['2026-01-14']).toBe(7.5);

    // Junk in either key never crashes creation and never fabricates state.
    mockHomeyInstance.settings.set(`${POWER_TRACKER_STATE}:h_b`, 'junk');
    mockHomeyInstance.settings.set(`${DEVICE_LAST_CONTROLLED_MS}:h_b`, ['not', 'a', 'map']);
    createHomesStore(homeyLike).write({ subHomes: [HOME_A, HOME_B] });
    rig.registry.reconcile();
    await drainPending();
    expect(diagnosticsFor(rig.registry, 'h_b').lastDeviceControlledMs).toEqual({});
  });

  it('gates execution (dry-run) until membership has resolved from a committed zone tree', async () => {
    mockHomeyInstance.settings.set('capacity_dry_run:h_a', false);
    rig.setMembershipReady(false);
    createHomesStore(homeyLike).write({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();

    // Persisted flag says actuate — the boot-window guard still forces dry-run.
    expect(diagnosticsFor(rig.registry, 'h_a').capacityScalars.dryRun).toBe(false);
    expect(diagnosticsFor(rig.registry, 'h_a').dryRunEffective).toBe(true);

    rig.setMembershipReady(true);
    expect(diagnosticsFor(rig.registry, 'h_a').dryRunEffective).toBe(false);
  });

  it('a sub-home plan rebuild drives NONE of the shared UI/side-effect singletons', async () => {
    // The settings UI reads a SINGLE `plan_updated` stream and ONE diagnostics
    // recorder (the main home's). A sub-home capacity bundle must not clobber
    // either: its scope binds `emitsUiRealtime:false` and `deviceDiagnostics:undefined`.
    const observePlanSample = vi.fn();
    rig.ctx.deviceDiagnosticsService = {
      observePlanSample,
      recordControlEvent: vi.fn(),
      recordActivationTransition: vi.fn(),
      getUiPayload: vi.fn(),
      getOverviewStarvation: vi.fn(() => null),
    } as unknown as AppContext['deviceDiagnosticsService'];
    createHomesStore(homeyLike).write({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();

    mockHomeyInstance.api._realtimeEvents = [];
    observePlanSample.mockClear();
    rig.registry.routeMeterReadings({ 'm-a': 3000 }, Date.now());
    await drainPending();
    await vi.advanceTimersByTimeAsync(1000);
    await drainPending();

    // No partitioned sub-home plan clobbers the shared realtime channel...
    expect(mockHomeyInstance.api._realtimeEvents.filter((event) => event.event === 'plan_updated')).toEqual([]);
    // ...and the sub-home plan records nothing into the shared diagnostics recorder.
    expect(observePlanSample).not.toHaveBeenCalled();
  });

  it('teardownAll leaves suffixed persisted state in place and flushes a pending persist', async () => {
    createHomesStore(homeyLike).write({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();
    const sampleTs = Date.now();
    rig.registry.routeMeterReadings({ 'm-a': 2000 }, sampleTs);
    await drainPending();

    // Teardown BEFORE the debounce window elapses: the pending persist flushes.
    rig.registry.teardownAll();
    await drainPending();
    expect(rig.registry.getBundleHomeIds()).toEqual([]);
    const persisted = mockHomeyInstance.settings.get(`${POWER_TRACKER_STATE}:h_a`) as PowerTrackerState;
    expect(persisted.lastTimestamp).toBe(sampleTs);
    expect(rig.ctx.timers.has('home:h_a:powerTrackerSave')).toBe(false);
    expect(rig.ctx.timers.has('home:h_a:trackerPruneInterval')).toBe(false);
  });

  // ---- fix-round-2 failure-path coverage (P0#1, P0#2, P1#4, P1#5) ----

  // Spy `rebuildPlanFromCache` so only the ready-edge rebuild is controllable;
  // every OTHER reason (initial build, sample-driven, capacity reload) runs the
  // real method. Returns the deferred resolver for the ready-edge rebuild.
  const interceptReadyEdgeRebuild = (
    handler: (resolve: (outcome: PlanRebuildOutcome) => void) => void,
  ): void => {
    const realRebuild = PlanService.prototype.rebuildPlanFromCache;
    vi.spyOn(PlanService.prototype, 'rebuildPlanFromCache')
      .mockImplementation(function reroute(this: PlanService, reason?: string) {
        if (reason !== 'home_membership_ready') return realRebuild.call(this, reason);
        return new Promise<PlanRebuildOutcome>((resolve) => handler(resolve));
      });
  };

  const armBundleGatedThenReady = async (): Promise<void> => {
    rig.setMembershipReady(false);
    createHomesStore(homeyLike).write({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();
    rig.setMembershipReady(true);
  };

  it('P0#1 ready-edge: a FAILED rebuild does not reconcile and re-arms so a later attempt applies', async () => {
    await armBundleGatedThenReady();
    const reconcileSpy = vi.spyOn(PlanService.prototype, 'reconcileLatestPlanState');
    // Control ONLY the ready-edge rebuild outcome; every other reason runs real.
    let failReady = true;
    const realRebuild = PlanService.prototype.rebuildPlanFromCache;
    vi.spyOn(PlanService.prototype, 'rebuildPlanFromCache')
      .mockImplementation(function reroute(this: PlanService, reason?: string) {
        if (reason === 'home_membership_ready') {
          return Promise.resolve({ ...createPlanRebuildOutcome(false), failed: failReady });
        }
        return realRebuild.call(this, reason);
      });

    rig.registry.onMembershipReady();
    await drainPending();
    // Failed fresh rebuild → the stale pre-gate plan is NOT reconciled (would restore over cap).
    expect(reconcileSpy).not.toHaveBeenCalled();

    // Latch re-armed: a later SUCCESSFUL attempt now reconciles.
    failReady = false;
    rig.registry.onMembershipReady();
    await drainPending();
    expect(reconcileSpy).toHaveBeenCalled();
  });

  it('P0#2 teardown during an in-flight ready-edge rebuild: the resolving rebuild does NOT reconcile', async () => {
    await armBundleGatedThenReady();
    const reconcileSpy = vi.spyOn(PlanService.prototype, 'reconcileLatestPlanState');
    let releaseRebuild: (outcome: PlanRebuildOutcome) => void = () => undefined;
    interceptReadyEdgeRebuild((resolve) => { releaseRebuild = resolve; });

    rig.registry.onMembershipReady();
    await drainPending();
    // Tear the bundle down WHILE its ready-edge rebuild is in flight.
    createHomesStore(homeyLike).write({ subHomes: [] });
    rig.registry.reconcile();
    await drainPending();
    // The in-flight rebuild resolves (healthy) AFTER teardown — must be fenced.
    releaseRebuild({ ...createPlanRebuildOutcome(false), failed: false });
    await drainPending();
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it('P0#2 teardown during an in-flight rebuild: no suffixed-key persist; a same-homeId recreate is unaffected', async () => {
    // A real warmup gate holds the initial rebuild in flight until released.
    const heldGate = new SnapshotWarmupGate({ timeoutMs: 10 * 60 * 1000 });
    rig.ctx.snapshotWarmupGate = heldGate;
    createHomesStore(homeyLike).write({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();
    // Held by the gate → no status written yet.
    expect(mockHomeyInstance.settings.get('pels_status:h_a')).toBeUndefined();

    // Tear down while the rebuild is held, THEN let it resolve post-teardown.
    createHomesStore(homeyLike).write({ subHomes: [] });
    rig.registry.reconcile();
    await drainPending();
    heldGate.release('snapshot_ready');
    await drainPending();
    // The resolving rebuild persisted NO suffixed state (writers fenced on teardown).
    expect(mockHomeyInstance.settings.get('pels_status:h_a')).toBeUndefined();

    // A same-homeId recreate is a FRESH bundle with its own (open) fence: it persists.
    rig.ctx.snapshotWarmupGate = new SnapshotWarmupGate({ timeoutMs: 0 });
    createHomesStore(homeyLike).write({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();
    expect(mockHomeyInstance.settings.get('pels_status:h_a')).toBeTruthy();
  });

  it('P1#5 ready-edge: a newer sample landing mid-rebuild aborts the reconcile (no stale restore)', async () => {
    await armBundleGatedThenReady();
    const reconcileSpy = vi.spyOn(PlanService.prototype, 'reconcileLatestPlanState');
    let releaseRebuild: (outcome: PlanRebuildOutcome) => void = () => undefined;
    interceptReadyEdgeRebuild((resolve) => { releaseRebuild = resolve; });

    rig.registry.onMembershipReady();
    await drainPending();
    // A NEWER meter sample lands while the (under-cap) ready-edge rebuild is in flight.
    rig.registry.routeMeterReadings({ 'm-a': 5000 }, Date.now());
    await drainPending();
    // The stale under-cap rebuild resolves AFTER the newer sample → reconcile aborted.
    releaseRebuild({ ...createPlanRebuildOutcome(false), failed: false });
    await drainPending();
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it('P1#4 freshness heartbeat: bounded — one rebuild per stale period, no per-tick storm', async () => {
    // The heartbeat latches a stale period as escalated only when it can ACTUATE
    // (out of dry-run); a dry-run tick deliberately does NOT latch (see R3#1b), so
    // the bounded "one rebuild per stale period" guarantee is asserted here for the
    // actuating case — both homes configured to actuate.
    mockHomeyInstance.settings.set('capacity_dry_run:h_a', false);
    mockHomeyInstance.settings.set('capacity_dry_run:h_b', false);
    createHomesStore(homeyLike).write({ subHomes: [HOME_A, HOME_B] });
    rig.registry.reconcile();
    await drainPending();
    // Prime both meters so each has a live `lastTimestamp` (proving it was sampling).
    rig.registry.routeMeterReadings({ 'm-a': 1000, 'm-b': 1000 }, Date.now());
    await drainPending();

    const rebuildSpy = vi.spyOn(PlanService.prototype, 'rebuildPlanFromCache');
    const heartbeatCount = (): number => rebuildSpy.mock.calls.filter(([reason]) => reason === 'freshness_heartbeat').length;

    // Advance well past the stale-shed timeout, ticking MANY heartbeat intervals.
    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS + 60_000);
    await drainPending();
    const afterEscalation = heartbeatCount();
    // Each stale bundle escalates to fail-closed with ONE rebuild — never one per tick.
    expect(afterEscalation).toBeGreaterThanOrEqual(1);
    expect(afterEscalation).toBeLessThanOrEqual(2);

    // Keep ticking: the terminal fail-closed state does not keep re-rebuilding.
    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS);
    await drainPending();
    expect(heartbeatCount()).toBe(afterEscalation);
  });

  // ---- fix-round-3 failure-path coverage (heartbeat latch: FAILED + dry-run;
  //      post-teardown global-shortfall fence) ----

  it('R3#1a freshness heartbeat: a FAILED rebuild is NOT latched — the next tick retries', async () => {
    mockHomeyInstance.settings.set('capacity_dry_run:h_a', false);
    createHomesStore(homeyLike).write({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();
    // Live `lastTimestamp` so the bundle can go stale (it was sampling).
    rig.registry.routeMeterReadings({ 'm-a': 1000 }, Date.now());
    await drainPending();

    // Every heartbeat rebuild RESOLVES `{ failed: true }` (the contained build-error
    // path — it never throws). A failed fail-closed rebuild must not be recorded as
    // escalated, or the shed never re-attempts during the meter dropout.
    let heartbeats = 0;
    const realRebuild = PlanService.prototype.rebuildPlanFromCache;
    vi.spyOn(PlanService.prototype, 'rebuildPlanFromCache')
      .mockImplementation(function reroute(this: PlanService, reason?: string) {
        if (reason === 'freshness_heartbeat') {
          heartbeats += 1;
          return Promise.resolve({ ...createPlanRebuildOutcome(false), failed: true });
        }
        return realRebuild.call(this, reason);
      });

    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS + 30_000);
    await drainPending();
    // Not latched: the heartbeat kept retrying across ticks (a latched escalation
    // would have fired exactly once).
    expect(heartbeats).toBeGreaterThanOrEqual(2);
  });

  it('R3#1b freshness heartbeat: a DRY-RUN rebuild is NOT latched — escalation applies once the gate opens', async () => {
    // Persisted actuate flag ON, but membership NOT resolved: the boot-window gate
    // is the sole dry-run source. A dry-run heartbeat did not actuate, so it must
    // not burn the one-shot the ready-edge escalation later relies on.
    mockHomeyInstance.settings.set('capacity_dry_run:h_a', false);
    rig.setMembershipReady(false);
    createHomesStore(homeyLike).write({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();
    rig.registry.routeMeterReadings({ 'm-a': 1000 }, Date.now());
    await drainPending();

    const rebuildSpy = vi.spyOn(PlanService.prototype, 'rebuildPlanFromCache');
    const heartbeatCount = (): number => (
      rebuildSpy.mock.calls.filter(([reason]) => reason === 'freshness_heartbeat').length
    );

    // While dry-run (boot window) the heartbeat rebuild does NOT latch: it retries.
    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS + 30_000);
    await drainPending();
    const whileDryRun = heartbeatCount();
    expect(whileDryRun).toBeGreaterThanOrEqual(2);

    // Gate opens: the heartbeat can now actuate → it escalates once more and latches.
    rig.setMembershipReady(true);
    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS + 30_000);
    await drainPending();
    const afterReady = heartbeatCount();
    expect(afterReady).toBeGreaterThan(whileDryRun);

    // Latched now (out of dry-run): no further heartbeat rebuilds for this stale period.
    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS + 30_000);
    await drainPending();
    expect(heartbeatCount()).toBe(afterReady);
  });

  it('R3#4 post-teardown: a rebuild resolving after teardown does NOT fire the global capacity_shortfall Flow', async () => {
    // Hold the initial rebuild in flight (real warmup gate). An OVER-cap sample is
    // ingested (so the guard is primed to enter shortfall), then the bundle is torn
    // down, then the held rebuild is released — resolving POST-teardown. Its guard
    // shortfall callback must be fenced so it cannot raise the app's SINGLE global
    // `capacity_shortfall` Flow for a home no longer managed.
    mockHomeyInstance.flow._triggerCardTriggers = {};
    const heldGate = new SnapshotWarmupGate({ timeoutMs: 10 * 60 * 1000 });
    rig.ctx.snapshotWarmupGate = heldGate;
    mockHomeyInstance.settings.set('capacity_dry_run:h_a', false);
    createHomesStore(homeyLike).write({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();

    // Over-cap reading (50 kW vs the 10 kW default limit) primes the guard.
    rig.registry.routeMeterReadings({ 'm-a': 50_000 }, Date.now());
    await drainPending();

    // Tear the bundle down, THEN release the held rebuild (resolves post-teardown).
    createHomesStore(homeyLike).write({ subHomes: [] });
    rig.registry.reconcile();
    await drainPending();
    heldGate.release('snapshot_ready');
    await drainPending();

    // The global card was never fired — the fenced guard callback short-circuited.
    expect(mockHomeyInstance.flow._triggerCardTriggers.capacity_shortfall).toBeUndefined();
  });

  it('R3#5 ready-edge: a sample landing AFTER the pre-enqueue check but BEFORE the queued reconcile aborts, re-arms and re-applies (not permanently latched)', async () => {
    // The pre-enqueue revision check (P1#5) closes the race only up to the enqueue
    // boundary. This is the residual TOCTOU it cannot see: the sample lands after
    // that check has already passed but before the queued reconcile body reads the
    // revision. The body aborts on the point-of-use predicate — and a bare `false`
    // return there is indistinguishable from an ordinary no-op. The ready-edge must
    // observe the DISTINCT abort signal, re-arm its latch, and reschedule; otherwise
    // the latch is permanently burned and the pre-gate stable shed never applies.
    mockHomeyInstance.settings.set('capacity_dry_run:h_a', false);
    await armBundleGatedThenReady();

    // Reproduce the post-enqueue window from INSIDE the queued reconcile call: by
    // the time `reconcileLatestPlanState` runs, the ready-edge's pre-enqueue check
    // has already passed (revision stable), so bumping the revision here — exactly
    // once — models a sample landing after that check but before the body reads it.
    // `shouldAbort()` captured at spy entry equals the value the real body will see.
    const realReconcile = PlanService.prototype.reconcileLatestPlanState;
    const abortDecisions: boolean[] = [];
    let injectedOnce = false;
    vi.spyOn(PlanService.prototype, 'reconcileLatestPlanState')
      .mockImplementation(function wrapped(
        this: PlanService,
        shouldAbort?: () => boolean,
        onAbort?: () => void,
      ): Promise<boolean> {
        if (!injectedOnce) {
          injectedOnce = true;
          rig.registry.routeMeterReadings({ 'm-a': 5000 }, Date.now());
        }
        abortDecisions.push(shouldAbort?.() ?? false);
        return realReconcile.call(this, shouldAbort, onAbort);
      });

    rig.registry.onMembershipReady();
    // With the bug (latch burned on abort) the reconcile is invoked exactly ONCE
    // and never retries, so this drain would throw — the decisive regression guard.
    await drainUntil(() => abortDecisions.length >= 2);
    await drainPending();

    // First attempt aborted INSIDE the queue (predicate tripped at point of use)...
    expect(abortDecisions[0]).toBe(true);
    // ...then the latch re-armed + rescheduled, so a later attempt ran and PROCEEDED
    // past the predicate (applied) rather than staying permanently latched.
    expect(abortDecisions.at(-1)).toBe(false);
  });

  it('P2#6 poll-discard parity: routeMeterReadings drops readings when the source is not homey_energy', async () => {
    createHomesStore(homeyLike).write({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();

    // Source flipped to flow mid-poll (the poll source would discard main's sample too).
    mockHomeyInstance.settings.set(POWER_SOURCE, 'flow');
    rig.registry.routeMeterReadings({ 'm-a': 3000 }, Date.now());
    await drainPending();
    expect(diagnosticsFor(rig.registry, 'h_a').lastMeterPowerKw).not.toBeCloseTo(3);

    // Back on homey_energy, the reading routes normally.
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    rig.registry.routeMeterReadings({ 'm-a': 3000 }, Date.now());
    await drainPending();
    expect(diagnosticsFor(rig.registry, 'h_a').lastMeterPowerKw).toBeCloseTo(3);
  });

  // ---- fix-round-5 failure-path coverage (P2#3 meter swap; P2#4 flow-mode heartbeat) ----

  it('P2#3 meter change resets the bundle sample/freshness: no action on the OLD meter, waits for the NEW meter', async () => {
    createHomesStore(homeyLike).write({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();

    // Prime the OLD meter well over the 10 kW default limit.
    rig.registry.routeMeterReadings({ 'm-a': 15_000 }, Date.now());
    await drainPending();
    expect(diagnosticsFor(rig.registry, 'h_a').lastMeterPowerKw).toBeCloseTo(15);

    // The meter device is changed IN PLACE (same homeId, new meterDeviceId).
    createHomesStore(homeyLike).write({ subHomes: [{ ...HOME_A, meterDeviceId: 'm-a2' }] });
    rig.registry.reconcile();
    // Guard last-total cleared: the bundle no longer holds the old meter's 15 kW,
    // so a rebuild before the new meter reports cannot shed/restore on stale load.
    expect(diagnosticsFor(rig.registry, 'h_a').lastMeterPowerKw).toBeNull();

    // Freshness reset to never-sampled: a heartbeat tick past the stale-shed
    // timeout does NOT escalate to a fail-closed rebuild on the dead old meter.
    const rebuildSpy = vi.spyOn(PlanService.prototype, 'rebuildPlanFromCache');
    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS + 60_000);
    await drainPending();
    expect(rebuildSpy.mock.calls.filter(([reason]) => reason === 'freshness_heartbeat')).toEqual([]);

    // The NEW meter's first reading is what the bundle acts on.
    rig.registry.routeMeterReadings({ 'm-a2': 3000 }, Date.now());
    await drainPending();
    expect(diagnosticsFor(rig.registry, 'h_a').lastMeterPowerKw).toBeCloseTo(3);
  });

  it('P2#4 flow-mode: an aged prior sample does NOT escalate to a fail-closed shed (heartbeat gated on homey_energy)', async () => {
    createHomesStore(homeyLike).write({ subHomes: [HOME_A] });
    rig.registry.reconcile();
    await drainPending();

    // A prior LIVE sample under homey_energy (proves the bundle was sampling).
    rig.registry.routeMeterReadings({ 'm-a': 1000 }, Date.now());
    await drainPending();

    // The user switches the whole app to flow mode: the sub-meter fan-out stops,
    // so no fresh sub-home sample will ever arrive to clear the aging stamp.
    mockHomeyInstance.settings.set(POWER_SOURCE, 'flow');
    const rebuildSpy = vi.spyOn(PlanService.prototype, 'rebuildPlanFromCache');

    // Advance well past the stale-shed timeout, ticking many heartbeat intervals.
    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS + 60_000);
    await drainPending();

    // Gated on homey_energy: the heartbeat suspends escalation, so no fail-closed
    // rebuild fires on the now-orphaned stale sample (pre-fix it would shed).
    expect(rebuildSpy.mock.calls.filter(([reason]) => reason === 'freshness_heartbeat')).toEqual([]);
  });
});

describe('fail-closed sub-home device path (filterDevicesForHome)', () => {
  const devices = [{ id: 'device-main' }, { id: 'device-sub' }];

  it('yields EMPTY for a sub-home scope when membership is unwired', () => {
    expect(filterDevicesForHome(undefined, devices, 'h_a')).toEqual([]);
  });

  it('yields EMPTY for a sub-home scope when hasSubHomes() is false', () => {
    const membership = {
      hasSubHomes: () => false,
      getHomeIdForDevice: () => MAIN_HOME_ID,
    };
    expect(filterDevicesForHome(membership, devices, 'h_a')).toEqual([]);
    // The main path's identity guard is byte-identical: SAME array reference.
    expect(filterDevicesForHome(membership, devices, MAIN_HOME_ID)).toBe(devices);
    expect(filterDevicesForHome(undefined, devices, MAIN_HOME_ID)).toBe(devices);
  });
});

// Orphaned-shed adoption (carried TODO): the generic restore lanes must accept
// an observed-off device on observed state ALONE — no shed-provenance fields —
// so a device shed by MAIN before relocating into a sub-home is an ordinary
// restore candidate for its NEW bundle's planner. Verified per modality; the
// full binary adoption path (main sheds → sub-home bundle resumes) runs
// end-to-end in `test/e2e/homeCapacityBundlesSdkE2E.test.ts`.
describe('provenance-free restore lanes (orphaned-shed adoption)', () => {
  it('binary: an observed-off, eligible device is a restore candidate with zero provenance fields', () => {
    const device = buildPlanDevice({ id: 'relocated-binary', currentOn: false, controllable: true });
    expect(isBinaryRestoreCandidate(device)).toBe(true);
  });

  it('stepped: a device parked at the off step is a restore candidate with zero provenance fields', () => {
    const device = steppedPlanDevice({ id: 'relocated-stepped', selectedStepId: 'off' });
    expect(isSteppedRestoreCandidate(device)).toBe(true);
    expect(isOffSteppedRestoreCandidate(device)).toBe(true);
  });

  it('stepped: a device capped below its highest step is a step-up candidate', () => {
    const device = steppedPlanDevice({ id: 'capped-stepped', selectedStepId: 'low' });
    expect(isSteppedRestoreCandidate(device)).toBe(true);
  });
});
