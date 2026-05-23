import { isDeviceObservationStale } from '../observer/observationFreshness';
import {
  getAdmissionPowerKw,
  getDeliveryPowerKw,
  hasRecentDrawAt,
  isStepCalibrationConfident,
} from '../observer/devicePowerCalibration';
import { PlanEngine as PlanEngineClass } from '../plan/planEngine';
import { PlanService } from '../plan/planService';
import { PriceCoordinator } from '../price/priceCoordinator';
import { PriceFlowTagPublisher } from '../price/priceFlowTags';
import { flattenAllHours, readPriceStore } from '../price/priceStore';
import { registerFlowCards } from '../../flowCards/registerFlowCards';
import { resolveHomeyEnergyApiFromSdk } from '../utils/homeyEnergy';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { FlowHomeyLike } from '../utils/types';
import type { StepPowerCalibrationView } from '../plan/planTypes';
import { firstPositiveFinite } from '../plan/deferredObjectives/planningSpeed';
import { DeviceDiagnosticsService, type DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import type { AppContext } from './appContext';
import {
  applyDeferredObjectiveChange,
  DeferredObjectiveActivePlanRecorder,
  DeferredObjectivePlanHistoryRecorder,
  normalizeDeferredObjectiveActivePlans,
  normalizeDeferredObjectivePlanHistory,
  normalizeDeferredObjectiveSettings,
  type DeferredObjectiveBackfillConfig,
} from '../plan/deferredObjectives';
import type { DeferredObjectiveSettingsEntry } from '../plan/deferredObjectives/settings';
import {
  DEFERRED_OBJECTIVES_SETTINGS,
  DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING,
  DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK,
  DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING,
} from '../utils/settingsKeys';
import { isFiniteNumber } from '../utils/appTypeGuards';

function requireDeviceManager(ctx: AppContext) {
  if (!ctx.deviceManager) {
    throw new Error('DeviceManager must be initialized before plan engine setup.');
  }
  return ctx.deviceManager;
}

const toBackfillConfig = (
  deviceId: string,
  entry: DeferredObjectiveSettingsEntry,
): DeferredObjectiveBackfillConfig | null => {
  // Deadlines are one-shot and the runtime auto-disables on pass, so a still-enabled
  // objective with a past `deadlineAtMs` is exactly the "PELS was off through the deadline"
  // case we want to back-fill. Disabled entries either have an existing observed history row
  // (runtime saw the pass) or were cleared by the user before passing — either way back-fill
  // should ignore them.
  if (!entry.enabled) return null;
  if (entry.kind === 'temperature') {
    return {
      deviceId,
      deviceName: null,
      objectiveKind: 'temperature',
      deadlineAtMs: entry.deadlineAtMs,
      targetTemperatureC: entry.targetTemperatureC,
      targetPercent: null,
    };
  }
  return {
    deviceId,
    deviceName: null,
    objectiveKind: 'ev_soc',
    deadlineAtMs: entry.deadlineAtMs,
    targetTemperatureC: null,
    targetPercent: entry.targetPercent,
  };
};

const readWatermark = (ctx: AppContext): number | null => {
  const raw: unknown = ctx.homey.settings.get(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK);
  return isFiniteNumber(raw) ? raw : null;
};

/**
 * Advance the deferred-objective observation watermark to "now". If the recorder is still
 * dirty (its `save` callback returned `false`, meaning the last flush attempt didn't actually
 * persist), the watermark is left alone — otherwise the next startup back-fill would skip the
 * window containing the entries that never made it to disk, dropping that history silently.
 */
export const persistDeferredObjectiveObservationWatermark = (
  ctx: AppContext,
  recorder: DeferredObjectivePlanHistoryRecorder | undefined,
): void => {
  if (recorder?.isDirty()) return;
  writeWatermark(ctx, Date.now());
};

const writeWatermark = (ctx: AppContext, ms: number): void => {
  try {
    ctx.homey.settings.set(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK, ms);
  } catch (error) {
    ctx.error('Failed to persist deferred-objective observation watermark', error);
  }
};

export function createDeferredObjectivePlanHistoryRecorder(
  ctx: AppContext,
): DeferredObjectivePlanHistoryRecorder {
  const recorder = new DeferredObjectivePlanHistoryRecorder({
    load: () => normalizeDeferredObjectivePlanHistory(
      ctx.homey.settings.get(DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING),
    ),
    save: (next) => {
      try {
        ctx.homey.settings.set(DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING, next);
        return true;
      } catch (error) {
        ctx.error('Failed to persist deferred-objective plan history', error);
        return false;
      }
    },
    endedBus: ctx.deferredObjectiveEndedBus,
    // Resolve hourly spot price + tone for the internal hour-rollover
    // detector. Reads the persisted V2 combined-prices store directly so
    // the postmortem consumes the producer's already-resolved
    // `isCheap`/`isExpensive` flags (per `feedback_layering_resolution_in_producer`).
    // Missing entries / unloaded payload return `null` so the postmortem
    // skips that hour rather than fabricating a contribution.
    resolveHourPrice: (hourStartMs) => resolveHourPriceFromContext(ctx, hourStartMs),
    debugStructured: ctx.getStructuredDebugEmitter('deferred_objectives', 'deferred_objectives'),
  });
  runStartupBackfill(ctx, recorder);
  return recorder;
}

// Look up the persisted V2 combined-prices entry whose hour-aligned
// `startsAt` equals `hourStartMs` and map its already-resolved
// `isCheap`/`isExpensive` flags onto the postmortem tone enum. Consuming
// the producer's classification directly keeps the postmortem tone in
// lockstep with the live price chip (same flag set, same min-diff, same
// thresholds) — no re-derivation, no drift. Returns `null` when no entry
// covers the hour, when `total` is non-finite, or when the payload hasn't
// loaded yet — all three are best-effort skip cases.
const resolveTone = (entry: {
  isCheap?: boolean;
  isExpensive?: boolean;
}): 'cheap' | 'normal' | 'expensive' => {
  if (entry.isCheap) return 'cheap';
  if (entry.isExpensive) return 'expensive';
  return 'normal';
};

const resolveHourPriceFromContext = (
  ctx: AppContext,
  hourStartMs: number,
): { priceValue: number; tone: 'cheap' | 'normal' | 'expensive' } | null => {
  const store = readPriceStore(
    { homey: ctx.homey, requestRefetch: () => ctx.priceCoordinator?.updateCombinedPrices() },
    new Date(),
    ctx.homey.clock.getTimezone(),
  );
  if (!store) return null;
  for (const entry of flattenAllHours(store)) {
    const entryStart = new Date(entry.startsAt).getTime();
    if (!Number.isFinite(entryStart) || entryStart !== hourStartMs) continue;
    if (!Number.isFinite(entry.total)) return null;
    return { priceValue: entry.total, tone: resolveTone(entry) };
  }
  return null;
};

function runStartupBackfill(
  ctx: AppContext,
  recorder: DeferredObjectivePlanHistoryRecorder,
): void {
  const watermark = readWatermark(ctx);
  if (watermark === null) {
    // First boot with this version (or the setting was lost). Seed the watermark to now so a
    // future crash/restart can back-fill from this moment forward — otherwise a deadline that
    // elapses during a PELS-off window before the first history flush would be lost. We
    // intentionally don't back-fill on this path: there's no prior observation window, and
    // inventing one (e.g. 30 days back) could fabricate "unknown" entries for objectives the
    // user only just configured.
    writeWatermark(ctx, Date.now());
    return;
  }
  const settings = normalizeDeferredObjectiveSettings(
    ctx.homey.settings.get(DEFERRED_OBJECTIVES_SETTINGS),
  );
  const configs = Object.entries(settings.objectivesByDeviceId)
    .map(([deviceId, entry]) => toBackfillConfig(deviceId, entry))
    .filter((c): c is DeferredObjectiveBackfillConfig => c !== null);
  const nowMs = Date.now();
  if (configs.length === 0) {
    // No enabled objectives — advance the watermark anyway. We successfully scanned a window
    // that produced nothing, and on the next restart we don't need to re-scan it.
    // Caveat: a future "enable an objective" action can't retroactively recover deadlines
    // that elapsed inside this skipped window — that fidelity gap is acknowledged in
    // PR-description and would need per-objective enable timestamps to fix.
    writeWatermark(ctx, nowMs);
    return;
  }
  recorder.backfillFromConfig(configs, watermark, nowMs);
  if (recorder.isDirty()) {
    // Back-fill produced new entries — only advance the watermark if we actually persisted
    // them. A failed save keeps the entries in memory for a later retry; leaving the
    // watermark in place means the next startup re-runs the scan idempotently.
    if (!recorder.flushIfDirty()) return;
  }
  writeWatermark(ctx, nowMs);
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
    onRevisionWritten: (event) => ctx.deferredObjectivePlanRevisionBus.publish(event),
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

// How long the deferred-objective observation watermark can be stale before we advance it
// during normal observe ticks. Without this idle advance the watermark only moves forward
// when a deadline finalizes — so a user enabling a new objective during a long quiet period
// followed by a crash would cause startup back-fill to enumerate that objective's deadlines
// back to a far-stale watermark, fabricating "unknown" entries for periods when the objective
// wasn't yet enabled. Five minutes keeps watermark drift small without spamming settings I/O.
const WATERMARK_IDLE_REFRESH_MS = 5 * 60 * 1000;

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
    getDeferredObjectiveStatusBus: () => ctx.deferredObjectiveStatusBus,
    getDeferredObjectiveHoursRemainingBus: () => ctx.deferredObjectiveHoursRemainingBus,
    getDeferredObjectiveHoursRemainingTracker: () => ctx.deferredObjectiveHoursRemainingTracker,
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
  // Re-arm the hours-remaining crossing latch so a later re-enabled task with
  // the same deadline still fires its lead-time trigger rather than treating
  // the stale boundary as already crossed.
  ctx.deferredObjectiveHoursRemainingTracker?.forgetDevice(deviceId);
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

const BOOST_RECENT_DRAW_WINDOW_MS = 10 * 60 * 1000;

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
    ...(calibration ? { stepPowerCalibration: calibration } : {}),
    ...(hasRecentObservedDrawAtSelectedStep !== undefined
      ? { hasRecentObservedDrawAtSelectedStep }
      : {}),
  };
}

function buildStepPowerCalibrationView(
  ctx: AppContext,
  device: TargetDeviceSnapshot,
): Record<string, StepPowerCalibrationView> | undefined {
  const profile = device.steppedLoadProfile;
  if (profile && Array.isArray(profile.steps) && profile.steps.length > 0) {
    return buildSteppedCalibrationView(ctx, device, profile.steps);
  }
  // EV chargers ship a single useful "charge" step rather than a stepped
  // profile. The deferred-objective planner (`resolveObjectiveSteps`) and
  // the hero planning-speed reading both go through
  // `resolveStepDeliveryUsefulKw`, so producing a synthetic 1-step view here
  // unifies the calibration path for both stepped and binary loads instead
  // of duplicating the lookup logic.
  if (device.deviceClass === 'evcharger') {
    return buildEvChargerCalibrationView(ctx, device);
  }
  return undefined;
}

function buildSteppedCalibrationView(
  ctx: AppContext,
  device: TargetDeviceSnapshot,
  steps: NonNullable<TargetDeviceSnapshot['steppedLoadProfile']>['steps'],
): Record<string, StepPowerCalibrationView> | undefined {
  const snapshot = ctx.getPowerCalibrationSnapshot();
  const deviceEntry = snapshot.devices[device.id];
  if (!deviceEntry) return undefined;
  const entries = steps.flatMap((step): Array<[string, StepPowerCalibrationView]> => {
    if (!step || typeof step.id !== 'string') return [];
    if (step.planningPowerW <= 0) return [];
    if (!deviceEntry.steps[step.id]) return [];
    const nameplateKw = step.planningPowerW / 1000;
    return [[step.id, {
      admissionPowerKw: getAdmissionPowerKw(snapshot, device.id, step.id, nameplateKw),
      deliveryPowerKw: getDeliveryPowerKw(snapshot, device.id, step.id, nameplateKw),
    }]];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function buildEvChargerCalibrationView(
  ctx: AppContext,
  device: TargetDeviceSnapshot,
): Record<string, StepPowerCalibrationView> | undefined {
  const nameplateKw = firstPositiveFinite([
    device.planningPowerKw,
    device.expectedPowerKw,
    device.powerKw,
  ]);
  if (nameplateKw === null) return undefined;
  const snapshot = ctx.getPowerCalibrationSnapshot();
  const stepId = 'charge';
  // Even when no calibration entries exist yet we expose the nameplate
  // values so the hero planning-speed reading has a useful default. The
  // calibration accessors fall back to nameplate when no confident sample
  // exists, so this stays consistent with stepped devices.
  return {
    [stepId]: {
      admissionPowerKw: getAdmissionPowerKw(snapshot, device.id, stepId, nameplateKw),
      deliveryPowerKw: getDeliveryPowerKw(snapshot, device.id, stepId, nameplateKw),
    },
  };
}

function resolveHasRecentObservedDrawAtSelectedStep(
  ctx: AppContext,
  device: TargetDeviceSnapshot,
): boolean | undefined {
  // Use the observed step (reportedStepId) only. Falling back to
  // `selectedStepId` would convert "no observation yet" into a concrete
  // `false` for a step the device may never have visited, blocking boost
  // escalation during the warmup window — the gate's contract treats
  // `undefined` as "no calibration opinion, keep the legacy bypass."
  const stepId = device.reportedStepId;
  if (typeof stepId !== 'string' || stepId.length === 0) return undefined;
  const snapshot = ctx.getPowerCalibrationSnapshot();
  const planningPowerW = device.steppedLoadProfile?.steps.find((step) => step.id === stepId)?.planningPowerW;
  const nameplateKw = isFiniteNumber(planningPowerW) && planningPowerW > 0
    ? planningPowerW / 1000
    : undefined;
  // Warm-up samples (below the confidence threshold) must not produce a
  // concrete `false` — the gate would treat that as authoritative and
  // suppress boost escalation for newly-paired devices.
  if (!isStepCalibrationConfident(snapshot, device.id, stepId, nameplateKw)) return undefined;
  // Use the AppContext clock so the planner can be tested deterministically
  // and so this stays consistent with other plan-input enrichment helpers
  // (per state-management/AGENTS.md "use a single clock per cycle").
  return hasRecentDrawAt({
    snapshot,
    deviceId: device.id,
    stepId,
    windowMs: BOOST_RECENT_DRAW_WINDOW_MS,
    nowMs: ctx.getNow().getTime(),
    nameplateKw,
  });
}
