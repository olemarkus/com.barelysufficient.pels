import { isDeviceObservationStale } from '../observer/observationFreshness';
import {
  resolveCommandableNow,
  resolveShedIntent,
  type CommandableNowGraceEntry,
} from '../device/deviceActionProjection';
import { getPrimaryTargetCapability } from '../utils/targetCapabilities';
import { buildResidualKwForPlanDevice } from './appInit/residualKwForPlanDevice';
import { PlanEngine as PlanEngineClass } from '../plan/planEngine';
import { PlanService } from '../plan/planService';
import { PriceCoordinator } from '../price/priceCoordinator';
import { PriceFlowTagPublisher } from '../price/priceFlowTags';
import { readPriceStore } from '../price/priceStore';
import { registerFlowCards } from '../../flowCards/registerFlowCards';
import { resolveHomeyEnergyApiFromSdk } from '../utils/homeyEnergy';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { FlowHomeyLike } from '../utils/types';
import { DeviceDiagnosticsService, type DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import type { AppContext } from './appContext';
import {
  applyDeferredObjectiveChange,
  normalizeDeferredObjectiveSettings,
} from '../plan/deferredObjectives';
import { DEFERRED_OBJECTIVES_SETTINGS, LEARNED_THERMOSTAT_DEADBAND_C } from '../utils/settingsKeys';
import {
  getLearnedThermostatDeadbandC,
  normaliseLearnedThermostatDeadbandMap,
} from '../utils/learnedThermostatDeadbandStore';
import {
  disableDeferredObjectiveInSettings,
  requireDeferredObjectiveActivePlanRecorder,
  requireDeferredObjectivePlanHistoryRecorder,
  WATERMARK_IDLE_REFRESH_MS,
  writeWatermark,
} from './appInit/deferredRecorders';
import {
  buildStepPowerCalibrationView,
  resolveHasRecentObservedDrawAtSelectedStep,
} from './appInit/calibrationViews';

export {
  createDeferredObjectiveActivePlanRecorder,
  createDeferredObjectivePlanHistoryRecorder,
  persistDeferredObjectiveObservationWatermark,
} from './appInit/deferredRecorders';

function requireDeviceManager(ctx: AppContext) {
  if (!ctx.deviceManager) {
    throw new Error('DeviceTransport must be initialized before plan engine setup.');
  }
  return ctx.deviceManager;
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
  let lastWatermarkPersistMs = 0;
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
    getDeferredObjectiveActivePlans: () => (
      ctx.deferredObjectiveActivePlanRecorder?.getActivePlansSnapshot() ?? null
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
    observeDeferredObjectivePlanHistory: (diagnostics, nowMs, getStallClassification) => {
      const recorder = requireDeferredObjectivePlanHistoryRecorder(ctx);
      const activePlans = ctx.deferredObjectiveActivePlanRecorder?.getActivePlansSnapshot() ?? null;
      recorder.observe(diagnostics, nowMs, activePlans, getStallClassification);
      // Persist the watermark when we flushed new history (recorder is clean and the save
      // succeeded). Otherwise, if the recorder is clean and enough time has passed since the
      // last watermark write, also advance it — this keeps the back-fill window small during
      // long idle stretches and prevents post-enable objectives from being back-filled into
      // periods they didn't exist for. If the recorder is still dirty (failed save), leave
      // the watermark alone so the next restart re-tries the persistence.
      const flushed = recorder.flushIfDirty();
      if (flushed) {
        writeWatermark(ctx, nowMs);
        lastWatermarkPersistMs = nowMs;
        return;
      }
      if (recorder.isDirty()) return;
      if (nowMs - lastWatermarkPersistMs < WATERMARK_IDLE_REFRESH_MS) return;
      writeWatermark(ctx, nowMs);
      lastWatermarkPersistMs = nowMs;
    },
    observeDeferredObjectiveActivePlans: (diagnostics, nowMs) => {
      const recorder = requireDeferredObjectiveActivePlanRecorder(ctx);
      recorder.observe(diagnostics, nowMs);
      recorder.flushIfDirty();
    },
    // Read through `ctx.planService` at call time rather than capturing a
    // reference at engine construction — `createPlanEngine` runs before
    // `createPlanService`, so the service does not yet exist here. Returning
    // `undefined` for an unclassified device (which is also what the
    // classifier returns for `active` devices) means the recorder treats
    // missing-classifier as "no stall promotion" and the target-reached
    // path remains unchanged.
    getStallClassification: (deviceId) => (
      ctx.planService?.getStallClassification(deviceId)
    ),
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
    getDeferredObjectiveStatusBus: () => ctx.deferredObjectiveStatusBus,
    getDeferredObjectiveHoursRemainingBus: () => ctx.deferredObjectiveHoursRemainingBus,
    getDeferredObjectiveHoursRemainingTracker: () => ctx.deferredObjectiveHoursRemainingTracker,
    disableDeferredObjective: (deviceId) => disableDeferredObjectiveInSettings(ctx, deviceId),
    log: (...args: unknown[]) => ctx.log(...args),
    logDebug: (...args: unknown[]) => ctx.logDebug('plan', ...args),
    error: (...args: unknown[]) => ctx.error(...args),
  });
}

export function createPlanService(ctx: AppContext): PlanService {
  return new PlanService({
    homey: ctx.homey,
    planEngine: requirePlanEngine(ctx),
    getPlanDevices: () => ctx.latestTargetSnapshot
      .map((device) => toPlanDevice(ctx, device))
      .filter((device) => device.managed !== false),
    getCapacityDryRun: () => ctx.capacityDryRun,
    loggers: {
      structuredLog: ctx.getStructuredLogger('plan'),
      debugStructured: ctx.getStructuredDebugEmitter('plan', 'plan'),
    },
    isCurrentHourCheap: () => ctx.isCurrentHourCheap(),
    isCurrentHourExpensive: () => ctx.isCurrentHourExpensive(),
    // Use readPriceStore so a legacy V1 payload is migrated to V2 on first
    // read; otherwise hasPrices()/hasCombinedPrices() (which only know V2)
    // would return false during the post-upgrade window and price_level
    // would resolve to UNKNOWN.
    getCombinedPrices: () => readPriceStore(
      { homey: ctx.homey, requestRefetch: () => ctx.priceCoordinator?.updateCombinedPrices() },
      ctx.getNow(),
      ctx.getTimeZone(),
    ),
    getLastPowerUpdate: () => ctx.powerTracker.lastTimestamp ?? null,
    schedulePostActuationRefresh: () => ctx.snapshotHelpers.schedulePostActuationRefresh(),
    overviewDebugStructured: ctx.getStructuredDebugEmitter('overview', 'overview'),
    isOverviewDebugEnabled: () => ctx.debugLoggingTopics.has('overview'),
    isPlanDebugEnabled: () => ctx.debugLoggingTopics.has('plan'),
    deviceDiagnostics: ctx.deviceDiagnosticsService,
    snapshotWarmupGate: ctx.snapshotWarmupGate,
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
    getDeferredObjectivePlanRevisionBus: () => ctx.deferredObjectivePlanRevisionBus,
    getDeferredObjectiveEndedBus: () => ctx.deferredObjectiveEndedBus,
    getDeferredObjectiveHoursRemainingBus: () => ctx.deferredObjectiveHoursRemainingBus,
    getDeferredObjectiveHoursRemainingTracker: () => ctx.deferredObjectiveHoursRemainingTracker,
    applyDeferredObjectiveChange: (params) => {
      const activeRecorder = requireDeferredObjectiveActivePlanRecorder(ctx);
      const historyRecorder = requireDeferredObjectivePlanHistoryRecorder(ctx);
      applyDeferredObjectiveChange({
        ...params,
        activePlanRecorder: activeRecorder,
        planHistoryRecorder: historyRecorder,
      });
      activeRecorder.flushIfDirty();
      historyRecorder.flushIfDirty();
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
    onCombinedPricesUpdated: (reason) => {
      const publisher = ctx.priceFlowTagPublisher;
      if (!publisher) return;
      publisher.publish(reason).catch((error) => ctx.error('PriceFlowTagPublisher.publish failed', error));
    },
  });
}

export function createPriceFlowTagPublisher(ctx: AppContext): PriceFlowTagPublisher {
  return new PriceFlowTagPublisher({
    homey: ctx.homey,
    requestPriceRefetch: () => ctx.priceCoordinator?.updateCombinedPrices(),
    log: (...args: unknown[]) => ctx.log(...args),
    logDebug: (...args: unknown[]) => ctx.logDebug('price', ...args),
    error: (...args: unknown[]) => ctx.error(...args),
  });
}

function resolveHasBinaryControl(device: TargetDeviceSnapshot): boolean {
  if (typeof device.controlCapabilityId === 'string') return true;
  if (!Array.isArray(device.capabilities)) return false;
  return device.capabilities.some((capabilityId) => capabilityId === 'onoff' || capabilityId === 'evcharger_charging');
}

export function toPlanDevice(ctx: AppContext, device: TargetDeviceSnapshot) {
  const pendingBinaryCommand = ctx.planEngine?.getPendingBinaryCommandForDevice?.(
    device.id,
    device.communicationModel,
  );
  const calibration = buildStepPowerCalibrationView(ctx, device);
  const hasRecentObservedDrawAtSelectedStep = resolveHasRecentObservedDrawAtSelectedStep(
    ctx,
    device,
  );
  const nowMs = ctx.getNow().getTime();
  const previousObservation = ctx.lastKnownCommandableByDevice[device.id];
  const commandable = resolveCommandableNow({
    dev: {
      deviceClass: device.deviceClass,
      controlCapabilityId: device.controlCapabilityId,
      evChargingState: device.evChargingState,
      available: device.available,
    },
    previousObservation,
    nowMs,
  });
  // Write the resolved bit back as the next cycle's grace-window observation
  // (only on a confident answer — uncertain reads inherited from the previous
  // observation already passed through, so writing them would extend the
  // grace window indefinitely).
  if (!isUncertainCommandableRead(device)) {
    recordCommandableObservation(ctx.lastKnownCommandableByDevice, device.id, {
      commandableNow: commandable.commandableNow,
      observedAtMs: nowMs,
    });
  }
  const hasBinaryControl = resolveHasBinaryControl(device);
  const shedBehavior = ctx.getShedBehavior(device.id);
  const residualKw = buildResidualKwForPlanDevice({
    device,
    hasBinaryControl,
    shedBehavior,
  });
  const shedIntent = resolveShedIntent({
    shedBehavior,
    hasBinaryControl,
    controlModel: device.controlModel,
    steppedLoadProfile: device.steppedLoadProfile,
    primaryTarget: getPrimaryTargetCapability(device.targets),
  });
  return {
    ...device,
    hasBinaryControl,
    observationStale: isDeviceObservationStale(device),
    managed: ctx.resolveManagedState(device.id),
    controllable: ctx.isCapacityControlEnabled(device.id),
    budgetExempt: ctx.isBudgetExempt(device.id),
    temperatureBoost: ctx.getTemperatureBoostConfig?.(device.id),
    evBoost: ctx.getEvBoostConfig?.(device.id),
    binaryCommandPending: pendingBinaryCommand !== null && pendingBinaryCommand !== undefined,
    binaryCommandPendingDesired: pendingBinaryCommand?.desired,
    commandableNow: commandable.commandableNow,
    commandableNowReason: commandable.reason,
    residualKw,
    shedIntent,
    ...(calibration ? { stepPowerCalibration: calibration } : {}),
    ...(hasRecentObservedDrawAtSelectedStep !== undefined
      ? { hasRecentObservedDrawAtSelectedStep }
      : {}),
  };
}


/**
 * An EV snapshot with no `evChargingState` is "uncertain" — the SDK didn't
 * return a state this poll. We don't extend the grace window in that case
 * because the resolver already chose to fall back to the previous
 * observation; rewriting the observation here would re-anchor the grace
 * timestamp every cycle and make the window effectively infinite.
 *
 * EV detection mirrors `resolveCommandableNow`'s gate
 * (`controlCapabilityId === 'evcharger_charging'`).
 */
function isUncertainCommandableRead(device: TargetDeviceSnapshot): boolean {
  return device.controlCapabilityId === 'evcharger_charging' && device.evChargingState === undefined;
}

/**
 * Record the resolved commandable observation for `deviceId` into the
 * AppContext-owned grace-window record. Mirrors how `managerRuntime`
 * writes through to `state.lastKnownPowerKw`: the record itself is the
 * mutable store, this helper just isolates the assignment so the call
 * site at `toPlanDevice` doesn't trip `no-param-reassign` on `ctx`.
 */
function recordCommandableObservation(
  record: Record<string, CommandableNowGraceEntry>,
  deviceId: string,
  entry: CommandableNowGraceEntry,
): void {
  // eslint-disable-next-line functional/immutable-data, no-param-reassign
  record[deviceId] = entry;
}
