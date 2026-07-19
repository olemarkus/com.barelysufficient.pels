import { buildDeviceActuator } from './buildDeviceActuator';
import { requireDeviceManager } from './contextGuards';
import { PlanEngine as PlanEngineClass } from '../../lib/plan/planEngine';
import { isDeviceObservationStale } from '../../lib/observer/observationFreshness';
import type { DeviceDiagnosticsRecorder } from '../../lib/diagnostics/deviceDiagnosticsService';
import type { Actuator } from '../../lib/actuator/deviceActuator';
import type { AppContext } from '../../lib/app/appContext';
import type { HomeScope } from '../homeRuntime/homeScope';

export type CreatePlanEngineOptions = {
  /**
   * Teardown fence for a sub-home bundle's actuation (multi-home R7b). When it
   * returns true EVERY device write this engine issues no-ops at the single
   * actuator seam — so any in-flight rebuild/reconcile/heartbeat/sample
   * continuation that resolves AFTER the bundle is torn down cannot actuate into
   * main's just-adopted complement (double-control). Absent for the main home →
   * the actuator is the bare `buildDeviceActuator` result, byte-identical.
   */
  isActuationFenced?: () => boolean;
};

/**
 * Wrap an actuator so every `apply` no-ops (requested:false, `base` untouched)
 * while `isFenced()` is true. The single-method actuator seam makes this the
 * simplest robust teardown fence: a removed sub-home bundle's in-flight
 * continuation cannot issue a device write once torn down.
 */
export const createFencedActuator = (base: Actuator, isFenced: () => boolean): Actuator => ({
  apply: (command) => (isFenced() ? Promise.resolve({ requested: false }) : base.apply(command)),
});

export function createPlanEngine(ctx: AppContext, scope: HomeScope, options?: CreatePlanEngineOptions) {
  // Resolve the device manager first so its absence surfaces the canonical
  // "DeviceTransport must be initialized" error. buildDeviceActuator only returns
  // null when the device manager is absent, so past this guard the actuator is
  // non-null; the assertion just satisfies the required dep type.
  const deviceManager = requireDeviceManager(ctx);
  const baseActuator = buildDeviceActuator(ctx);
  if (!baseActuator) {
    throw new Error('Device actuator must be initialized before plan engine setup.');
  }
  // Byte-identical for the main home (no options): the bare actuator. A fenced
  // sub-home actuator short-circuits to a requested:false no-op post-teardown.
  const isActuationFenced = options?.isActuationFenced;
  const actuator: Actuator = isActuationFenced === undefined
    ? baseActuator
    : createFencedActuator(baseActuator, isActuationFenced);

  return new PlanEngineClass({
    homey: ctx.homey,
    setCapacityInShortfall: scope.setCapacityInShortfall,
    persistLastControlledMs: scope.persistLastControlledMs,
    deviceManager,
    getObservedState: (deviceId) => ctx.getObservedState(deviceId),
    // Observer-resolved per-device staleness for the diagnostics freshness gate
    // (starvation must not count stale-but-unobserved time). Same observer-projection
    // seam as createPlanService.getObservationStale; resolved to a flat boolean here.
    // A device with no projection entry yet is treated as not stale.
    getObservationStale: (deviceId) => {
      const observed = ctx.getObservedState(deviceId);
      return observed !== undefined && isDeviceObservationStale(observed);
    },
    actuator,
    getCapacityGuard: scope.getCapacityGuard,
    getCapacitySettings: scope.getCapacitySettings,
    getCapacityDryRun: scope.getCapacityDryRun,
    // Policy closures from the scope: the main home binds the live ctx reads
    // (byte-identical to the pre-R7b hardwiring); a sub-home capacity bundle
    // binds disabled constants, so its engine is capacity-only without this
    // factory branching on which home it serves.
    getOperatingMode: scope.getOperatingMode,
    getModeDeviceTargets: scope.getModeDeviceTargets,
    getPriceOptimizationEnabled: scope.getPriceOptimizationEnabled,
    getPriceOptimizationSettings: scope.getPriceOptimizationSettings,
    isCurrentHourCheap: scope.isCurrentHourCheap,
    isCurrentHourExpensive: scope.isCurrentHourExpensive,
    getInferredSurplusKw: scope.getInferredSurplusKw,
    getPowerTracker: scope.getPowerTracker,
    getDailyBudgetSnapshot: scope.getDailyBudgetSnapshot,
    // Smart-task decoration seam, owned by the scope (`buildMainHomeScope`
    // constructs the DeferredObjectiveDecorationController; sub-home scopes
    // omit the member, so the builder falls back to identity decoration).
    decorateDeferredObjectives: scope.decorateDeferredObjectives,
    getPriorityForDevice: (deviceId) => ctx.getPriorityForDevice(deviceId),
    getShedBehavior: (deviceId) => ctx.getShedBehavior(deviceId),
    getDynamicSoftLimitOverride: scope.getDynamicSoftLimitOverride,
    markSteppedLoadDesiredStepIssued: (params) => ctx.deviceControlHelpers.markSteppedLoadDesiredStepIssued(params),
    logTargetRetryComparison: (params) => ctx.logTargetRetryComparison?.(params),
    // Scope-owned so the sync targets THIS home's plan service (see HomeScope).
    syncLivePlanStateAfterTargetActuation: scope.syncLivePlanStateAfterTargetActuation,
    // Scope-owned diagnostics recorder, resolved LIVE at engine construction
    // (after `initDeviceDiagnosticsService`): main binds the shared app recorder;
    // a sub-home resolves undefined so its plans never pollute main's per-boot epoch.
    deviceDiagnostics: scope.getDeviceDiagnostics() as DeviceDiagnosticsRecorder | undefined,
    structuredLog: ctx.getStructuredLogger('plan'),
    debugStructured: ctx.getStructuredDebugEmitter('plan', 'plan'),
    log: (...args: unknown[]) => ctx.log(...args),
    logDebug: (...args: unknown[]) => ctx.logDebug('plan', ...args),
    error: (...args: unknown[]) => ctx.error(...args),
  });
}
