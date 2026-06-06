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
import { LEARNED_THERMOSTAT_DEADBAND_C } from '../../lib/utils/settingsKeys';
import {
  getLearnedThermostatDeadbandC,
  normaliseLearnedThermostatDeadbandMap,
} from '../../lib/utils/learnedThermostatDeadbandStore';

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
    // Read-through into the persisted per-device learned deadband map. The
    // setting is updated on every met/stalled finalize by
    // `updateLearnedThermostatDeadbandFromEntry` in `deferredRecorders.ts`,
    // so a fresh read each call picks up the latest EMA without caching.
    // Settings.get can transiently throw (`feedback_homey_sdk_unreliable`);
    // we treat a throw as "no learned value" so the override falls back to
    // the raw user target rather than poisoning a plan cycle.
    getLearnedThermostatDeadbandC: (deviceId: string): number => {
      let raw: unknown;
      try {
        raw = ctx.homey.settings.get(LEARNED_THERMOSTAT_DEADBAND_C) as unknown;
      } catch {
        return 0;
      }
      return getLearnedThermostatDeadbandC(
        normaliseLearnedThermostatDeadbandMap(raw),
        deviceId,
      );
    },
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
