import { isDeviceObservationStale } from '../observer/observationFreshness';
import { PlanEngine as PlanEngineClass } from '../plan/planEngine';
import { PlanService } from '../plan/planService';
import { PriceCoordinator } from '../price/priceCoordinator';
import { registerFlowCards } from '../../flowCards/registerFlowCards';
import { COMBINED_PRICES } from '../utils/settingsKeys';
import { resolveHomeyEnergyApiFromSdk } from '../utils/homeyEnergy';
import type { FlowHomeyLike, TargetDeviceSnapshot } from '../utils/types';
import { DeviceDiagnosticsService, type DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import type { AppContext } from './appContext';
import {
  DeferredObjectiveActivePlanRecorder,
  DeferredObjectivePlanHistoryRecorder,
  normalizeDeferredObjectiveActivePlans,
  normalizeDeferredObjectivePlanHistory,
  normalizeDeferredObjectiveSettings,
} from '../plan/deferredObjectives';
import {
  DEFERRED_OBJECTIVES_SETTINGS,
  DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING,
  DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING,
} from '../utils/settingsKeys';

function requireDeviceManager(ctx: AppContext) {
  if (!ctx.deviceManager) {
    throw new Error('DeviceManager must be initialized before plan engine setup.');
  }
  return ctx.deviceManager;
}

export function createDeferredObjectivePlanHistoryRecorder(
  ctx: AppContext,
): DeferredObjectivePlanHistoryRecorder {
  return new DeferredObjectivePlanHistoryRecorder({
    load: () => normalizeDeferredObjectivePlanHistory(
      ctx.homey.settings.get(DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING),
    ),
    save: (next) => {
      try {
        ctx.homey.settings.set(DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING, next);
      } catch (error) {
        ctx.error('Failed to persist deferred-objective plan history', error);
      }
    },
  });
}

function requireDeferredObjectivePlanHistoryRecorder(
  ctx: AppContext,
): DeferredObjectivePlanHistoryRecorder {
  if (!ctx.deferredObjectivePlanHistoryRecorder) {
    throw new Error('DeferredObjectivePlanHistoryRecorder must be initialized before plan engine setup.');
  }
  return ctx.deferredObjectivePlanHistoryRecorder;
}

export function createDeferredObjectiveActivePlanRecorder(
  ctx: AppContext,
): DeferredObjectiveActivePlanRecorder {
  return new DeferredObjectiveActivePlanRecorder({
    load: () => normalizeDeferredObjectiveActivePlans(
      ctx.homey.settings.get(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING),
    ),
    save: (next) => {
      try {
        ctx.homey.settings.set(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING, next);
      } catch (error) {
        ctx.error('Failed to persist deferred-objective active plans', error);
      }
    },
    debugStructured: ctx.getStructuredDebugEmitter('deferred_objectives', 'deferred_objectives'),
  });
}

function requireDeferredObjectiveActivePlanRecorder(
  ctx: AppContext,
): DeferredObjectiveActivePlanRecorder {
  if (!ctx.deferredObjectiveActivePlanRecorder) {
    throw new Error('DeferredObjectiveActivePlanRecorder must be initialized before plan engine setup.');
  }
  return ctx.deferredObjectiveActivePlanRecorder;
}

function requirePlanEngine(ctx: AppContext) {
  if (!ctx.planEngine) {
    throw new Error('PlanEngine must be initialized before plan service setup.');
  }
  return ctx.planEngine;
}

function requirePlanService(ctx: AppContext) {
  if (!ctx.planService) {
    throw new Error('PlanService must be initialized before price coordinator wiring.');
  }
  return ctx.planService;
}

function requireDailyBudgetService(ctx: AppContext) {
  if (!ctx.dailyBudgetService) {
    throw new Error('DailyBudgetService must be initialized before flow card registration.');
  }
  return ctx.dailyBudgetService;
}

function requireFlowHomey(ctx: AppContext): FlowHomeyLike {
  const { homey } = ctx;
  if (
    typeof homey.flow?.getTriggerCard !== 'function'
    || typeof homey.flow?.getConditionCard !== 'function'
    || typeof homey.flow?.getActionCard !== 'function'
    || typeof homey.settings?.get !== 'function'
    || typeof homey.settings?.set !== 'function'
  ) {
    throw new Error('Flow card registration requires Homey flow and settings APIs.');
  }
  return homey as unknown as FlowHomeyLike;
}

export const createDeviceDiagnosticsService = (ctx: AppContext): DeviceDiagnosticsService => (
  new DeviceDiagnosticsService({
    homey: ctx.homey,
    getTimeZone: () => ctx.getTimeZone(),
    isDebugEnabled: () => ctx.debugLoggingTopics.has('diagnostics'),
    structuredLog: ctx.getStructuredLogger('diagnostics'),
    logDebug: (...args: unknown[]) => ctx.logDebug('diagnostics', ...args),
    error: (...args: unknown[]) => ctx.error(...args),
  })
);

export function createPlanEngine(ctx: AppContext) {
  return new PlanEngineClass({
    homey: ctx.homey,
    deviceManager: requireDeviceManager(ctx),
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
    getDeferredObjectiveSettings: () => normalizeDeferredObjectiveSettings(
      ctx.homey.settings.get(DEFERRED_OBJECTIVES_SETTINGS),
    ),
    getTimeZone: () => ctx.getTimeZone(),
    getPriorityForDevice: (deviceId) => ctx.getPriorityForDevice(deviceId),
    getShedBehavior: (deviceId) => ctx.getShedBehavior(deviceId),
    getDynamicSoftLimitOverride: () => ctx.getDynamicSoftLimitOverride(),
    markSteppedLoadDesiredStepIssued: (params) => ctx.deviceControlHelpers.markSteppedLoadDesiredStepIssued(params),
    logTargetRetryComparison: (params) => ctx.logTargetRetryComparison?.(params),
    syncLivePlanStateAfterTargetActuation: (source) => ctx.syncLivePlanStateAfterTargetActuation?.(source),
    deviceDiagnostics: ctx.deviceDiagnosticsService as DeviceDiagnosticsRecorder | undefined,
    structuredLog: ctx.getStructuredLogger('plan'),
    debugStructured: ctx.getStructuredDebugEmitter('plan', 'plan'),
    deferredObjectiveDebugStructured: ctx.getStructuredDebugEmitter('deferred_objectives', 'deferred_objectives'),
    observeDeferredObjectivePlanHistory: (diagnostics, nowMs) => {
      const recorder = requireDeferredObjectivePlanHistoryRecorder(ctx);
      recorder.observe(diagnostics, nowMs);
      recorder.flushIfDirty();
    },
    observeDeferredObjectiveActivePlans: (diagnostics, nowMs) => {
      const recorder = requireDeferredObjectiveActivePlanRecorder(ctx);
      recorder.observe(diagnostics, nowMs);
      recorder.flushIfDirty();
    },
    getDeferredObjectiveStatusBus: () => ctx.deferredObjectiveStatusBus,
    disableDeferredObjective: (deviceId) => disableDeferredObjectiveInSettings(ctx, deviceId),
    log: (...args: unknown[]) => ctx.log(...args),
    logDebug: (...args: unknown[]) => ctx.logDebug('plan', ...args),
    error: (...args: unknown[]) => ctx.error(...args),
  });
}

const disableDeferredObjectiveInSettings = (ctx: AppContext, deviceId: string): void => {
  const current = normalizeDeferredObjectiveSettings(ctx.homey.settings.get(DEFERRED_OBJECTIVES_SETTINGS));
  const entry = current.objectivesByDeviceId[deviceId];
  if (!entry || !entry.enabled) return;
  const next = {
    ...current,
    objectivesByDeviceId: {
      ...current.objectivesByDeviceId,
      [deviceId]: { ...entry, enabled: false },
    },
  };
  ctx.homey.settings.set(DEFERRED_OBJECTIVES_SETTINGS, next);
  // Drop in-memory status + active plan so flow conditions like
  // `deadline_status_is` and the deadline UI agree with the persisted state
  // immediately, instead of seeing the last published snapshot until the
  // next plan cycle's forget-sweep runs.
  ctx.deferredObjectiveStatusBus?.forgetDevice(deviceId);
  ctx.deferredObjectiveActivePlanRecorder?.clearForDevice(deviceId);
};

export function createPlanService(ctx: AppContext): PlanService {
  return new PlanService({
    homey: ctx.homey,
    planEngine: requirePlanEngine(ctx),
    getPlanDevices: () => ctx.latestTargetSnapshot
      .map((device) => toPlanDevice(ctx, device))
      .filter((device) => device.managed !== false),
    getCapacityDryRun: () => ctx.capacityDryRun,
    log: (...args: unknown[]) => ctx.log(...args),
    logDebug: (...args: unknown[]) => ctx.logDebug('plan', ...args),
    error: (...args: unknown[]) => ctx.error(...args),
    isCurrentHourCheap: () => ctx.isCurrentHourCheap(),
    isCurrentHourExpensive: () => ctx.isCurrentHourExpensive(),
    getCombinedPrices: () => ctx.homey.settings.get(COMBINED_PRICES) as unknown,
    getLastPowerUpdate: () => ctx.powerTracker.lastTimestamp ?? null,
    schedulePostActuationRefresh: () => ctx.snapshotHelpers.schedulePostActuationRefresh(),
    structuredLog: ctx.getStructuredLogger('plan'),
    debugStructured: ctx.getStructuredDebugEmitter('plan', 'plan'),
    overviewDebugStructured: ctx.getStructuredDebugEmitter('overview', 'overview'),
    isOverviewDebugEnabled: () => ctx.debugLoggingTopics.has('overview'),
    isPlanDebugEnabled: () => ctx.debugLoggingTopics.has('plan'),
    deviceDiagnostics: ctx.deviceDiagnosticsService,
  });
}

export function registerAppFlowCards(ctx: AppContext): void {
  registerFlowCards({
    homey: requireFlowHomey(ctx),
    structuredLog: ctx.getStructuredLogger('devices'),
    resolveModeName: (mode) => ctx.resolveModeName(mode),
    getAllModes: () => ctx.getAllModes(),
    getCurrentOperatingMode: () => ctx.operatingMode,
    handleOperatingModeChange: (rawMode) => ctx.handleOperatingModeChange(rawMode),
    getCurrentPriceLevel: () => ctx.getCurrentPriceLevel(),
    areFlowBackedCardsAvailable: () => ctx.areFlowBackedCardsAvailable(),
    recordPowerSample: (powerW) => {
      if (ctx.homey.settings.get('power_source') === 'homey_energy') return Promise.resolve();
      return ctx.recordPowerSample(powerW);
    },
    getCapacityGuard: () => ctx.capacityGuard,
    getHeadroom: () => ctx.capacityGuard?.getHeadroom() ?? null,
    setCapacityLimit: (kw) => ctx.capacityGuard?.setLimit(kw),
    getSnapshot: () => ctx.getFlowSnapshot(),
    refreshSnapshot: (options) => ctx.refreshTargetDevicesSnapshot(options),
    getHomeyDevicesForFlow: () => ctx.getHomeyDevicesForFlow(),
    reportFlowBackedCapability: (params) => ctx.reportFlowBackedCapability(params),
    reportSteppedLoadActualStep: (deviceId, stepId) => (
      ctx.deviceControlHelpers.reportSteppedLoadActualStep(deviceId, stepId)
    ),
    getDeviceLoadSetting: (deviceId) => ctx.getDeviceLoadSetting(deviceId),
    setExpectedOverride: (deviceId, kw) => ctx.setExpectedOverride(deviceId, kw),
    storeFlowPriceData: (kind, raw) => ctx.storeFlowPriceData(kind, raw),
    rebuildPlan: (source) => ctx.requestFlowPlanRebuild(source),
    getDeferredObjectiveSettings: () => normalizeDeferredObjectiveSettings(
      ctx.homey.settings.get(DEFERRED_OBJECTIVES_SETTINGS),
    ),
    setDeferredObjectiveSettings: (next) => {
      ctx.homey.settings.set(DEFERRED_OBJECTIVES_SETTINGS, next);
    },
    getDeferredObjectiveStatusBus: () => ctx.deferredObjectiveStatusBus,
    markDeferredObjectiveActivePlanPending: (seed, nowMs) => {
      const recorder = requireDeferredObjectiveActivePlanRecorder(ctx);
      recorder.markPending(seed, nowMs);
      recorder.flushIfDirty();
    },
    clearDeferredObjectiveActivePlan: (deviceId) => {
      const recorder = requireDeferredObjectiveActivePlanRecorder(ctx);
      recorder.clearForDevice(deviceId);
      recorder.flushIfDirty();
    },
    evaluateHeadroomForDevice: (params) => ctx.evaluateHeadroomForDevice(params),
    loadDailyBudgetSettings: () => requireDailyBudgetService(ctx).loadSettings(),
    updateDailyBudgetState: (options) => ctx.updateDailyBudgetState(options),
    getCombinedHourlyPrices: () => ctx.getCombinedHourlyPrices(),
    getTimeZone: () => ctx.getTimeZone(),
    getNow: () => ctx.getNow(),
    getStructuredLogger: (component) => ctx.getStructuredLogger(component),
    log: (...args: unknown[]) => ctx.log(...args),
    logDebug: (...args: unknown[]) => ctx.logDebug('settings', ...args),
    error: (...args: unknown[]) => ctx.error(...args),
  });
}

export function createPriceCoordinator(ctx: AppContext): PriceCoordinator {
  return new PriceCoordinator({
    homey: ctx.homey,
    getHomeyEnergyApi: () => resolveHomeyEnergyApiFromSdk(ctx.homey),
    getCurrentPriceLevel: () => ctx.getCurrentPriceLevel(),
    rebuildPlanFromCache: (reason) => requirePlanService(ctx).rebuildPlanFromCache(reason).then(() => undefined),
    log: (...args: unknown[]) => ctx.log(...args),
    logDebug: (...args: unknown[]) => ctx.logDebug('price', ...args),
    error: (...args: unknown[]) => ctx.error(...args),
    structuredLog: ctx.getStructuredLogger('price'),
  });
}

function resolveHasBinaryControl(device: TargetDeviceSnapshot): boolean {
  if (typeof device.controlCapabilityId === 'string') return true;
  if (!Array.isArray(device.capabilities)) return false;
  return device.capabilities.some((capabilityId) => capabilityId === 'onoff' || capabilityId === 'evcharger_charging');
}

function toPlanDevice(ctx: AppContext, device: TargetDeviceSnapshot) {
  const pendingBinaryCommand = ctx.planEngine?.getPendingBinaryCommandForDevice?.(
    device.id,
    device.communicationModel,
  );
  return {
    ...device,
    hasBinaryControl: resolveHasBinaryControl(device),
    observationStale: isDeviceObservationStale(device),
    managed: ctx.resolveManagedState(device.id),
    controllable: ctx.isCapacityControlEnabled(device.id),
    budgetExempt: ctx.isBudgetExempt(device.id),
    temperatureBoost: ctx.getTemperatureBoostConfig?.(device.id),
    evBoost: ctx.getEvBoostConfig?.(device.id),
    binaryCommandPending: pendingBinaryCommand !== null && pendingBinaryCommand !== undefined,
    binaryCommandPendingDesired: pendingBinaryCommand?.desired,
  };
}
