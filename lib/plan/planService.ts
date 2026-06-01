/* eslint-disable max-lines -- plan service keeps rebuild/reconcile sequencing in one place. */
import { randomUUID } from 'node:crypto';
import type Homey from 'homey';
import { PriceLevel } from '../price/priceLevels';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import { recordOpRssDelta, safeRss } from '../utils/opRssTracker';
import { startRuntimeSpan } from '../utils/runtimeTrace';
import {
  buildDeviceOverviewTransitionSignature,
  formatDeviceOverview,
  getDeviceOverviewReportedStepId,
  getDeviceOverviewExpectedPowerKw,
} from '../../packages/shared-domain/src/deviceOverview';
import { formatDeviceReasonUserFacing } from '../../packages/shared-domain/src/planReasonSemantics';
import {
  resolvePlanStateKind,
  resolvePlanStateTone,
} from '../../packages/shared-domain/src/planStateLabels';
import {
  buildPlanCapacityStateSummary,
  buildPlanDebugSummaryEvent,
  buildPlanDebugSummarySignatureFromEvent,
  buildPlanDetailSignature,
  buildPlanSignature,
} from './planLogging';
import { hasShedding } from './planServiceInternals';
import {
  buildPlanHeadroomLogFields,
  createPlanRebuildOutcome,
  getPlanRebuildLogLevel,
  recordPlanRebuildMetrics,
} from './planRebuildMetrics';
import { normalizeError } from '../utils/errorUtils';
import { isFiniteNumber } from '../utils/appTypeGuards';
import type { Loggers, StructuredDebugEmitter } from '../logging/logger';
import { getLogger, withRebuildContext } from '../logging/logger';

const logger = getLogger('plan/service');
import type {
  SettingsUiPlanDeviceSnapshot,
  SettingsUiPlanSnapshot,
} from '../../packages/contracts/src/settingsUiApi';
import { normalizePlanMeta } from './planStatusHelpers';
import { buildSettingsOverviewReadModel } from './settingsOverviewReadModel';
import { createIdleClassifier, type IdleClassifier } from '../observer/idleClassifier';
import { PlanStatusWriter } from './planStatusWriter';
import {
  buildLiveStatePlan,
  canRefreshPlanSnapshotFromLiveState,
  hasPlanExecutionDriftAgainstIntent,
} from './planReconcileState';
import { resolvePowerSampleFreshness } from './planPowerFreshness';
import type { PlanEngine } from './planEngine';
import type {
  DevicePlan,
  PendingTargetObservationSource,
  PlanChangeSet,
  PlanRebuildOutcome,
  PlanInputDevice,
  StatusPlanChanges,
} from './planTypes';
import type {
  HeadroomCardDeviceLike,
  HeadroomForDeviceDecision,
  HeadroomUsageObservation,
} from './planHeadroomDevice';
import type { PlanActuationMode } from '../executor/executorTypes';
import type { PlanActuationResult } from '../executor/planExecutor';
import type { SnapshotWarmupGate } from './snapshotWarmupGate';

const serializePlanForUi = (
  plan: DevicePlan | null,
  deps: PlanServiceDeps,
  idleClassifier: IdleClassifier,
): SettingsUiPlanSnapshot | null => {
  return buildSettingsOverviewReadModel(plan, {
    getOverviewStarvation: (deviceId) => deps.deviceDiagnostics?.getOverviewStarvation?.(deviceId),
    getIdleClassification: (deviceId) => idleClassifier.getClassification(deviceId),
  });
};

function resolveOverviewTargetStepId(device: DevicePlan['devices'][number]): string | null {
  return device.targetStepId ?? device.desiredStepId ?? null;
}

function buildOverviewSignatureForDevice(
  device: DevicePlan['devices'][number],
): string {
  return buildDeviceOverviewTransitionSignature(device);
}

function buildOverviewEventForDevice(
  device: DevicePlan['devices'][number],
  overview: ReturnType<typeof formatDeviceOverview>,
): Record<string, unknown> {
  return {
    component: 'overview',
    event: 'device_overview_changed',
    deviceId: device.id,
    deviceName: device.name,
    powerMsg: overview.powerMsg,
    stateMsg: overview.stateMsg,
    usageMsg: overview.usageMsg,
    statusMsg: overview.statusMsg,
    stateKind: resolvePlanStateKind(device),
    stateTone: resolvePlanStateTone(device),
    currentState: device.currentState,
    plannedState: device.plannedState,
    reasonCode: device.reason.code,
    reasonText: formatDeviceReasonUserFacing(device.reason),
    measuredPowerKw: device.measuredPowerKw ?? null,
    expectedPowerKw: getDeviceOverviewExpectedPowerKw(device) ?? null,
    reportedStepId: getDeviceOverviewReportedStepId(device) ?? null,
    targetStepId: resolveOverviewTargetStepId(device),
    desiredStepId: device.desiredStepId ?? null,
  };
}

function buildOverviewBatchEvent(
  changedDevices: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    component: 'overview',
    event: 'device_overview_changes',
    changedDeviceCount: changedDevices.length,
    devices: changedDevices,
  };
}

export type PlanServiceDeps = {
  homey: Homey.App['homey'];
  planEngine: PlanEngine;
  getPlanDevices: () => PlanInputDevice[];
  getCapacityDryRun: () => boolean;
  isCurrentHourCheap: () => boolean;
  isCurrentHourExpensive: () => boolean;
  getCombinedPrices: () => unknown;
  getLastPowerUpdate: () => number | null;
  schedulePostActuationRefresh?: () => void;
  loggers?: Loggers;
  overviewDebugStructured?: StructuredDebugEmitter;
  isOverviewDebugEnabled?: () => boolean;
  isPlanDebugEnabled?: () => boolean;
  deviceDiagnostics?: {
    getOverviewStarvation?: (deviceId: string) => SettingsUiPlanDeviceSnapshot['starvation'] | null;
  };
  // Hold the first plan rebuild until the first device snapshot resolves (or
  // a bounded timeout expires). Without the gate, a price/settings/realtime
  // trigger that arrives between `initDeviceManager` and the first snapshot
  // refresh runs the planner against an empty snapshot and publishes a
  // one-cycle `deferred_objective_unknown reasonCode:objective_missing_device`
  // status, which fires a spurious `waiting → unachievable` flow trigger.
  snapshotWarmupGate?: SnapshotWarmupGate;
};

export class PlanService {
  private lastActionPlanSignature = '';
  private lastDetailPlanSignature = '';
  private lastPlanMetaSignature = '';
  private lastPlanDebugSummarySignature = '';
  private latestPlanSnapshot: DevicePlan | null = null;
  private latestPlanSnapshotUpdatedAtMs: number | null = null;
  private latestReconcilePlanSnapshot: DevicePlan | null = null;
  private lastOverviewSignatureByDeviceId = new Map<string, string>();
  private planOperationQueue: Promise<void> = Promise.resolve();
  private queuedRebuilds = 0;
  private currentBuildReason: string | null = null;
  private planStatusWriter: PlanStatusWriter;
  private idleClassifier: IdleClassifier;
  private lastTickedPlanRef: DevicePlan | null = null;

  constructor(private deps: PlanServiceDeps) {
    this.idleClassifier = createIdleClassifier({ structuredLog: deps.loggers?.structuredLog });
    this.planStatusWriter = new PlanStatusWriter({
      homey: deps.homey,
      getCombinedPrices: deps.getCombinedPrices,
      isCurrentHourCheap: deps.isCurrentHourCheap,
      isCurrentHourExpensive: deps.isCurrentHourExpensive,
      getLastPowerUpdate: deps.getLastPowerUpdate,
      structuredLog: deps.loggers?.structuredLog,
    });
  }

  buildDevicePlanSnapshot(devices: PlanInputDevice[]): Promise<DevicePlan> {
    return this.deps.planEngine.buildDevicePlanSnapshot(devices);
  }

  /**
   * The current live device inputs (snapshot projection). Exposed so the
   * clock-driven smart-task lifecycle emitter reads the same device source the
   * plan loop does, without re-implementing the projection.
   */
  getPlanDevices(): PlanInputDevice[] {
    return this.deps.getPlanDevices();
  }

  // Bridge from the observer-layer idle classifier into the plan layer.
  // Surfaced so the deferred-objective history recorder (lives in `lib/plan`,
  // wired in `appInit.ts`) can promote a smart task to `met` / `'stalled'`
  // when the device has settled near its setpoint. The classifier ticks
  // *after* plan emission (`tickIdleClassifier`), so on a given cycle the
  // recorder sees the state derived from the previous plan — that lag is
  // negligible against the 15-min `IDLE_UNRESPONSIVE_MIN_DURATION_MS`
  // window, but it does mean a fresh boot returns `undefined` until at
  // least one plan tick has run.
  getStallClassification(
    deviceId: string,
  ): 'near_target_idle' | 'unresponsive' | 'capped_idle' | undefined {
    return this.idleClassifier.getClassification(deviceId);
  }

  computeDynamicSoftLimit(): number {
    return this.deps.planEngine.computeDynamicSoftLimit();
  }

  computeShortfallThreshold(): number {
    return this.deps.planEngine.computeShortfallThreshold();
  }

  handleShortfall(deficitKw: number): Promise<void> {
    return this.deps.planEngine.handleShortfall(deficitKw);
  }

  handleShortfallCleared(): Promise<void> {
    return this.deps.planEngine.handleShortfallCleared();
  }

  getLastNotifiedPriceLevel(): PriceLevel {
    return this.planStatusWriter.getLastNotifiedPriceLevel();
  }

  getLatestPlanSnapshot(): DevicePlan | null {
    return this.latestPlanSnapshot;
  }

  getLatestPlanSnapshotForUi(): SettingsUiPlanSnapshot | null {
    return serializePlanForUi(this.latestPlanSnapshot, this.deps, this.idleClassifier);
  }

  serializePlanSnapshotForUi(plan: DevicePlan | null): SettingsUiPlanSnapshot | null {
    return serializePlanForUi(plan, this.deps, this.idleClassifier);
  }

  getLatestPlanSnapshotUpdatedAtMs(): number | null {
    return this.latestPlanSnapshotUpdatedAtMs;
  }

  getLatestReconcilePlanSnapshot(): DevicePlan | null {
    return this.latestReconcilePlanSnapshot ?? this.latestPlanSnapshot;
  }

  private stampPlanGeneratedAt(plan: DevicePlan, nowMs = Date.now()): DevicePlan {
    return {
      ...plan,
      generatedAtMs: nowMs,
    };
  }

  private preservePlanGeneratedAt(plan: DevicePlan, basePlan: DevicePlan): DevicePlan {
    return {
      ...plan,
      generatedAtMs: basePlan.generatedAtMs,
    };
  }

  private stampCurrentPowerFreshness(plan: DevicePlan): DevicePlan {
    const lastTimestamp = this.deps.getLastPowerUpdate();
    const freshness = resolvePowerSampleFreshness(
      typeof lastTimestamp === 'number' ? { lastTimestamp } : {},
    );
    return {
      ...plan,
      meta: {
        ...plan.meta,
        powerFreshnessState: freshness.powerFreshnessState,
      },
    };
  }

  async syncLivePlanState(source: PendingTargetObservationSource): Promise<boolean> {
    return this.enqueuePlanOperation(
      () => Promise.resolve(this.syncLivePlanStateInline(source)),
      'Failed to sync live plan state',
      false,
    );
  }

  syncLivePlanStateInline(source: PendingTargetObservationSource): boolean {
    const hasPendingTargetCommands = this.deps.planEngine.hasPendingTargetCommands();
    const hasPendingBinaryCommands = this.deps.planEngine.hasPendingBinaryCommands();
    if (!hasPendingTargetCommands && !hasPendingBinaryCommands) {
      return false;
    }

    const liveDevices = this.deps.getPlanDevices();
    const pendingTargetChanged = hasPendingTargetCommands
      ? this.deps.planEngine.syncPendingTargetCommands(liveDevices, source)
      : false;
    const pendingBinaryChanged = hasPendingBinaryCommands
      ? this.deps.planEngine.syncPendingBinaryCommands(liveDevices, source)
      : false;
    const pendingChanged = pendingTargetChanged || pendingBinaryChanged;
    if (!this.latestPlanSnapshot) {
      return pendingChanged;
    }

    const livePlan = this.decoratePlanWithPendingTargetCommands(
      buildLiveStatePlan(this.latestPlanSnapshot, liveDevices),
    );
    if (canRefreshPlanSnapshotFromLiveState(this.latestPlanSnapshot, livePlan)) {
      const refreshedPlan = this.preservePlanGeneratedAt(livePlan, this.latestPlanSnapshot);
      const nowMs = Date.now();
      this.latestPlanSnapshot = refreshedPlan;
      this.latestPlanSnapshotUpdatedAtMs = nowMs;
      this.latestReconcilePlanSnapshot = refreshedPlan;
      this.emitPlanUpdated(refreshedPlan);
      return true;
    }

    if (!pendingChanged) {
      return false;
    }

    const nextPlan = this.decoratePlanWithPendingTargetCommands(this.latestPlanSnapshot);
    if (buildPlanDetailSignature(nextPlan) === buildPlanDetailSignature(this.latestPlanSnapshot)) {
      return false;
    }
    const refreshedPlan = this.preservePlanGeneratedAt(nextPlan, this.latestPlanSnapshot);
    const nowMs = Date.now();
    this.latestPlanSnapshot = refreshedPlan;
    this.latestPlanSnapshotUpdatedAtMs = nowMs;
    this.emitPlanUpdated(refreshedPlan);
    return true;
  }

  async reconcileLatestPlanState(): Promise<boolean> {
    return this.enqueuePlanOperation(
      () => this.performPlanReconcile(),
      'Failed to reconcile latest plan state',
      false,
    );
  }

  applyPlanActions(plan: DevicePlan, mode: PlanActuationMode = 'plan'): Promise<PlanActuationResult> {
    return this.deps.planEngine.applyPlanActions(plan, mode);
  }

  applySheddingToDevice(deviceId: string, deviceName: string, reason?: string): Promise<void> {
    return this.enqueuePlanOperation(
      async () => {
        const wrote = await this.deps.planEngine.applySheddingToDevice(deviceId, deviceName, reason);
        if (wrote) {
          this.deps.schedulePostActuationRefresh?.();
        }
      },
      `Failed to apply shedding to ${deviceName}`,
      undefined,
    );
  }

  evaluateHeadroomForDevice(params: {
    devices: HeadroomCardDeviceLike[];
    deviceId: string;
    device?: HeadroomCardDeviceLike;
    headroom: number;
    requiredKw: number;
    cleanupMissingDevices?: boolean;
  }): HeadroomForDeviceDecision | null {
    return this.deps.planEngine.evaluateHeadroomForDevice(params);
  }

  syncHeadroomCardState(params: {
    devices: HeadroomCardDeviceLike[];
    cleanupMissingDevices?: boolean;
    reconciliationContext?: 'snapshot_refresh';
  }): boolean {
    return this.deps.planEngine.syncHeadroomCardState(params);
  }

  syncHeadroomUsageObservation(params: {
    deviceId: string;
    usageObservation: HeadroomUsageObservation;
    reconciliationContext?: 'snapshot_refresh';
  }): boolean {
    return this.deps.planEngine.syncHeadroomUsageObservation(params);
  }

  async rebuildPlanFromCache(reason = 'unspecified'): Promise<PlanRebuildOutcome> {
    // Hold the first rebuild until the warmup gate releases (snapshot ready
    // or bound elapsed). Awaiting here — before enqueuing — means the gate
    // does not block `enqueuePlanOperation` ordering and, once released,
    // subsequent rebuilds skip straight to the queue with no overhead.
    const gate = this.deps.snapshotWarmupGate;
    if (gate && !gate.isReleased()) {
      const waitStart = Date.now();
      await gate.wait();
      addPerfDuration('plan_rebuild_warmup_wait_ms', Date.now() - waitStart);
      incPerfCounter('plan_rebuild_warmup_waited_total');
    }
    const enqueuedAt = Date.now();
    this.queuedRebuilds += 1;
    const queueDepth = this.queuedRebuilds;
    incPerfCounter('plan_rebuild_enqueued_total');
    if (this.queuedRebuilds >= 2) {
      incPerfCounter('plan_rebuild_queue_depth_ge_2_total');
    }
    if (this.queuedRebuilds >= 4) {
      incPerfCounter('plan_rebuild_queue_depth_ge_4_total');
    }

    const fallbackOutcome = {
      ...createPlanRebuildOutcome(this.deps.getCapacityDryRun()),
      failed: true,
    };
    return this.enqueuePlanOperation(
      async () => {
        const waitMs = Date.now() - enqueuedAt;
        addPerfDuration('plan_rebuild_queue_wait_ms', waitMs);
        if (waitMs > 0) {
          incPerfCounter('plan_rebuild_queue_waited_total');
        }
        return this.performPlanRebuild({ reason, queueWaitMs: waitMs, queueDepth });
      },
      'Failed to rebuild plan',
      fallbackOutcome,
      () => {
        this.queuedRebuilds = Math.max(0, this.queuedRebuilds - 1);
      },
    );
  }

  private async enqueuePlanOperation<T>(
    operation: () => Promise<T>,
    errorMessage: string,
    fallbackValue: T,
    onFinally?: () => void,
  ): Promise<T> {
    let result = fallbackValue;
    this.planOperationQueue = this.planOperationQueue
      .then(async () => {
        result = await operation();
      })
      .catch((error) => {
        (this.deps.loggers?.structuredLog ?? logger).error({
          event: 'plan_operation_failed',
          message: errorMessage,
          error: normalizeError(error),
        });
      })
      .finally(() => {
        onFinally?.();
      });

    await this.planOperationQueue;
    return result;
  }

  private async performPlanReconcile(): Promise<boolean> {
    if (this.deps.getCapacityDryRun()) return false;
    const plannedSnapshot = this.getLatestReconcilePlanSnapshot();
    if (!plannedSnapshot) return false;

    const liveDevices = this.deps.getPlanDevices();
    if (!hasPlanExecutionDriftAgainstIntent(plannedSnapshot, liveDevices)) {
      return false;
    }

    const driftedLivePlan = this.stampCurrentPowerFreshness(
      buildLiveStatePlan(plannedSnapshot, liveDevices),
    );
    (this.deps.loggers?.debugStructured ?? ((p: Record<string, unknown>) => logger.debug(p)))({
      event: 'realtime_device_drift_detected',
      message: 'Reapplying current plan',
    });
    await this.applyPlanActions(driftedLivePlan, 'reconcile');
    this.deps.schedulePostActuationRefresh?.();
    return true;
  }

  private trackPlanChanges(plan: DevicePlan, metaSignature: string): PlanChangeSet {
    const actionSignature = buildPlanSignature(plan);
    const detailSignature = buildPlanDetailSignature(plan);
    const actionChanged = actionSignature !== this.lastActionPlanSignature;
    const detailChanged = detailSignature !== this.lastDetailPlanSignature;
    const metaChanged = metaSignature !== this.lastPlanMetaSignature;
    const debugSummaryState = this.resolveDebugSummaryState({
      plan,
      actionChanged,
      detailChanged,
      metaChanged,
    });

    if (actionChanged) {
      incPerfCounter('plan_rebuild_action_signature_changed_total');
    } else if (detailChanged || metaChanged) {
      incPerfCounter('plan_rebuild_reason_or_meta_only_changed_total');
      if (detailChanged) {
        incPerfCounter('plan_rebuild_reason_or_state_only_changed_total');
      }
      if (metaChanged) {
        incPerfCounter('plan_rebuild_meta_only_changed_total');
      }
    } else {
      incPerfCounter('plan_rebuild_no_change_total');
    }

    if (debugSummaryState.changed && debugSummaryState.event) {
      const emit = this.deps.loggers?.debugStructured ?? ((p: Record<string, unknown>) => logger.debug(p));
      emit(debugSummaryState.event);
    }

    this.lastActionPlanSignature = actionSignature;
    this.lastDetailPlanSignature = detailSignature;
    this.lastPlanMetaSignature = metaSignature;
    if (debugSummaryState.emitted && debugSummaryState.signature !== null) {
      this.lastPlanDebugSummarySignature = debugSummaryState.signature;
    }

    return {
      actionSignature,
      detailSignature,
      metaSignature,
      actionChanged,
      detailChanged,
      metaChanged,
    };
  }

  private resolveDebugSummaryState(params: {
    plan: DevicePlan;
    actionChanged: boolean;
    detailChanged: boolean;
    metaChanged: boolean;
  }): {
    event: ReturnType<typeof buildPlanDebugSummaryEvent> | null;
    signature: string | null;
    changed: boolean;
    emitted: boolean;
  } {
    const { plan, actionChanged, detailChanged, metaChanged } = params;
    const shouldCheck = (actionChanged || detailChanged || metaChanged)
      && Boolean(this.deps.loggers?.debugStructured)
      && (this.deps.isPlanDebugEnabled?.() ?? true);
    if (!shouldCheck) {
      return { event: null, signature: null, changed: false, emitted: false };
    }
    const event = buildPlanDebugSummaryEvent(plan);
    const signature = buildPlanDebugSummarySignatureFromEvent(event);
    return {
      event,
      signature,
      changed: signature !== this.lastPlanDebugSummarySignature,
      emitted: true,
    };
  }

  private updatePlanSnapshot(plan: DevicePlan, changes: PlanChangeSet): void {
    this.tickIdleClassifier(plan);
    const changed = changes.actionChanged || changes.detailChanged || changes.metaChanged;
    if (changed) {
      this.emitPlanUpdated(plan);
    } else {
      this.emitOverviewTransitions(plan);
    }
  }

  private tickIdleClassifier(plan: DevicePlan): void {
    if (this.lastTickedPlanRef === plan) return;
    this.lastTickedPlanRef = plan;
    this.idleClassifier.classifyAll(plan.devices, Date.now());
  }

  private emitPlanUpdated(plan: DevicePlan): void {
    this.tickIdleClassifier(plan);
    this.emitOverviewTransitions(plan);
    const api = this.deps.homey.api as { realtime?: (event: string, data: unknown) => Promise<unknown> } | undefined;
    const realtime = api?.realtime;
    if (typeof realtime === 'function') {
      realtime.call(api, 'plan_updated', serializePlanForUi(plan, this.deps, this.idleClassifier))
        .catch((err: unknown) => (this.deps.loggers?.structuredLog ?? logger).error({
          event: 'plan_updated_emit_failed',
          error: normalizeError(err),
        }));
    }
  }

  private emitOverviewTransitions(plan: DevicePlan): void {
    if (!(this.deps.isOverviewDebugEnabled?.() ?? false) || !this.deps.overviewDebugStructured) {
      return;
    }
    const nextDeviceIds = new Set<string>();
    const changedDevices: Record<string, unknown>[] = [];
    for (const device of plan.devices) {
      nextDeviceIds.add(device.id);
      const overview = formatDeviceOverview(device);
      const signature = buildOverviewSignatureForDevice(device);
      const previousSignature = this.lastOverviewSignatureByDeviceId.get(device.id);
      this.lastOverviewSignatureByDeviceId.set(device.id, signature);
      if (signature === previousSignature) continue;
      changedDevices.push(buildOverviewEventForDevice(device, overview));
    }

    for (const deviceId of this.lastOverviewSignatureByDeviceId.keys()) {
      if (!nextDeviceIds.has(deviceId)) {
        this.lastOverviewSignatureByDeviceId.delete(deviceId);
      }
    }

    if (changedDevices.length === 1) {
      this.deps.overviewDebugStructured(changedDevices[0]);
    } else if (changedDevices.length > 1) {
      this.deps.overviewDebugStructured(buildOverviewBatchEvent(changedDevices));
    }
  }

  private async performPlanRebuild(params: {
    reason: string;
    queueWaitMs: number;
    queueDepth: number;
  }): Promise<PlanRebuildOutcome> {
    const { reason, queueWaitMs, queueDepth } = params;
    const isDryRun = this.deps.getCapacityDryRun();
    const rebuildId = `rb_${randomUUID()}`;
    const rebuildStart = Date.now();
    const rssBefore = safeRss();
    const stopSpan = startRuntimeSpan(`plan_rebuild(${reason})`);
    const outcome = createPlanRebuildOutcome(isDryRun);

    const run = async (): Promise<void> => {
      try {
        await this.executePlanRebuild(reason, isDryRun, outcome);
      } catch (error) {
        outcome.failed = true;
        incPerfCounter('plan_rebuild_failed_total');
        throw error;
      } finally {
        const durationMs = Date.now() - rebuildStart;
        recordPlanRebuildMetrics({
          reason, queueWaitMs, queueDepth, rebuildStart, outcome,
        });
        recordOpRssDelta('plan_rebuild_ms', rssBefore, safeRss());
        stopSpan();
        const rebuildLogLevel = getPlanRebuildLogLevel(reason, durationMs, outcome);
        if (rebuildLogLevel) {
          (this.deps.loggers?.structuredLog ?? logger)[rebuildLogLevel]({
            event: 'plan_rebuild_completed',
            durationMs,
            buildMs: outcome.buildMs,
            snapshotMs: outcome.snapshotMs,
            statusMs: outcome.statusMs,
            applyMs: outcome.applyMs,
            reasonCode: reason,
            actionChanged: outcome.actionChanged,
            detailChanged: outcome.detailChanged,
            metaChanged: outcome.metaChanged,
            hadShedding: outcome.hadShedding,
            appliedActions: outcome.appliedActions,
            deviceWriteCount: outcome.deviceWriteCount,
            commandRequestCount: outcome.commandRequestCount,
            failed: outcome.failed,
            ...buildPlanHeadroomLogFields(this.latestPlanSnapshot),
            ...buildPlanCapacityStateSummary(this.latestPlanSnapshot, {
              summarySource: 'plan_snapshot',
              summarySourceAtMs: this.latestPlanSnapshotUpdatedAtMs,
            }),
          });
        }
      }
    };

    await withRebuildContext(rebuildId, run);
    return outcome;
  }

  private async executePlanRebuild(
    reason: string,
    isDryRun: boolean,
    outcome: PlanRebuildOutcome,
  ): Promise<void> {
    const { plan, buildMs } = await this.buildPlanForRebuild(reason);
    const nowMs = Date.now();
    const stampedPlan = this.stampPlanGeneratedAt(plan, nowMs);
    this.latestPlanSnapshot = stampedPlan;
    this.latestPlanSnapshotUpdatedAtMs = nowMs;
    const { changes, changeMs } = this.measurePlanChanges(stampedPlan);
    const { snapshotMs } = this.measureSnapshotUpdate(stampedPlan, changes);
    const { statusMs, statusWriteMs } = this.measureStatusUpdate(stampedPlan, changes);
    const hadShedding = hasShedding(stampedPlan);

    if (isDryRun && hadShedding) {
      (this.deps.loggers?.structuredLog ?? logger).info({
        event: 'shedding_dry_run_skipped',
        message: 'Dry run: shedding planned but not executed',
      });
    }

    const { applyMs, appliedActions, deviceWriteCount, commandRequestCount } = await this.maybeApplyPlanChanges(
      stampedPlan,
      changes,
      isDryRun,
    );
    if (changes.actionChanged || !this.latestReconcilePlanSnapshot) {
      this.latestReconcilePlanSnapshot = this.latestPlanSnapshot ?? stampedPlan;
    }
    Object.assign(outcome, {
      buildMs,
      changeMs,
      snapshotMs,
      statusMs,
      statusWriteMs,
      applyMs,
      actionChanged: changes.actionChanged,
      detailChanged: changes.detailChanged,
      metaChanged: changes.metaChanged,
      appliedActions,
      deviceWriteCount,
      commandRequestCount,
      hadShedding,
    });
  }

  private async buildPlanForRebuild(reason: string): Promise<{ plan: DevicePlan; buildMs: number }> {
    const liveDevices = this.deps.getPlanDevices();
    this.deps.planEngine.syncPendingTargetCommands(liveDevices, 'rebuild');
    this.deps.planEngine.syncPendingBinaryCommands(liveDevices, 'rebuild');
    const buildStart = Date.now();
    this.currentBuildReason = reason;
    if (this.deps.planEngine.state) {
      // Restore/target planning reads the active rebuild reason from shared plan state so
      // nested helpers do not need another plumbing parameter through the entire call stack.
      this.deps.planEngine.state.currentRebuildReason = this.currentBuildReason;
    }
    let plan: DevicePlan;
    try {
      plan = await this.buildDevicePlanSnapshot(liveDevices);
    } finally {
      this.currentBuildReason = null;
      if (this.deps.planEngine.state) {
        this.deps.planEngine.state.currentRebuildReason = null;
      }
    }
    this.deps.planEngine.prunePendingTargetCommands(plan);
    plan = this.decoratePlanWithPendingTargetCommands(plan);
    return {
      plan,
      buildMs: Date.now() - buildStart,
    };
  }

  private measurePlanChanges(plan: DevicePlan): {
    changes: PlanChangeSet;
    changeMs: number;
  } {
    const metaSignature = JSON.stringify(normalizePlanMeta(plan.meta));
    const changeStart = Date.now();
    const changes = this.trackPlanChanges(plan, metaSignature);
    return {
      changes,
      changeMs: Date.now() - changeStart,
    };
  }

  private measureSnapshotUpdate(
    plan: DevicePlan,
    changes: PlanChangeSet,
  ): {
    snapshotMs: number;
  } {
    const snapshotStart = Date.now();
    this.updatePlanSnapshot(plan, changes);
    return {
      snapshotMs: Date.now() - snapshotStart,
    };
  }

  private measureStatusUpdate(
    plan: DevicePlan,
    changes: PlanChangeSet,
  ): {
    statusMs: number;
    statusWriteMs: number;
  } {
    const statusStart = Date.now();
    const statusWriteMs = this.updatePelsStatus(plan, changes);
    return {
      statusMs: Date.now() - statusStart,
      statusWriteMs,
    };
  }

  private async maybeApplyPlanChanges(
    plan: DevicePlan,
    changes: PlanChangeSet,
    isDryRun: boolean,
  ): Promise<{ applyMs: number; appliedActions: boolean; deviceWriteCount: number; commandRequestCount: number }> {
    const shouldApplyStablePlanActions = this.deps.planEngine.shouldApplyStablePlanActions(plan);
    if (isDryRun || (!changes.actionChanged && !shouldApplyStablePlanActions)) {
      return { applyMs: 0, appliedActions: false, deviceWriteCount: 0, commandRequestCount: 0 };
    }

    const applyStart = Date.now();
    let appliedActions = false;
    let deviceWriteCount = 0;
    let commandRequestCount = 0;
    try {
      const actuation = await this.applyPlanActions(plan);
      const rawDeviceWriteCount = actuation?.deviceWriteCount;
      const rawCommandRequestCount = actuation?.commandRequestCount;
      deviceWriteCount = sanitizeActuationCount(rawDeviceWriteCount);
      commandRequestCount = sanitizeActuationCount(rawCommandRequestCount);
      appliedActions = deviceWriteCount > 0 || commandRequestCount > 0;
      if (appliedActions) {
        this.deps.schedulePostActuationRefresh?.();
      }
      const refreshed = this.refreshLatestPlanSnapshotFromSettledLiveState(plan);
      if (!refreshed) {
        this.refreshLatestPlanSnapshotPendingState();
      }
    } catch (error) {
      (this.deps.loggers?.structuredLog ?? logger).error({
        event: 'plan_actions_apply_failed',
        error: normalizeError(error),
      });
    }
    return {
      applyMs: Date.now() - applyStart,
      appliedActions,
      deviceWriteCount,
      commandRequestCount,
    };
  }

  updatePelsStatus(plan: DevicePlan, changes?: StatusPlanChanges): number {
    return this.planStatusWriter.update(plan, changes);
  }

  private refreshLatestPlanSnapshotFromSettledLiveState(basePlan: DevicePlan): boolean {
    const livePlan = this.decoratePlanWithPendingTargetCommands(
      buildLiveStatePlan(basePlan, this.deps.getPlanDevices()),
    );
    if (!canRefreshPlanSnapshotFromLiveState(basePlan, livePlan)) return false;
    const refreshedPlan = this.preservePlanGeneratedAt(livePlan, basePlan);
    const nowMs = Date.now();
    this.latestPlanSnapshot = refreshedPlan;
    this.latestPlanSnapshotUpdatedAtMs = nowMs;
    this.latestReconcilePlanSnapshot = refreshedPlan;
    this.emitPlanUpdated(refreshedPlan);
    return true;
  }

  private refreshLatestPlanSnapshotPendingState(): boolean {
    if (!this.latestPlanSnapshot) return false;
    const nextPlan = this.decoratePlanWithPendingTargetCommands(this.latestPlanSnapshot);
    if (buildPlanDetailSignature(nextPlan) === buildPlanDetailSignature(this.latestPlanSnapshot)) {
      return false;
    }
    const refreshedPlan = this.preservePlanGeneratedAt(nextPlan, this.latestPlanSnapshot);
    const nowMs = Date.now();
    this.latestPlanSnapshot = refreshedPlan;
    this.latestPlanSnapshotUpdatedAtMs = nowMs;
    this.emitPlanUpdated(refreshedPlan);
    return true;
  }

  private decoratePlanWithPendingTargetCommands(plan: DevicePlan): DevicePlan {
    return this.deps.planEngine.decoratePlanWithPendingTargetCommands(plan);
  }

}

function sanitizeActuationCount(value: unknown): number {
  return isFiniteNumber(value) ? Math.max(0, Math.trunc(value)) : 0;
}
