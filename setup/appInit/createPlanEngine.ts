import { buildDeviceActuator } from './buildDeviceActuator';
import { requireDeviceManager } from './contextGuards';
import { isExternalOffHeldForDevice } from './toPlanDevice';
import type CapacityGuard from '../../lib/power/capacityGuard';
import type { PlanEngine } from '../../lib/plan/planEngine';
import { PlanBuilder, type PlanBuilderDeps } from '../../lib/plan/planBuilder';
import { PlanExecutor } from '../../lib/executor/planExecutor';
import type { PlanExecutorDeps } from '../../lib/executor/planExecutor';
import { createPlanEngineState } from '../../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import type { Actuator } from '../../lib/actuator/deviceActuator';
import type { AppContext } from '../../lib/app/appContext';
import type { HomeScope } from '../homeRuntime/homeScope';
import type { PlanEngineWiring } from './planEngineWiring';
import { ComposedPlanEngine } from './composedPlanEngine';

export type CreatePlanEngineOptions = {
  /**
   * The home's capacity guard, injected by value. Both wiring paths now
   * construct it before the plan engine, so the planner cannot be handed an
   * absent one — there is no accessor to return `undefined` from.
   */
  capacityGuard: CapacityGuard;
  /**
   * This home's point-of-use actuation fence. When true, every device write
   * no-ops at the single actuator seam. It carries the conditions that can
   * change DURING an apply — a home torn down, its meter source epoch
   * replaced, its prepared plan generation superseded — which the once-per-
   * build gates cannot catch: a plan can be superseded between its first SDK
   * write and its tenth.
   *
   * It carries no membership knowledge. Which devices are this home's is
   * settled when the plan is built (`filterDevicesForHome`), and a device that
   * moves home afterwards is handled by re-planning both homes, not by
   * second-guessing the plan at the write.
   */
  isActuationFenced: (deviceId: string) => boolean;
};

export type PlanEngineCompositionResult = {
  planEngine: PlanEngine;
  lifecycleFallbackPort: NonNullable<AppContext['lifecycleFallback']>;
};

/**
 * Wrap an actuator so every `apply` no-ops (requested:false, `base` untouched)
 * while `isFenced()` is true. The single-method actuator seam makes this the
 * simplest robust point-of-use fence: an in-flight continuation cannot issue a
 * device write after its execution posture changes.
 */
export const createFencedActuator = (
  base: Actuator,
  isFenced: (deviceId: string) => boolean,
): Actuator => ({
  resolveTemperatureTarget: base.resolveTemperatureTarget.bind(base),
  apply: (command) => (
    isFenced(command.deviceId) ? Promise.resolve({ requested: false }) : base.apply(command)
  ),
});

const composePlanEngine = (deps: PlanEngineWiring): PlanEngineCompositionResult => {
  const state = createPlanEngineState(Date.now(), deps.isExternalOffHeld);
  const pendingBinaryCommandStore = createPendingBinaryCommandStore(
    state.pendingBinaryCommands,
    deps.binaryCommandLifecycle,
  );
  const builderDeps: PlanBuilderDeps = {
    setCapacityInShortfall: deps.setCapacityInShortfall,
    getCapacityDryRun: deps.getCapacityDryRun,
    capacityGuard: deps.capacityGuard,
    getCapacitySettings: deps.getCapacitySettings,
    getOperatingMode: deps.getOperatingMode,
    getModeDeviceTargets: deps.getModeDeviceTargets,
    getPriceOptimizationEnabled: deps.getPriceOptimizationEnabled,
    getPriceOptimizationSettings: deps.getPriceOptimizationSettings,
    getCurrentHourPriceLevel: deps.getCurrentHourPriceLevel,
    getInferredSurplusKw: deps.getInferredSurplusKw,
    getPowerTracker: deps.getPowerTracker,
    getDailyBudgetSnapshot: deps.getDailyBudgetSnapshot,
    getShedBehavior: deps.getShedBehavior,
    getDynamicSoftLimitOverride: deps.getDynamicSoftLimitOverride,
    deviceDiagnostics: deps.deviceDiagnostics,
    structuredLog: deps.structuredLog,
    debugStructured: deps.debugStructured,
    decorateDeferredObjectives: deps.decorateDeferredObjectives,
    pendingBinaryCommandStore,
    log: deps.log,
    logDebug: deps.logDebug,
  };
  const builder = new PlanBuilder(builderDeps, state);
  const executorDeps: PlanExecutorDeps = {
    getHomeDisplayName: deps.getHomeDisplayName,
    homeId: deps.homeId,
    setCapacityInShortfall: deps.setCapacityInShortfall,
    persistLastControlledMs: deps.persistLastControlledMs,
    deviceManager: deps.deviceManager,
    // The RECORD, not the base read: the executor's drift check reads the
    // reported step, measured power and EV state off it. Supplying
    // `getObservedState` here compiles — narrow is assignable to wide, since
    // every cluster field is optional — and would work only for as long as the
    // object stayed physically wider than its type.
    getObservedState: deps.getObservedRecord,
    getObservationRevision: deps.getObservationRevision,
    actuator: deps.actuator,
    capacityGuard: deps.capacityGuard,
    getCapacitySettings: deps.getCapacitySettings,
    getPowerTracker: deps.getPowerTracker,
    getCapacityPaceKw: () => builder.computeDynamicSoftLimit(),
    // Planner-owned number, resolved here so the executor does not import
    // lib/plan to re-derive it for a log line.
    getShortfallThresholdKw: () => builder.computeShortfallThreshold(),
    getCapacityDryRun: deps.getCapacityDryRun,
    getOperatingMode: deps.getOperatingMode,
    getShedBehavior: deps.getShedBehavior,
    markSteppedLoadDesiredStepIssued: deps.markSteppedLoadDesiredStepIssued,
    getSteppedLoadCommandSession: deps.getSteppedLoadCommandSession,
    logTargetRetryComparison: deps.logTargetRetryComparison,
    syncLivePlanStateAfterTargetActuation: deps.syncLivePlanStateAfterTargetActuation,
    deviceDiagnostics: deps.deviceDiagnostics,
    pendingBinaryCommandStore,
  };
  const executor = new PlanExecutor(executorDeps, state);
  return {
    planEngine: new ComposedPlanEngine({
      state,
      pendingBinaryCommandStore,
      steppedCommandStore: deps.steppedCommandStore,
      steppedReportedStore: deps.steppedReportedStore,
      builder,
      executor,
      deviceDiagnostics: deps.deviceDiagnostics,
      debugStructured: deps.debugStructured,
      structuredLog: deps.structuredLog,
    }),
    lifecycleFallbackPort: executor.getLifecycleFallbackPort(),
  };
};

export function createPlanEngineComposition(
  ctx: AppContext,
  scope: HomeScope,
  options: CreatePlanEngineOptions,
): PlanEngineCompositionResult {
  // Resolve the device manager first so its absence surfaces the canonical
  // "DeviceTransport must be initialized" error. buildDeviceActuator only returns
  // null when the device manager is absent, so past this guard the actuator is
  // non-null; the assertion just satisfies the required dep type.
  const deviceManager = requireDeviceManager(ctx);
  const baseActuator = buildDeviceActuator(ctx);
  if (!baseActuator) {
    throw new Error('Device actuator must be initialized before plan engine setup.');
  }
  // The home's own fence, and nothing else. This used to also re-read
  // membership per write and drop the command when the device had since moved
  // home or turned out to be a configured meter — but both were already
  // settled when the plan was built: `filterDevicesForHome` gives a home only
  // its own members and drops every meter, and fails closed to an empty list
  // when ownership cannot be resolved. So those clauses could only ever fire
  // on a plan that was already stale, using home identity as a proxy for
  // staleness. A device that changes home mid-apply is an ordinary
  // reconciliation: the write lands, both homes re-plan, and the next cycle
  // decides from the new membership (owner ruling 2026-09-08).
  const actuator: Actuator = createFencedActuator(baseActuator, options.isActuationFenced);

  const deps: PlanEngineWiring = {
    getHomeDisplayName: scope.getHomeDisplayName,
    // The id is already a plain scope field (a home id cannot change without a
    // new scope), so log correlation needs no extra getter.
    homeId: scope.homeId,
    setCapacityInShortfall: scope.setCapacityInShortfall,
    // App-wide, like the profiles they interpret: device ids are globally
    // unique, so every home's settle pass reads the same two stores.
    steppedCommandStore: ctx.steppedCommandStore,
    steppedReportedStore: ctx.steppedReportedStore,
    persistLastControlledMs: scope.persistLastControlledMs,
    deviceManager,
    // See the sibling wiring above: the drift check holds the record.
    getObservedRecord: (deviceId: string) => ctx.getObservedRecord(deviceId),
    getObservationRevision: () => ctx.getObservationRevision(),
    // "Leave off until turned on again": resolved HERE rather than per caller so
    // no home can be wired without it — a missing one would silently make the
    // executor's restore carve-out a no-op for that home's devices. Same
    // resolution the producer applies, so plan and executor share one definition
    // of "held".
    isExternalOffHeld: (deviceId) => isExternalOffHeldForDevice(ctx, deviceId),
    actuator,
    binaryCommandLifecycle: scope.binaryCommandLifecycle,
    capacityGuard: options.capacityGuard,
    getCapacitySettings: scope.getCapacitySettings,
    getCapacityDryRun: scope.getCapacityDryRun,
    // Policy closures from the scope: the main home binds the live ctx reads
    // (byte-identical to the pre-R7b hardwiring); a sub-home capacity bundle
    // binds disabled constants for the PRICE/BUDGET members, so its engine is
    // capacity-only without this factory branching on which home it serves.
    // The two mode members are the exception — every home binds them live,
    // because the mode target is the restore anchor (see `homeScope.ts`).
    getOperatingMode: scope.getOperatingMode,
    getModeDeviceTargets: scope.getModeDeviceTargets,
    getPriceOptimizationEnabled: scope.getPriceOptimizationEnabled,
    getPriceOptimizationSettings: scope.getPriceOptimizationSettings,
    getCurrentHourPriceLevel: scope.getCurrentHourPriceLevel,
    getInferredSurplusKw: scope.getInferredSurplusKw,
    getPowerTracker: scope.getPowerTracker,
    getDailyBudgetSnapshot: scope.getDailyBudgetSnapshot,
    // Smart-task decoration seam, owned by the scope (`buildMainHomeScope`
    // constructs the DeferredObjectiveDecorationController; a sub-home bundle
    // binds `decorateWithoutDeferredObjectives`, the identity bundle in the
    // seam's own shape).
    decorateDeferredObjectives: scope.decorateDeferredObjectives,
    // Scope-owned: priorities are ranked per mode, and only the scope knows
    // this home's ACTIVE mode (a sub-home may pin its own; see homeScope.ts).
    getShedBehavior: (deviceId) => ctx.getShedBehavior(deviceId),
    getDynamicSoftLimitOverride: scope.getDynamicSoftLimitOverride,
    markSteppedLoadDesiredStepIssued: (params) => ctx.deviceControlHelpers.markSteppedLoadDesiredStepIssued(params),
    getSteppedLoadCommandSession: (deviceId) => (
      ctx.deviceControlHelpers.getSteppedLoadCommandSession(deviceId)
    ),
    logTargetRetryComparison: (params) => ctx.logTargetRetryComparison?.(params),
    // Scope-owned so the sync targets THIS home's plan service (see HomeScope).
    syncLivePlanStateAfterTargetActuation: scope.syncLivePlanStateAfterTargetActuation,
    // Scope-owned diagnostics recorder, resolved LIVE at engine construction
    // (after `initDeviceDiagnosticsService`): main binds the shared app recorder;
    // a sub-home resolves undefined so its plans never pollute main's per-boot epoch.
    deviceDiagnostics: scope.getDeviceDiagnostics(),
    structuredLog: ctx.getStructuredLogger('plan'),
    debugStructured: ctx.getStructuredDebugEmitter('plan', 'plan'),
    log: (...args: unknown[]) => ctx.log(...args),
    logDebug: (...args: unknown[]) => ctx.logDebug('plan', ...args),
    error: (...args: unknown[]) => ctx.error(...args),
  };
  return composePlanEngine(deps);
}

/** Sub-home composition does not own the main smart-task lifecycle clock. */
export function createPlanEngine(
  ctx: AppContext,
  scope: HomeScope,
  options: CreatePlanEngineOptions,
): PlanEngine {
  return createPlanEngineComposition(ctx, scope, options).planEngine;
}
