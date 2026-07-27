import { buildDeviceActuator } from './buildDeviceActuator';
import { requireDeviceManager } from './contextGuards';
import { isExternalOffHeldForDevice } from './toPlanDevice';
import { PlanEngine as PlanEngineClass } from '../../lib/plan/planEngine';
import { isDeviceObservationStale } from '../../lib/observer/observationFreshness';
import type { DeviceDiagnosticsRecorder } from '../../lib/diagnostics/deviceDiagnosticsService';
import type { Actuator } from '../../lib/actuator/deviceActuator';
import type { AppContext } from '../../lib/app/appContext';
import { MAIN_HOME_ID } from '../../lib/utils/settingsKeys';
import type { HomeScope } from '../homeRuntime/homeScope';

export type CreatePlanEngineOptions = {
  /**
   * Additional point-of-use fence for a home runtime's actuation. When true,
   * every device write no-ops at the single actuator seam. Sub-home bundles
   * use this for teardown and source-epoch changes; ownership is always
   * checked separately for every home.
   */
  isActuationFenced?: (deviceId: string) => boolean;
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
  apply: (command) => (
    isFenced(command.deviceId) ? Promise.resolve({ requested: false }) : base.apply(command)
  ),
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
  // Ownership is re-checked at the final write seam for EVERY home. Plan
  // membership is resolved when a build starts, but a pin/zone/config change
  // can race an already-queued continuation; returning requested:false lets
  // the executor abandon that stale command without claiming success.
  const actuator: Actuator = createFencedActuator(baseActuator, (deviceId) => {
    const currentHomeId = ctx.homeMembership?.getHomeIdForDevice(deviceId) ?? MAIN_HOME_ID;
    const meterSources = ctx.homeMembership?.getConfiguredMeterSources();
    return currentHomeId !== scope.homeId
      || meterSources?.state === 'unavailable'
      || meterSources?.deviceIds.has(deviceId) === true
      || options?.isActuationFenced?.(deviceId) === true;
  });

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
    // "Leave off until turned on again": resolved HERE rather than per caller so
    // no home can be wired without it — a missing one would silently make the
    // executor's restore carve-out a no-op for that home's devices. Same
    // resolution the producer applies, so plan and executor share one definition
    // of "held".
    isExternalOffHeld: (deviceId) => isExternalOffHeldForDevice(ctx, deviceId),
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
