import { buildDeviceActuator } from './buildDeviceActuator';
import { requireDeviceManager } from './contextGuards';
import { PlanEngine as PlanEngineClass } from '../../lib/plan/planEngine';
import type { DeviceDiagnosticsRecorder } from '../../lib/diagnostics/deviceDiagnosticsService';
import type { AppContext } from '../../lib/app/appContext';
import {
  DeferredObjectiveDecorationController,
  migrateBlobToPerKeyIfNeeded,
  readAllObjectives,
} from '../../lib/objectives/deferredObjectives';
import { createObjectivePriceHorizonBuilder } from './objectivePriceHorizon';

export function createPlanEngine(ctx: AppContext) {
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
    getPowerTracker: () => ctx.powerTracker,
    getPriceOptimizationEnabled: () => ctx.priceOptimizationEnabled,
    getHardCapKw: () => ctx.capacitySettings.limitKw,
    // Allocation-horizon price source, resolved from the price layer; shared
    // single source of truth so the objectives subsystem stays free of `lib/price`.
    buildPriceHorizon: createObjectivePriceHorizonBuilder(ctx),
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
    deviceManager,
    getObservedState: (deviceId) => ctx.getObservedState(deviceId),
    actuator,
    getCapacityGuard: () => ctx.capacityGuard,
    getCapacitySettings: () => ctx.capacitySettings,
    getCapacityDryRun: () => ctx.capacityDryRun,
    getOperatingMode: () => ctx.operatingMode,
    getModeDeviceTargets: () => ctx.modeDeviceTargets,
    getPriceOptimizationEnabled: () => ctx.priceOptimizationEnabled,
    getPriceOptimizationSettings: () => ctx.priceOptimizationSettings,
    isCurrentHourCheap: () => ctx.isCurrentHourCheap(),
    isCurrentHourExpensive: () => ctx.isCurrentHourExpensive(),
    getPowerTracker: () => ctx.powerTracker,
    getDailyBudgetSnapshot: () => ctx.dailyBudgetService?.getSnapshot() ?? null,
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
