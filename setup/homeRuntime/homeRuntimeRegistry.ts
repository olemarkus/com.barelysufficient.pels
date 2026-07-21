/**
 * Registry of per-home capacity bundles (multi-home R7b): one
 * `HomeCapacityBundle` per configured sub-home, reconciled against the
 * persisted homes registry (`homes_config`) at boot and on every
 * homes-config change. With ZERO sub-homes configured the registry is empty
 * and no bundle code runs — the main home's path is untouched.
 *
 * Reconcile semantics follow the store's discriminated read
 * (`HomeStoreReadResult`): `'present'` reconciles to the normalized list,
 * `'unwritten'` to empty, and `'suspect'` KEEPS the current bundles — the
 * persisted truth is unknown, and tearing down running control loops on one
 * flaky read would be exactly the destructive reset the persisted-settings
 * rules forbid. A changed `meterDeviceId`/root zone updates the existing
 * bundle in place (bundle identity is the homeId).
 *
 * Suffix-hook consumer (`onHomeScopedSettingChanged` contract in
 * `lib/utils/settingsHandlers.ts`): calls are idempotent dirty-marks — an
 * unknown homeId triggers ONE reconcile against the registry and is otherwise
 * ignored as transient (never a teardown, never an error); own-write
 * `power_tracker_state:<homeId>` echoes are suppressed inside the bundle.
 *
 * Sample routing: `routeMeterReadings` receives the per-meter map one
 * `manager/energy/live` poll resolved (transport seam
 * `setOnAdditionalMeterReadings`) and feeds each home's OWN meter reading to
 * that home's pipeline. A home with no meter, or whose meter produced no
 * finite reading this poll, gets NO sample — freshness machinery handles the
 * gap; a zero is never fabricated.
 */
import type { AppContext } from '../../lib/app/appContext';
import type { HomesStore, SubHomeConfig } from '../../lib/home/homeConfig';
import type { HomeId } from '../../lib/utils/settingsKeys';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  MAIN_HOME_ID,
  POWER_SOURCE,
  POWER_TRACKER_STATE,
} from '../../lib/utils/settingsKeys';
import { normalizePowerSource } from '../../lib/power/powerSource';
import { createHomesStore } from '../homeRegistryAdapter';
import { isMultiHomeEnabled } from '../multiHomeFlag';
import {
  createHomeCapacityBundle,
  type HomeCapacityBundle,
  type HomeCapacityBundleDiagnostics,
  type RealtimeReconcileHooks,
} from './createHomeCapacityBundle';

const CAPACITY_SCALAR_BASE_KEYS: ReadonlySet<string> = new Set([
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_DRY_RUN,
]);

export type HomeRuntimeRegistryDeps = {
  ctx: AppContext;
  /** Membership-readiness signal handed to every bundle (execution gate). */
  isMembershipReady: () => boolean;
  /** Store override for tests; defaults to the real settings-backed store. */
  homesStore?: HomesStore;
};

export class HomeRuntimeRegistry {
  private readonly bundles = new Map<HomeId, HomeCapacityBundle>();
  private readonly homesStore: HomesStore;
  // Edge-latch for the flow-source misconfiguration warn (see the emitter).
  private subHomesUnderFlowWarned = false;

  constructor(private readonly deps: HomeRuntimeRegistryDeps) {
    this.homesStore = deps.homesStore ?? createHomesStore(deps.ctx.homey);
  }

  /** Live sub-home ids, for tests and diagnostics. */
  getBundleHomeIds(): HomeId[] {
    return [...this.bundles.keys()];
  }

  /** Read-only per-bundle diagnostics (test observability + future `ui_homes`). */
  getDiagnostics(): HomeCapacityBundleDiagnostics[] {
    return [...this.bundles.values()].map((bundle) => bundle.getDiagnostics());
  }

  /**
   * Distinct configured meter ids across live bundles — the transport's
   * `getAdditionalMeterDeviceIds` provider (read fresh per poll).
   */
  getMeterDeviceIds(): string[] {
    const ids = new Set<string>();
    for (const bundle of this.bundles.values()) {
      const meterDeviceId = bundle.getMeterDeviceId();
      if (meterDeviceId !== null) ids.add(meterDeviceId);
    }
    return [...ids];
  }

  /**
   * Realtime-reconcile routing (R7b P1#1): resolve a drifting device to the
   * OWNING sub-home bundle's reconcile hooks. An external on/off change to a
   * sub-home load must be reconciled through THAT home's plan — main's plan
   * filters sub-home members out, so `hasPlanExecutionDriftForDevice` against
   * main's plan is always false and the change would be silently dropped.
   * Returns `undefined` for a main-home device, an unknown device, or a home
   * with no live bundle; the caller then reconciles through main's plan service
   * exactly as before (the no-sub-homes path stays byte-identical).
   */
  getReconcileHooksForDevice(deviceId: string): RealtimeReconcileHooks | undefined {
    const homeId = this.deps.ctx.homeMembership?.getHomeIdForDevice(deviceId) ?? MAIN_HOME_ID;
    if (homeId === MAIN_HOME_ID) return undefined;
    return this.bundles.get(homeId)?.getReconcileHooks();
  }

  /** Reconcile bundles against the persisted homes registry (see module doc). */
  reconcile(): void {
    // Feature flag OFF: the multi-home feature is inert — no per-home bundles
    // exist regardless of homes_config. Tear down any that survive a flag
    // flip-off and skip the store read entirely. Unlike a cleared homes_config,
    // this is unconditional: a 'suspect' read must NOT keep bundles alive while
    // the feature is disabled.
    if (!isMultiHomeEnabled(this.deps.ctx.homey.settings)) {
      for (const [homeId, bundle] of [...this.bundles]) {
        bundle.teardown();
        this.bundles.delete(homeId);
      }
      this.warnIfSubHomesUnderFlowSource(0);
      return;
    }
    const read = this.homesStore.read();
    // 'suspect' = persisted truth unknown → keep the current bundles running.
    if (read.state === 'suspect') return;
    const desired: readonly SubHomeConfig[] = read.state === 'present' ? read.value.subHomes : [];
    const desiredIds = new Set(desired.map((home) => home.homeId));
    for (const [homeId, bundle] of [...this.bundles]) {
      if (desiredIds.has(homeId)) continue;
      bundle.teardown();
      this.bundles.delete(homeId);
    }
    for (const home of desired) {
      const existing = this.bundles.get(home.homeId);
      if (existing) {
        existing.updateHomeConfig(home);
        continue;
      }
      this.bundles.set(home.homeId, createHomeCapacityBundle({
        ctx: this.deps.ctx,
        home,
        isMembershipReady: this.deps.isMembershipReady,
      }));
    }
    this.warnIfSubHomesUnderFlowSource(desired.length);
  }

  /**
   * Sub-home bundles are driven ONLY by the per-meter fan-out of the
   * `manager/energy/live` poll, which never runs under `power_source = flow`
   * (`homeyEnergyPoll.ts`). So a sub-home configured in flow mode gets ZERO
   * meter samples for the app's lifetime: its bundle stays in `stale_hold` and
   * never actuates. Surface a structured warn (the homes UI should also
   * validate — U-track, see TODO.md); edge-triggered so it logs once per
   * transition into the misconfigured state, not on every reconcile.
   */
  private warnIfSubHomesUnderFlowSource(subHomeCount: number): void {
    const flowMode = normalizePowerSource(this.deps.ctx.homey.settings.get(POWER_SOURCE)) !== 'homey_energy';
    const misconfigured = subHomeCount > 0 && flowMode;
    if (misconfigured && !this.subHomesUnderFlowWarned) {
      this.deps.ctx.getStructuredLogger('homes')?.warn({
        event: 'sub_homes_configured_under_flow_power_source',
        subHomeCount,
        detail: 'sub-home meters are only sampled by the Homey Energy poll; under '
          + 'power_source=flow they receive no samples and never actuate',
      });
    }
    this.subHomesUnderFlowWarned = misconfigured;
  }

  /**
   * Fire each bundle's once-only membership-ready apply-edge. Called by the
   * membership service on the zone-tree-commit transition (false→true), so the
   * committed dry-run plan is applied the moment execution becomes trustworthy —
   * decoupled from meter-sample arrival (works in flow mode too). Idempotent:
   * each bundle latches, so repeat calls are no-ops.
   */
  onMembershipReady(): void {
    for (const bundle of this.bundles.values()) bundle.applyMembershipReadyEdge();
  }

  /** Route one poll's per-meter readings to the owning bundles' pipelines. */
  routeMeterReadings(readings: Record<string, number>, nowMs: number): void {
    // Poll-discard parity (R7b): the transport fans these readings out from INSIDE
    // the live-report fetch, but only when the poll source AUTHORIZES it — its
    // generation + source liveness gate (`HomeyEnergyPollSource.pollNow`'s
    // `authorizeFanOut`). So a stale-generation poll (a whole-home-meter /
    // power-source restart superseded it) never reaches this routing at all, and an
    // out-of-order sub-meter sample cannot land. The power-source check is mirrored
    // here as belt-and-suspenders (and because tests drive `routeMeterReadings`
    // directly): if the source is not `homey_energy`, drop the readings.
    if (normalizePowerSource(this.deps.ctx.homey.settings.get(POWER_SOURCE)) !== 'homey_energy') return;
    for (const bundle of this.bundles.values()) {
      const meterDeviceId = bundle.getMeterDeviceId();
      if (meterDeviceId === null || !Object.hasOwn(readings, meterDeviceId)) continue;
      bundle.recordMeterSample(readings[meterDeviceId], nowMs);
    }
  }

  /** Suffix-hook entry point (`SettingsHandlerDeps.onHomeScopedSettingChanged`). */
  onHomeScopedSettingChanged(baseKey: string, homeId: string): void {
    let bundle = this.bundles.get(homeId);
    if (!bundle) {
      // Unknown homeId = transient (the write may precede the homes_config
      // handler's reconcile): dirty-mark by reconciling once, then re-check.
      this.reconcile();
      bundle = this.bundles.get(homeId);
    }
    if (!bundle) {
      this.deps.ctx.getStructuredLogger('homes')?.debug({
        event: 'home_scoped_setting_for_unknown_home',
        homeId,
        baseKey,
        detail: 'transient — reconciled against the registry, no bundle exists',
      });
      return;
    }
    if (baseKey === POWER_TRACKER_STATE) {
      bundle.reloadPowerTracker();
      return;
    }
    if (CAPACITY_SCALAR_BASE_KEYS.has(baseKey)) bundle.reloadCapacityScalars();
  }

  /** Uninit: tear down every bundle (persisted suffixed state stays). */
  teardownAll(): void {
    for (const bundle of this.bundles.values()) bundle.teardown();
    this.bundles.clear();
  }
}
