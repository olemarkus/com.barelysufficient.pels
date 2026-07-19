import { buildDeviceActuator } from './buildDeviceActuator';
import { requireDeviceManager } from './contextGuards';
import { PlanEngine as PlanEngineClass } from '../../lib/plan/planEngine';
import { isDeviceObservationStale } from '../../lib/observer/observationFreshness';
import type { DeviceDiagnosticsRecorder } from '../../lib/diagnostics/deviceDiagnosticsService';
import type { AppContext } from '../../lib/app/appContext';
import type { HomeScope } from '../homeRuntime/homeScope';
import {
  DeferredObjectiveDecorationController,
  migrateBlobToPerKeyIfNeeded,
  readAllObjectives,
} from '../../lib/objectives/deferredObjectives';
import { isSmartTaskDeviceInMainHome } from './smartTaskHomeScope';
import { createObjectivePriceHorizonBuilder } from './objectivePriceHorizon';

export function createPlanEngine(ctx: AppContext, scope: HomeScope) {
  // Smart-task controller: lives in the app-wiring layer so the planner engine
  // (lib/plan) imports nothing from lib/objectives. The engine receives only the
  // opaque `decorateDeferredObjectives` function below, keeping the planner — and
  // the executor downstream — entirely smart-task-agnostic.
  const deferredObjectiveController = new DeferredObjectiveDecorationController({
    getDeferredObjectiveSettings: () => {
      // Self-heal a boot-time empty-`getKeys()` flake that skipped the one-shot
      // migration: idempotent + marker-gated (a cheap single `get` once done), so
      // retrying on the plan cycle makes legacy objectives visible within seconds
      // instead of staying invisible (planner + UI) until the next app restart.
      migrateBlobToPerKeyIfNeeded(ctx.homey.settings);
      return readAllObjectives(ctx.homey.settings);
    },
    getDeferredObjectiveActivePlans: () => (
      ctx.deferredObjectiveActivePlanRecorder?.getActivePlansSnapshot() ?? null
    ),
    getTimeZone: () => ctx.getTimeZone(),
    getPowerTracker: scope.getPowerTracker,
    getPriceOptimizationEnabled: () => ctx.priceOptimizationEnabled,
    getHardCapKw: () => scope.getCapacitySettings().limitKw,
    // Allocation-horizon price source, resolved from the price layer; shared
    // single source of truth so the objectives subsystem stays free of `lib/price`.
    buildPriceHorizon: createObjectivePriceHorizonBuilder(ctx),
    // Multi-home v1: a sub-home device's task resolves to the dedicated
    // `objective_device_in_sub_home` unknown diagnostic (never planned) instead
    // of masquerading as a missing device. Membership absent (boot window /
    // bare test contexts) or no sub-homes configured → false for every device,
    // preserving exact single-home behavior.
    isDeviceInSubHome: (deviceId) => !isSmartTaskDeviceInMainHome(ctx, deviceId),
  });

  // Resolve the device manager first so its absence surfaces the canonical
  // "DeviceTransport must be initialized" error. buildDeviceActuator only returns
  // null when the device manager is absent, so past this guard the actuator is
  // non-null; the assertion just satisfies the required dep type.
  const deviceManager = requireDeviceManager(ctx);
  const actuator = buildDeviceActuator(ctx);
  if (!actuator) {
    throw new Error('Device actuator must be initialized before plan engine setup.');
  }

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
    getOperatingMode: () => ctx.operatingMode,
    getModeDeviceTargets: () => ctx.modeDeviceTargets,
    getPriceOptimizationEnabled: () => ctx.priceOptimizationEnabled,
    getPriceOptimizationSettings: () => ctx.priceOptimizationSettings,
    isCurrentHourCheap: () => ctx.isCurrentHourCheap(),
    isCurrentHourExpensive: () => ctx.isCurrentHourExpensive(),
    // Inferred curtailed-surplus term for the surplus allocator. Late-bound
    // closure: the curtailment estimator is wired post-startup
    // (`wireCurtailmentSurplus`), after this engine exists — until then the
    // context getter reads null (fail-closed).
    getInferredSurplusKw: () => ctx.getCurtailedSurplusKw?.() ?? null,
    getPowerTracker: scope.getPowerTracker,
    getDailyBudgetSnapshot: scope.getDailyBudgetSnapshot,
    decorateDeferredObjectives: (input) => deferredObjectiveController.decorate(input),
    getPriorityForDevice: (deviceId) => ctx.getPriorityForDevice(deviceId),
    getShedBehavior: (deviceId) => ctx.getShedBehavior(deviceId),
    getDynamicSoftLimitOverride: () => ctx.getDynamicSoftLimitOverride(),
    markSteppedLoadDesiredStepIssued: (params) => ctx.deviceControlHelpers.markSteppedLoadDesiredStepIssued(params),
    logTargetRetryComparison: (params) => ctx.logTargetRetryComparison?.(params),
    syncLivePlanStateAfterTargetActuation: (source) => ctx.syncLivePlanStateAfterTargetActuation?.(source),
    deviceDiagnostics: ctx.deviceDiagnosticsService as DeviceDiagnosticsRecorder | undefined,
    structuredLog: ctx.getStructuredLogger('plan'),
    debugStructured: ctx.getStructuredDebugEmitter('plan', 'plan'),
    log: (...args: unknown[]) => ctx.log(...args),
    logDebug: (...args: unknown[]) => ctx.logDebug('plan', ...args),
    error: (...args: unknown[]) => ctx.error(...args),
  });
}
