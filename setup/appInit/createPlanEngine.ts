import { getDebugEmitter } from '../../lib/logging/logger';
import { buildDeviceActuator } from './buildDeviceActuator';
import { requireDeviceManager } from './contextGuards';
import { isExternalOffHeldForObservedDevice } from '../../lib/planInput/externalOffHoldProjection';
import type CapacityGuard from '../../lib/power/capacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { PlanExecutor } from '../../lib/executor/planExecutor';
import type { StorageLaneBinding } from '../../lib/ports/batteryControlOwner';
import { createPlanEngineState } from '../../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import type { Actuator } from '../../lib/actuator/deviceActuator';
import type { AppContext } from '../../lib/app/appContext';
import type { PlanEngine } from '../../lib/plan/planEngine';
import type { HomeScope } from '../homeRuntime/homeScope';
import { ComposedPlanEngine } from './composedPlanEngine';
import { bindTemperatureSetpoints } from './temperatureSetpointsSeam';

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
  /**
   * The storage lane's binding: Main's battery control owner, or `none` for a
   * meter area, which plans and commands no battery.
   */
  storageLane: StorageLaneBinding;
};

export type PlanEngineCompositionResult = {
  planEngine: PlanEngine;
  lifecycleFallbackPort: NonNullable<AppContext['lifecycleFallback']>;
};

/**
 * Wrap an actuator so every `apply` no-ops (requested:false, `base` untouched)
 * while `isFenced()` is true. An in-flight continuation cannot issue a device
 * write after its execution posture changes.
 */
export const createFencedActuator = (
  base: Actuator,
  isFenced: (deviceId: string) => boolean,
): Actuator => ({
  canTurnOnDevice: base.canTurnOnDevice.bind(base),
  resolveTemperatureTarget: base.resolveTemperatureTarget.bind(base),
  apply: (command) => (
    isFenced(command.deviceId) ? Promise.resolve({ requested: false }) : base.apply(command)
  ),
});

export function createPlanEngineComposition(
  ctx: AppContext,
  scope: HomeScope,
  options: CreatePlanEngineOptions,
): PlanEngineCompositionResult {
  // Assert the device manager first so its absence surfaces the canonical
  // "DeviceTransport must be initialized" error. buildDeviceActuator only returns
  // null when the device manager is absent, so past this guard the actuator is
  // non-null; the assertion just satisfies the required dep type. The handle
  // itself is not kept: the executor reads devices through `ctx`'s descriptor
  // and observed reads below, never through the transport.
  requireDeviceManager(ctx);
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

  // "Leave off until turned on again": resolved HERE rather than per caller so
  // no home can be wired without it — a missing one would silently make the
  // executor's restore carve-out a no-op for that home's devices. Same
  // resolution the producer applies, so plan and executor share one definition
  // of "held".
  const state = createPlanEngineState(Date.now(), (deviceId) => isExternalOffHeldForObservedDevice(
    ctx.externalOffHold?.isHeld(deviceId) === true,
    ctx.observer.getObservedRecord(deviceId),
  ));
  const pendingBinaryCommandStore = createPendingBinaryCommandStore(
    state.pendingBinaryCommands,
    scope.binaryCommandLifecycle,
  );
  // Scope-owned diagnostics recorder, resolved LIVE at engine construction
  // (after `initDeviceDiagnosticsService`): main binds the shared app recorder;
  // a sub-home resolves undefined so its plans never pollute main's per-boot epoch.
  const deviceDiagnostics = scope.getDeviceDiagnostics();
  const structuredLog = ctx.getStructuredLogger('plan');
  const debugStructured = getDebugEmitter('plan', 'plan');
  const getShedBehavior = (deviceId: string) => ctx.getShedBehavior(deviceId);
  // Policy closures from the scope: the main home binds the live ctx reads; a
  // sub-home capacity bundle binds disabled constants for the PRICE/BUDGET
  // members, so its engine is capacity-only without this factory branching on
  // which home it serves. The two mode members are the exception — every home
  // binds them live, because the mode target is the restore anchor (see
  // `homeScope.ts`).
  const builder = new PlanBuilder({
    setCapacityInShortfall: scope.setCapacityInShortfall,
    getCapacityDryRun: scope.getCapacityDryRun,
    capacityGuard: options.capacityGuard,
    getCapacitySettings: scope.getCapacitySettings,
    getPriceOptimizationSettings: scope.getPriceOptimizationSettings,
    getInferredSurplusKw: scope.getInferredSurplusKw,
    // The same hold, recorded at the one moment PELS releases a standing
    // posture of its own on an observed-off device.
    leaveOffOnRelease: (deviceId) => ctx.externalOffHold?.holdOnRelease(deviceId) ?? 'unavailable',
    getPowerTracker: scope.getPowerTracker,
    getDailyBudgetSnapshot: scope.getDailyBudgetSnapshot,
    getShedBehavior,
    getDynamicSoftLimitOverride: scope.getDynamicSoftLimitOverride,
    deviceDiagnostics,
    structuredLog,
    debugStructured,
    // Smart-task decoration seam, owned by the scope (`buildMainHomeScope`
    // constructs the DeferredObjectiveDecorationController; a sub-home bundle
    // binds `decorateWithoutDeferredObjectives`, the identity bundle in the
    // seam's own shape).
    decorateDeferredObjectives: scope.decorateDeferredObjectives,
    resolveTemperatureSetpoints: bindTemperatureSetpoints(scope, ctx),
    pendingBinaryCommandStore,
    log: (...args: unknown[]) => ctx.log(...args),
  }, state);
  const executor = new PlanExecutor({
    getHomeDisplayName: scope.getHomeDisplayName,
    // The id is already a plain scope field (a home id cannot change without a
    // new scope), so log correlation needs no extra getter.
    homeId: scope.homeId,
    setCapacityInShortfall: scope.setCapacityInShortfall,
    persistLastControlledMs: scope.persistLastControlledMs,
    // Runtime configuration and observed state come from their respective
    // owners. Device inventory metadata does not enter planner or executor.
    getDeviceConfiguration: (deviceId: string) => ctx.deviceConfiguration.get(deviceId),
    getDeviceConfigurations: () => ctx.deviceConfiguration.getAll(),
    // The RECORD, not the base read: the executor's drift check reads the
    // reported step, measured power and EV state off it. Supplying
    // `getObservedState` here compiles — narrow is assignable to wide, since
    // every cluster field is optional — and would work only for as long as the
    // object stayed physically wider than its type.
    getObservedState: (deviceId: string) => ctx.observer.getObservedRecord(deviceId),
    getObservationRevision: () => ctx.observer.getRevision(),
    actuator,
    capacityGuard: options.capacityGuard,
    getCapacitySettings: scope.getCapacitySettings,
    getPowerTracker: scope.getPowerTracker,
    getCapacityPaceKw: () => builder.computeCapacityPace(),
    // Planner-owned number, resolved here so the executor does not import
    // lib/plan to re-derive it for a log line.
    getShortfallThresholdKw: () => builder.computeShortfallThreshold(),
    getCapacityDryRun: scope.getCapacityDryRun,
    getOperatingMode: scope.getOperatingMode,
    getShedBehavior,
    markSteppedLoadDesiredStepIssued: (params) => ctx.deviceControlHelpers.markSteppedLoadDesiredStepIssued(params),
    getSteppedLoadCommandSession: (deviceId) => (
      ctx.deviceControlHelpers.getSteppedLoadCommandSession(deviceId)
    ),
    // Scope-owned so the sync targets THIS home's plan service (see HomeScope).
    syncLivePlanStateAfterTargetActuation: scope.syncLivePlanStateAfterTargetActuation,
    deviceDiagnostics,
    pendingBinaryCommandStore,
    storageLane: options.storageLane,
  }, state);
  return {
    planEngine: new ComposedPlanEngine({
      state,
      pendingBinaryCommandStore,
      // App-wide, like the profiles they interpret: device ids are globally
      // unique, so every home's settle pass reads the same two stores.
      steppedCommandStore: ctx.steppedCommandStore,
      steppedReportedStore: ctx.steppedReportedStore,
      builder,
      executor,
      deviceDiagnostics,
      debugStructured,
      structuredLog,
    }),
    lifecycleFallbackPort: executor.getLifecycleFallbackPort(),
  };
}
