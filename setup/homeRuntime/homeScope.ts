/**
 * Per-home closure bundle for the plan factories
 * (`setup/appInit/createPlanEngine.ts`, `setup/appInit/createPlanService.ts`).
 *
 * Today the app runs exactly one always-on home (`MAIN_HOME_ID`); the
 * factories used to hardwire singleton closures over `AppContext`. `HomeScope`
 * lifts those closures into an injected bundle so multi-home wiring can
 * construct N engines/services, each with per-home closures, without touching
 * the factories again. `buildMainHomeScope` reproduces the exact pre-refactor
 * closures: same live `ctx` reads, same unsuffixed settings keys
 * (`homeScopedSettingsKey` is the identity for the main home).
 *
 * R7b adds the POLICY block: the price/objective/surplus closures the
 * factories previously read straight off `ctx`. The main home binds them to
 * those same ctx reads (byte-identical); a sub-home capacity bundle
 * (`setup/homeRuntime/createHomeCapacityBundle.ts`) binds disabled constants —
 * sub-homes are STRICTLY capacity-only (no daily budget, no price
 * optimization, no smart-task decoration).
 *
 * "Capacity-only" is a claim about POLICY INPUTS, not about the write surface:
 * the operating mode and mode-target members bind live for every home, so a
 * sub-home does issue `set_temperature` writes to hold a member at its mode
 * target with no capacity pressure at all — exactly as main does. That is the
 * restore anchor; see `getModeDeviceTargets` below.
 */
import { requirePlanService } from '../appInit/contextGuards';
import type { HomeId } from '../../lib/power/capacitySettingsStore';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type { PriceLevel } from '../../lib/price/priceLevels';
import type { PelsStatus } from '../../lib/plan/pelsStatus';
import type { PlanEngineWiring } from '../appInit/planEngineWiring';
import type { DeviceDiagnosticsService } from '../../lib/diagnostics/deviceDiagnosticsService';
import type { AppContext } from '../../lib/app/appContext';
import { resolveConfiguredDevicePriority } from '../../lib/utils/capacityHelpers';
import type { BinaryCommandLifecycleListener } from '../../lib/observer/pendingBinaryCommands';
import { createBinaryCommandReachability } from '../../lib/plan/admission/binaryCommandReachability';
// Direct file imports (not the `setup/appInit.ts` barrel): the barrel also
// exports the plan factories, which import this module — going through the
// barrel would create a module cycle.
import { buildHomePlanDevices } from './planDevicePrePass';
import { createObjectivePriceHorizonBuilder } from '../appInit/objectivePriceHorizon';
import { resolveSmartTaskDeviceExclusion } from '../appInit/smartTaskHomeScope';
import {
  createTrustedDeferredObjectiveSettingsReader,
  DeferredObjectiveDecorationController,
} from '../../lib/objectives/deferredObjectives';
import { HOMES_MAIN_HOME_NAME } from '../../packages/shared-domain/src/homeNames';
import {
  CAPACITY_IN_SHORTFALL,
  DEVICE_LAST_CONTROLLED_MS,
  MAIN_HOME_ID,
  PELS_STATUS,
  homeScopedSettingsKey,
} from '../../lib/utils/settingsKeys';

/**
 * The closure bundle one home hands to its plan engine/service factories.
 * Every member is a live closure (re-read on each call), matching the
 * pre-existing wiring semantics.
 */
export type HomeScope = {
  homeId: HomeId;
  /**
   * This home's user-facing name, resolved by the producer. The alert
   * dispatcher uses it as the `home` token on both global hard-cap Flow
   * triggers (`capacity_shortfall` and `capacity_shortfall_sustained`), so a
   * Flow can tell which part of the home ran out of managed load
   * instead of every home firing an indistinguishable empty payload. Main binds
   * the canonical "Main home" label; a sub-home binds its meter-area name.
   */
  getHomeDisplayName: () => string;
  // Capacity scalars: for the MAIN home these are live reads of the in-memory
  // snapshot (settings-handler maintained); sub-home scopes (R7b) back them
  // with a per-home `CapacitySettingsStore` as their ONLY capacity source.
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getCapacityDryRun: () => boolean;
  getPowerTracker: () => PowerTrackerState;
  getDailyBudgetSnapshot: () => DailyBudgetUiPayload | null;
  /** Active planned devices with a unique, gap-free relative priority in this home. */
  getPlanDevices: () => PlanInputDevice[];
  binaryCommandLifecycle: BinaryCommandLifecycleListener;
  disposeBinaryCommandReachability: () => void;
  // Persisted-signal writers. Each writes this home's key
  // (`homeScopedSettingsKey(base, homeId)` — the bare key for the main home).
  setCapacityInShortfall: (inShortfall: boolean) => void;
  persistLastControlledMs: (lastControlledMs: Record<string, number>) => void;
  writePelsStatus: (status: PelsStatus) => void;
  // ---- Policy block (R7b) ----
  // Main binds live ctx reads; sub-home scopes bind disabled constants so
  // their engines collapse to pure capacity control.
  getPriceOptimizationEnabled: () => boolean;
  // Both current-hour price flags from ONE combined-series build; see
  // `PriceService.getCurrentHourPriceLevel`.
  getCurrentHourPriceLevel: () => PriceLevel;
  /** Inferred curtailed-surplus term for the surplus allocator; null disables. */
  getInferredSurplusKw: () => number | null;
  // Policy stragglers lifted onto the scope so a sub-home's capacity-only engine
  // no longer inherits MAIN's raw ctx reads. Main binds the identical current
  // reads (byte-identical); sub-home scopes bind neutral constants for the
  // PRICE/BUDGET members — but NOT for the two mode members below.
  /** Per-device price-opt config; feeds the surplus allocator + temperature surplus-absorb. Sub-homes bind `{}`. */
  getPriceOptimizationSettings: PlanEngineWiring['getPriceOptimizationSettings'];
  /** Test/diagnostic soft-limit override; consulted un-gated in the builder. Sub-homes bind `null`. */
  getDynamicSoftLimitOverride: () => number | null;
  /**
   * Active operating mode driving `mode_device_targets`. EVERY home binds the
   * live read — do NOT neutralize this for a sub-home (see below).
   */
  getOperatingMode: PlanEngineWiring['getOperatingMode'];
  /**
   * Mode→device desired-target map. EVERY home binds the live read, because the
   * mode target is the **restore anchor**, not a price/budget policy input.
   * Binding `{}` for a sub-home (as this contract used to require) made
   * `resolveTemperatureSeed` fall back to the device's live setpoint; while shed
   * that reading IS the shed setpoint, so on release `plannedTarget` equalled
   * `currentTarget`, the executor dropped the write, and an area temperature
   * device stayed cold indefinitely. Price optimization and surplus absorb are gated
   * independently by `getPriceOptimizationSettings`: both require a per-device
   * config entry, and an empty map has none, so binding these live does not
   * widen policy.
   */
  getModeDeviceTargets: PlanEngineWiring['getModeDeviceTargets'];
  /**
   * Device priority under THIS home's active mode. Priorities are ranked per
   * mode. Main binds the historical app resolver; a meter-area bundle binds
   * the priority map in its coherent catalog snapshot.
   */
  /**
   * Does this home hold a mode-target RAISE while its own power reading is
   * unknown? A raise ADDS load and is issued as an ordinary `target_update`, so
   * unlike every other load-adding decision it consults neither headroom nor the
   * restore cooldowns (`applyModeSeedModulation`, `lib/plan/planDevices.ts`).
   *
   * Sub-homes bind `true`: an area whose meter is offline stays unknown for as
   * long as the meter is down, and nothing else escalates it. Main binds `false`
   * — its unknown-power window is normally the seconds before the first Homey
   * Energy poll, and it owns settle/dwell machinery for the power-goes-unknown
   * transition that a blanket clamp would pre-empt.
   */
  holdsModeTargetRaisesWhilePowerUnknown: () => boolean;
  // ---- UI / side-effect singletons (R7b Cluster B) ----
  // Three surfaces `createPlanService` used to bind straight to `ctx` for every
  // home. Main binds the live read (byte-identical); a sub-home neutralizes so
  // its capacity-only plan never drives MAIN's user-facing channels.
  /** Whether this home drives the shared settings-UI realtime channel (`plan_updated`). Main true; sub-homes false. */
  emitsUiRealtime: boolean;
  /**
   * Per-boot diagnostics recorder, resolved LIVE (main: the shared app
   * recorder; sub-homes: `undefined` — no cross-home pollution). A live getter,
   * NOT a captured value: `buildMainHomeScope` runs in the `AppServiceWiring`
   * constructor, BEFORE `initDeviceDiagnosticsService` sets
   * `ctx.deviceDiagnosticsService`; a frozen value would strand the main engine
   * and service on `undefined` (no starvation, no plan-diagnostics observation).
   * The engine/service read this at their own construction (`initPlanEngine`),
   * which runs AFTER diagnostics init, so the getter resolves the real recorder.
   */
  getDeviceDiagnostics: () => DeviceDiagnosticsService | undefined;
  /**
   * Smart-task decoration seam. Absent = identity decoration (the planner's
   * own `buildIdentityDecorationBundle` fallback) — how sub-home bundles stay
   * smart-task-free without the engine branching on which home it serves.
   */
  decorateDeferredObjectives?: PlanEngineWiring['decorateDeferredObjectives'];
  /**
   * Post-actuation live-plan-state sync, targeting THIS home's plan service
   * (main: the app's inline-sync delegator; sub-home bundles: a late-bound
   * closure over the bundle's own service — syncing main's would touch the
   * wrong plan). Optional like the engine dep it feeds.
   */
  syncLivePlanStateAfterTargetActuation?: PlanEngineWiring['syncLivePlanStateAfterTargetActuation'];
};

/**
 * The main home's scope: closures over the exact same `ctx` fields and the
 * exact same (unsuffixed) settings keys the factories hardwired before this
 * bundle existed. Zero behavior change by construction.
 */
export function buildMainHomeScope(ctx: AppContext): HomeScope {
  const homeId: HomeId = MAIN_HOME_ID;
  const readTrustedObjectiveSettings = createTrustedDeferredObjectiveSettingsReader(ctx.homey.settings);
  // Smart-task controller: lives in the app-wiring layer so the planner engine
  // (lib/plan) imports nothing from lib/objectives. The engine receives only the
  // opaque `decorateDeferredObjectives` closure below, keeping the planner's
  // input path free of smart-task imports. Lifecycle fallback reaches the
  // executor through a separate setup-wired port. Constructed here
  // (the scope build site) so a sub-home scope can omit it wholesale; every
  // controller dep is a lazy getter, so building it before the price/plan
  // services exist is safe.
  const deferredObjectiveController = new DeferredObjectiveDecorationController({
    getDeferredObjectiveSettings: () => {
      // Self-heal a boot-time empty-`getKeys()` flake that skipped the one-shot
      // migration: idempotent + marker-gated (a cheap single `get` once done), so
      // retrying on the plan cycle makes legacy objectives visible within seconds
      // instead of staying invisible (planner + UI) until the next app restart.
      return readTrustedObjectiveSettings();
    },
    getDeferredObjectiveActivePlans: () => (
      ctx.deferredObjectiveActivePlanRecorder?.getActivePlansSnapshot() ?? null
    ),
    getTimeZone: () => ctx.getTimeZone(),
    getPowerTracker: () => ctx.powerTracker,
    getPriceOptimizationEnabled: () => ctx.priceOptimizationEnabled,
    getHardCapKw: () => ctx.capacitySettings.limitKw,
    getBasePriorityForDevice: (deviceId) => (
      resolveConfiguredDevicePriority(ctx.capacityPriorities, ctx.operatingMode, deviceId)
    ),
    // Allocation-horizon price source, resolved from the price layer; shared
    // single source of truth so the objectives subsystem stays free of `lib/price`.
    buildPriceHorizon: createObjectivePriceHorizonBuilder(ctx),
    // A device out of the main planning lane resolves to its own dedicated
    // unknown diagnostic (never planned) instead of masquerading as a missing
    // device: `objective_device_in_sub_home` for multi-home v1 scope,
    // `objective_device_unmanaged` when the owner turned "Managed by PELS" off.
    // Membership absent (boot window / bare test contexts) with no sub-homes and
    // no explicit opt-out → `null` for every device, preserving exact
    // single-home behavior.
    resolveDeviceExclusion: (deviceId) => resolveSmartTaskDeviceExclusion(ctx, deviceId),
  });
  const binaryCommandReachability = createBinaryCommandReachability({
    requestRebuild: () => {
      queueMicrotask(() => {
        void requirePlanService(ctx).rebuildPlanFromCache('binary_command_reachability_changed');
      });
    },
    scheduleRebuild: (deviceId, dueAtMs) => {
      const key = `binaryCommandReachability:${homeId}:${deviceId}`;
      ctx.timers.registerTimeout(key, setTimeout(() => {
        ctx.timers.clear(key);
        void requirePlanService(ctx).rebuildPlanFromCache('binary_command_reachability_deadline');
      }, Math.max(0, dueAtMs - Date.now())));
    },
    clearScheduledRebuild: (deviceId) => {
      ctx.timers.clear(`binaryCommandReachability:${homeId}:${deviceId}`);
    },
  });
  return {
    homeId,
    getHomeDisplayName: () => HOMES_MAIN_HOME_NAME,
    // Live snapshot reads — NOT re-reads through the settings store. The
    // snapshot is the in-memory truth kept current by the settings handler.
    getCapacitySettings: () => ctx.capacitySettings,
    getCapacityDryRun: () => ctx.capacityDryRun,
    getPowerTracker: () => ctx.powerTracker,
    getDailyBudgetSnapshot: () => ctx.dailyBudgetService?.getSnapshot() ?? null,
    getPlanDevices: () => {
      // Boot/hot-plug seed of the observed-state projection from the RAW cached
      // snapshot BEFORE the per-device `toPlanDevice` reads run. The projection
      // is event-driven (empty until the first delta/refresh for a device), so
      // on the first cold-start cycle — and for a device hot-plugged before its
      // first observation — `getObservedState` would otherwise be empty here and
      // `toPlanDevice` would fall back to the snapshot. Seeding fills only empty
      // slots (never clobbers a recorded observation) and uses the raw cached
      // array, so it adds no re-decoration and no device-manager re-entry.
      // ...plus the external-off release sweep, cache eviction, the membership
      // complement and the planned-set filter — all shared with every sub-home
      // bundle, see `buildHomePlanDevices`.
      return buildHomePlanDevices(ctx, homeId, {
        projectCommandability: binaryCommandReachability.project,
        pruneCommandability: binaryCommandReachability.prune,
      });
    },
    binaryCommandLifecycle: binaryCommandReachability.lifecycle,
    disposeBinaryCommandReachability: binaryCommandReachability.dispose,
    setCapacityInShortfall: (inShortfall) => (
      ctx.homey.settings.set(homeScopedSettingsKey(CAPACITY_IN_SHORTFALL, homeId), inShortfall)
    ),
    persistLastControlledMs: (lastControlledMs) => (
      ctx.homey.settings.set(homeScopedSettingsKey(DEVICE_LAST_CONTROLLED_MS, homeId), lastControlledMs)
    ),
    writePelsStatus: (status) => (
      ctx.homey.settings.set(homeScopedSettingsKey(PELS_STATUS, homeId), status)
    ),
    getPriceOptimizationEnabled: () => ctx.priceOptimizationEnabled,
    getCurrentHourPriceLevel: () => ctx.getCurrentHourPriceLevel(),
    // Late-bound closure: the curtailment estimator is wired post-startup
    // (`wireCurtailmentSurplus`), after the engine exists — until then the
    // context getter reads null (fail-closed).
    getInferredSurplusKw: () => ctx.getCurtailedSurplusKw?.() ?? null,
    // Policy stragglers — the EXACT ctx reads `createPlanEngine`/`toPlanDevice`
    // hardwired before this lift. Byte-identical for the main home.
    getPriceOptimizationSettings: () => ctx.priceOptimizationSettings,
    getDynamicSoftLimitOverride: () => ctx.getDynamicSoftLimitOverride(),
    getOperatingMode: () => ctx.operatingMode,
    getModeDeviceTargets: () => ctx.modeDeviceTargets,
    // Main keeps its pre-existing behaviour: mode targets are commanded whether
    // or not a power sample has landed. See the contract above for why the hold
    // is a sub-home posture rather than a global rule.
    holdsModeTargetRaisesWhilePowerUnknown: () => false,
    decorateDeferredObjectives: (input) => deferredObjectiveController.decorate(input),
    syncLivePlanStateAfterTargetActuation: (source) => ctx.syncLivePlanStateAfterTargetActuation?.(source),
    // UI / side-effect singletons — the EXACT ctx reads `createPlanService`
    // hardwired. Byte-identical for the main home.
    emitsUiRealtime: true,
    getDeviceDiagnostics: () => ctx.deviceDiagnosticsService,
  };
}
