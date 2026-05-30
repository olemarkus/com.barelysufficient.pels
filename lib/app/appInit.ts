import { isDeviceObservationStale } from '../observer/observationFreshness';
import {
  resolveCanSetControl,
  resolveCommandableNow,
  type CommandableNowGraceEntry,
} from '../device/deviceActionProjection';
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
  clearObjectiveForDevice,
  migrateBlobToPerKeyIfNeeded,
  readAllObjectives,
  upsertObjectiveForDevice,
} from '../objectives/deferredObjectives';
import { LEARNED_THERMOSTAT_DEADBAND_C } from '../utils/settingsKeys';
import {
  getLearnedThermostatDeadbandC,
  normaliseLearnedThermostatDeadbandMap,
} from '../utils/learnedThermostatDeadbandStore';
import {
  buildDeferredObjectiveDeviceWriteDeps,
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
import { isRuntimePlannedDevice } from './appDeviceSupport';

export {
  buildDeferredObjectiveDeviceWriteDeps,
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
    getPlanDevices: () => {
      const snapshot = ctx.latestTargetSnapshot;
      evictMissingDeviceCacheEntries(ctx, snapshot);
      return snapshot
        .map((device) => toPlanDevice(ctx, device))
        // Shared planned-set predicate — the create-smart-task candidate list
        // and create-time validation use the SAME `isRuntimePlannedDevice` so a
        // `managed: false` device can never be offered/persisted but unplanned.
        .filter(isRuntimePlannedDevice);
    },
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
    getDeferredObjectiveSettings: () => {
      // Self-heal a boot-time empty-`getKeys()` flake that skipped the one-shot
      // migration: idempotent + marker-gated (a cheap single `get` once done), so
      // retrying on the plan cycle makes legacy objectives visible within seconds
      // instead of staying invisible (planner + UI) until the next app restart.
      migrateBlobToPerKeyIfNeeded(ctx.homey.settings);
      return readAllObjectives(ctx.homey.settings);
    },
    // Both writes route through the device-scoped ops over the hardened
    // settings-mutation primitive (see buildDeferredObjectiveDeviceWriteDeps),
    // so the Flow cards and the create-smart-task widget share one
    // read-modify-write + notify/flush/rebuild path.
    upsertDeferredObjectiveForDevice: (params) => upsertObjectiveForDevice(
      buildDeferredObjectiveDeviceWriteDeps(ctx, {
        nowMs: ctx.getNow().getTime(),
        rebuildReason: 'deadline_objective_card_set',
      }),
      params,
    ),
    clearDeferredObjectiveForDevice: (params) => clearObjectiveForDevice(
      buildDeferredObjectiveDeviceWriteDeps(ctx, {
        nowMs: ctx.getNow().getTime(),
        rebuildReason: 'deadline_objective_card_clear',
      }),
      params,
    ),
    getDeferredObjectiveStatusBus: () => ctx.deferredObjectiveStatusBus,
    getDeferredObjectivePlanRevisionBus: () => ctx.deferredObjectivePlanRevisionBus,
    getDeferredObjectiveEndedBus: () => ctx.deferredObjectiveEndedBus,
    getDeferredObjectiveHoursRemainingBus: () => ctx.deferredObjectiveHoursRemainingBus,
    getDeferredObjectiveHoursRemainingTracker: () => ctx.deferredObjectiveHoursRemainingTracker,
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
  const canSetControlResolved = resolveCanSetControl({
    controlCapabilityId: device.controlCapabilityId,
    capabilities: device.capabilities,
    canSetControl: device.canSetControl,
    canSetOnOff: (device as TargetDeviceSnapshot & { canSetOnOff?: boolean }).canSetOnOff,
  });
  const shedBehavior = ctx.getShedBehavior(device.id);
  const controllable = ctx.isCapacityControlEnabled(device.id);
  const residualKw = buildResidualKwForPlanDevice({
    device,
    hasBinaryControl,
    shedBehavior,
  });
  return {
    ...device,
    hasBinaryControl,
    observationStale: isDeviceObservationStale(device),
    managed: ctx.resolveManagedState(device.id),
    controllable,
    budgetExempt: ctx.isBudgetExempt(device.id),
    temperatureBoost: ctx.getTemperatureBoostConfig?.(device.id),
    evBoost: ctx.getEvBoostConfig?.(device.id),
    binaryCommandPending: pendingBinaryCommand !== null && pendingBinaryCommand !== undefined,
    binaryCommandPendingDesired: pendingBinaryCommand?.desired,
    commandableNow: commandable.commandableNow,
    commandableNowReason: commandable.reason,
    canSetControlResolved,
    residualKw,
    ...(calibration ? { stepPowerCalibration: calibration } : {}),
    ...(hasRecentObservedDrawAtSelectedStep !== undefined
      ? { hasRecentObservedDrawAtSelectedStep }
      : {}),
  };
}

/**
 * Project a snapshot device for the STRICTLY READ-ONLY plan-preview path.
 *
 * `toPlanDevice` is not a pure projection: on a confident commandable read it
 * calls `recordCommandableObservation` to re-anchor the device's abandon-grace
 * timestamp in `ctx.lastKnownCommandableByDevice`, so the next live plan cycle
 * keeps the grace window alive. A preview must NOT do that — a user opening a
 * preview repeatedly under flaky SDK reads would otherwise keep a
 * no-longer-commandable device's grace window alive across plan cycles,
 * violating the "never let abandon-grace go effectively infinite" invariant.
 *
 * Isolation: run `toPlanDevice` against a context whose
 * `lastKnownCommandableByDevice` getter returns a SHALLOW COPY of the live
 * record. Existing grace observations are still READ (so `commandableNow`
 * resolves identically to the live cycle — preview fidelity is preserved), but
 * the producer's write lands on the throwaway copy and is discarded. An audit
 * of `toPlanDevice` and its callees (`buildStepPowerCalibrationView`,
 * `resolveHasRecentObservedDrawAtSelectedStep`, `buildResidualKwForPlanDevice`,
 * `getPendingBinaryCommandForDevice`) found this grace-window write to be its
 * only mutation of live ctx/app state; everything else is a pure read, so
 * copying this one field fully isolates the preview.
 */
export function projectPreviewPlanDevice(ctx: AppContext, device: TargetDeviceSnapshot) {
  const lastKnownCommandableByDevice: Record<string, CommandableNowGraceEntry> = {
    ...ctx.lastKnownCommandableByDevice,
  };
  const previewCtx: AppContext = Object.create(ctx, {
    lastKnownCommandableByDevice: {
      get: () => lastKnownCommandableByDevice,
      enumerable: true,
    },
  }) as AppContext;
  return toPlanDevice(previewCtx, device);
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

/**
 * Drop entries from `map` whose keys aren't present in `presentIds`. Used to
 * keep producer-side per-device caches bounded: without eviction, removing a
 * device from Homey at runtime would leak the entry forever. Practical
 * impact is small (~50 bytes/entry, hundreds of devices across the app's
 * lifetime), but the unbounded growth was flagged in the chunk-2 producer
 * review and is straightforward to fix.
 *
 * Callers must pass the *full* snapshot's device IDs — a filtered/partial
 * list would delete entries for devices that still exist, defeating the
 * abandon-grace window.
 */
function evictMissingFromRecord<V>(
  map: Record<string, V>,
  presentIds: ReadonlySet<string>,
): void {
  for (const id of Object.keys(map)) {
    if (!presentIds.has(id)) {
      // eslint-disable-next-line functional/immutable-data, no-param-reassign
      delete map[id];
    }
  }
}

/**
 * Per-plan-cycle sweep: evict orphan entries from the producer-owned
 * per-device caches (`lastKnownCommandableByDevice`,
 * `lastKnownPowerKw`) whose device IDs are no longer present in the
 * latest snapshot. Pass the *full* snapshot here — not a filtered view —
 * otherwise active devices would lose their grace-window observations.
 *
 * Source: chunk-2 producer review flagged unbounded growth on device
 * deletion; this sweep closes that gap without changing any in-cycle
 * behaviour for devices that still exist.
 */
export function evictMissingDeviceCacheEntries(
  ctx: AppContext,
  snapshot: ReadonlyArray<TargetDeviceSnapshot>,
): void {
  const presentIds = new Set<string>(snapshot.map((device) => device.id));
  evictMissingFromRecord(ctx.lastKnownCommandableByDevice, presentIds);
  evictMissingFromRecord(ctx.lastKnownPowerKw, presentIds);
}
