/* eslint-disable max-lines -- plan service keeps rebuild/reconcile sequencing in one place. */
import { randomUUID } from 'node:crypto';
import type Homey from 'homey';
import { PriceLevel } from '../price/priceLevels';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import { startRuntimeSpan } from '../utils/runtimeTrace';
import {
  buildDeviceOverviewTransitionSignature,
  formatDeviceOverview,
  getDeviceOverviewExpectedPowerKw,
} from '../../packages/shared-domain/src/deviceOverview';
import {
  buildPlanChangeLines,
  buildPlanCapacityStateSummary,
  buildPlanDebugSummaryEvent,
  buildPlanDebugSummarySignatureFromEvent,
  buildPlanDetailSignature,
  buildPlanSignature,
} from './planLogging';
import {
  createPlanRebuildOutcome,
  hasShedding,
} from './planServiceInternals';
import { recordPlanRebuildTrace } from '../utils/planRebuildTrace';
import { normalizeError } from '../utils/errorUtils';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import { withRebuildContext } from '../logging/logger';
import { normalizePlanMeta } from './planStatusHelpers';
import { PlanStatusWriter } from './planStatusWriter';
import { PlanSnapshotWriter } from './planSnapshotWriter';
import {
  buildLiveStatePlan,
  canRefreshPlanSnapshotFromLiveState,
  hasPlanExecutionDriftAgainstIntent,
} from './planReconcileState';
import type {
  PlanRebuildIntent,
  PlanRebuildSchedulerLike,
  PlanRebuildSchedulerState,
} from './planRebuildSchedulerContract';
import type { PlanEngine } from './planEngine';
import type {
  DevicePlan,
  PendingTargetObservationSource,
  PlanChangeSet,
  PlanRebuildOutcome,
  PlanInputDevice,
  StatusPlanChanges,
} from './planTypes';
import type { HeadroomCardDeviceLike, HeadroomForDeviceDecision } from './planHeadroomDevice';
import type { PlanActuationMode, PlanActuationResult } from './planExecutor';

const SLOW_PLAN_REBUILD_LOG_THRESHOLD_MS = 1500;

function resolveOverviewTargetStepId(device: DevicePlan['devices'][number]): string | null {
  return device.targetStepId ?? device.desiredStepId ?? null;
}

function buildOverviewSignatureForDevice(
  device: DevicePlan['devices'][number],
  overview: ReturnType<typeof formatDeviceOverview>,
): string {
  return buildDeviceOverviewTransitionSignature({
    powerMsg: overview.powerMsg,
    stateMsg: overview.stateMsg,
    reason: device.reason,
    reportedStepId: device.reportedStepId,
    targetStepId: resolveOverviewTargetStepId(device) ?? undefined,
    inferredStepId: device.inferredStepId,
  });
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
    currentState: device.currentState,
    plannedState: device.plannedState,
    reason: device.reason ?? null,
    measuredPowerKw: device.measuredPowerKw ?? null,
    expectedPowerKw: getDeviceOverviewExpectedPowerKw(device) ?? null,
    reportedStepId: device.reportedStepId ?? null,
    targetStepId: resolveOverviewTargetStepId(device),
    inferredStepId: device.inferredStepId ?? null,
    stepSource: device.stepSource ?? null,
    desiredStepId: device.desiredStepId ?? null,
  };
}

const createPlanSnapshotFallbackScheduler = (deps: {
  getNowMs: () => number;
  resolveDueAtMs: (state: PlanRebuildSchedulerState) => number;
  executeSnapshot: (nowMs: number) => void;
}): PlanRebuildSchedulerLike => {
  let activeIntent: PlanRebuildIntent | null = null;
  let pendingIntent: PlanRebuildIntent | null = null;
  let pendingDueMs: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lastCompletedAtMsByKind: PlanRebuildSchedulerState['lastCompletedAtMsByKind'] = {};

  const clearTimer = (): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const buildState = (nowMs: number): PlanRebuildSchedulerState => ({
    nowMs,
    activeIntent,
    pendingIntent,
    pendingDueMs,
    hasTimer: timer !== undefined,
    lastCompletedAtMsByKind: { ...lastCompletedAtMsByKind },
  });

  const dispatchPendingIntent = (): void => {
    if (!pendingIntent || activeIntent) return;
    const nowMs = deps.getNowMs();
    const dueMs = deps.resolveDueAtMs(buildState(nowMs));
    pendingDueMs = dueMs;
    if (!Number.isFinite(dueMs)) {
      pendingIntent = null;
      pendingDueMs = null;
      return;
    }
    if (Number.isFinite(dueMs) && dueMs > nowMs) {
      timer = setTimeout(() => {
        timer = undefined;
        dispatchPendingIntent();
      }, Math.max(0, dueMs - nowMs));
      return;
    }
    pendingIntent = null;
    pendingDueMs = null;
    activeIntent = { kind: 'snapshot', reason: 'meta_only' };
    deps.executeSnapshot(nowMs);
    lastCompletedAtMsByKind.snapshot = deps.getNowMs();
    activeIntent = null;
  };

  const refreshPendingSchedule = (): void => {
    if (!pendingIntent || activeIntent) {
      clearTimer();
      return;
    }
    const nowMs = deps.getNowMs();
    const dueMs = deps.resolveDueAtMs(buildState(nowMs));
    pendingDueMs = dueMs;
    if (!Number.isFinite(dueMs)) {
      clearTimer();
      return;
    }
    if (dueMs <= nowMs) {
      clearTimer();
      dispatchPendingIntent();
      return;
    }
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      dispatchPendingIntent();
    }, Math.max(0, dueMs - nowMs));
  };

  return {
    request(intent): void {
      if (intent.kind !== 'snapshot') return;
      pendingIntent = intent;
      refreshPendingSchedule();
    },
    cancelAll(): void {
      clearTimer();
      pendingIntent = null;
      pendingDueMs = null;
    },
    now(): PlanRebuildSchedulerState {
      return buildState(deps.getNowMs());
    },
  };
};

const buildPlanHeadroomLogFields = (plan: DevicePlan | null): Record<string, number | boolean | null> => {
  const meta = plan?.meta;
  if (!meta) return {};
  const softHeadroomKw = typeof meta.headroomKw === 'number' ? meta.headroomKw : null;
  const hardCapHeadroomKw = typeof meta.hardCapHeadroomKw === 'number' ? meta.hardCapHeadroomKw : null;
  const shortfallBudgetHeadroomKw = typeof meta.shortfallBudgetHeadroomKw === 'number'
    ? meta.shortfallBudgetHeadroomKw
    : null;
  return {
    totalKw: typeof meta.totalKw === 'number' ? meta.totalKw : null,
    softLimitKw: typeof meta.softLimitKw === 'number' ? meta.softLimitKw : null,
    softHeadroomKw,
    shortfallBudgetThresholdKw: typeof meta.shortfallBudgetThresholdKw === 'number'
      ? meta.shortfallBudgetThresholdKw
      : null,
    shortfallBudgetHeadroomKw,
    hardCapHeadroomKw,
    hardCapBreached: hardCapHeadroomKw !== null ? hardCapHeadroomKw < 0 : false,
    capacityShortfall: meta.capacityShortfall === true,
  };
};

export type PlanServiceDeps = {
  homey: Homey.App['homey'];
  planEngine: PlanEngine;
  getPlanDevices: () => PlanInputDevice[];
  getCapacityDryRun: () => boolean;
  isCurrentHourCheap: () => boolean;
  isCurrentHourExpensive: () => boolean;
  getCombinedPrices: () => unknown;
  getLastPowerUpdate: () => number | null;
  scheduler?: PlanRebuildSchedulerLike;
  schedulePostActuationRefresh?: () => void;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
  overviewDebugStructured?: StructuredDebugEmitter;
  isOverviewDebugEnabled?: () => boolean;
  isPlanDebugEnabled?: () => boolean;
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
  private planSnapshotWriter: PlanSnapshotWriter;
  private readonly scheduler: PlanRebuildSchedulerLike;
  private readonly ownsScheduler: boolean;

  constructor(private deps: PlanServiceDeps) {
    let snapshotWriterForScheduler: PlanSnapshotWriter | null = null;
    this.ownsScheduler = !deps.scheduler;
    this.scheduler = deps.scheduler ?? createPlanSnapshotFallbackScheduler({
      getNowMs: () => Date.now(),
      resolveDueAtMs: (state) => (
        snapshotWriterForScheduler?.getPendingSnapshotDueMs({
          nowMs: state.nowMs,
          activeIntent: state.activeIntent,
        }) ?? Number.POSITIVE_INFINITY
      ),
      executeSnapshot: (nowMs) => {
        snapshotWriterForScheduler?.flushPendingNonActionSnapshotFromScheduler(nowMs);
      },
    });
    this.planStatusWriter = new PlanStatusWriter({
      homey: deps.homey,
      getCombinedPrices: deps.getCombinedPrices,
      isCurrentHourCheap: deps.isCurrentHourCheap,
      isCurrentHourExpensive: deps.isCurrentHourExpensive,
      getLastPowerUpdate: deps.getLastPowerUpdate,
      error: deps.error,
    });
    this.planSnapshotWriter = new PlanSnapshotWriter({
      homey: deps.homey,
      error: deps.error,
      getNowMs: () => this.scheduler.now().nowMs,
      scheduler: this.scheduler,
      structuredLog: deps.structuredLog,
      debugStructured: deps.debugStructured,
    });
    snapshotWriterForScheduler = this.planSnapshotWriter;
  }

  buildDevicePlanSnapshot(devices: PlanInputDevice[]): Promise<DevicePlan> {
    return this.deps.planEngine.buildDevicePlanSnapshot(devices);
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

  getLatestPlanSnapshotUpdatedAtMs(): number | null {
    return this.latestPlanSnapshotUpdatedAtMs;
  }

  getLatestReconcilePlanSnapshot(): DevicePlan | null {
    return this.latestReconcilePlanSnapshot ?? this.latestPlanSnapshot;
  }

  async syncLivePlanState(source: PendingTargetObservationSource): Promise<boolean> {
    return this.enqueuePlanOperation(
      () => Promise.resolve(this.syncLivePlanStateInline(source)),
      'Failed to sync live plan state',
      false,
    );
  }

  // eslint-disable-next-line complexity
  syncLivePlanStateInline(source: PendingTargetObservationSource): boolean {
    const hasPendingTargetCommands = this.deps.planEngine.hasPendingTargetCommands?.() ?? false;
    const hasPendingBinaryCommands = this.deps.planEngine.hasPendingBinaryCommands?.() ?? false;
    if (!hasPendingTargetCommands && !hasPendingBinaryCommands) {
      return false;
    }

    const liveDevices = this.deps.getPlanDevices();
    const pendingTargetChanged = hasPendingTargetCommands
      ? (this.deps.planEngine.syncPendingTargetCommands?.(liveDevices, source) ?? false)
      : false;
    const pendingBinaryChanged = hasPendingBinaryCommands
      ? (this.deps.planEngine.syncPendingBinaryCommands?.(liveDevices, source) ?? false)
      : false;
    const pendingChanged = pendingTargetChanged || pendingBinaryChanged;
    if (!this.latestPlanSnapshot) {
      return pendingChanged;
    }

    const livePlan = this.decoratePlanWithPendingTargetCommands(
      buildLiveStatePlan(this.latestPlanSnapshot, liveDevices),
    );
    if (canRefreshPlanSnapshotFromLiveState(this.latestPlanSnapshot, livePlan)) {
      this.latestPlanSnapshot = livePlan;
      this.latestPlanSnapshotUpdatedAtMs = Date.now();
      this.latestReconcilePlanSnapshot = livePlan;
      this.emitPlanUpdated(livePlan);
      return true;
    }

    if (!pendingChanged) {
      return false;
    }

    const nextPlan = this.decoratePlanWithPendingTargetCommands(this.latestPlanSnapshot);
    if (buildPlanDetailSignature(nextPlan) === buildPlanDetailSignature(this.latestPlanSnapshot)) {
      return false;
    }
    this.latestPlanSnapshot = nextPlan;
    this.latestPlanSnapshotUpdatedAtMs = Date.now();
    this.emitPlanUpdated(nextPlan);
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
  }): boolean {
    return this.deps.planEngine.syncHeadroomCardState(params);
  }

  syncHeadroomCardTrackedUsage(params: {
    deviceId: string;
    trackedKw: number;
  }): boolean {
    return this.deps.planEngine.syncHeadroomCardTrackedUsage(params);
  }

  async rebuildPlanFromCache(reason = 'unspecified'): Promise<PlanRebuildOutcome> {
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
        this.deps.error(errorMessage, normalizeError(error));
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

    const driftedLivePlan = buildLiveStatePlan(plannedSnapshot, liveDevices);
    this.deps.logDebug('Realtime device drift detected, reapplying current plan');
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
      try {
        const lines = buildPlanChangeLines(plan);
        if (lines.length) {
          this.deps.logDebug(`Plan updated (${lines.length} devices):\n- ${lines.join('\n- ')}`);
        }
      } catch (err) {
        this.deps.error('Plan updated (logging failed)', normalizeError(err));
      }
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
      this.deps.debugStructured?.(debugSummaryState.event);
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
      && Boolean(this.deps.debugStructured)
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

  private updatePlanSnapshot(plan: DevicePlan, changes: PlanChangeSet): number {
    const changed = changes.actionChanged || changes.detailChanged || changes.metaChanged;
    const writeMs = this.planSnapshotWriter.update(plan, changes);
    if (changed) {
      this.emitPlanUpdated(plan);
    }
    return writeMs;
  }

  private emitPlanUpdated(plan: DevicePlan): void {
    this.emitOverviewTransitions(plan);
    const api = this.deps.homey.api as { realtime?: (event: string, data: unknown) => Promise<unknown> } | undefined;
    const realtime = api?.realtime;
    if (typeof realtime === 'function') {
      realtime.call(api, 'plan_updated', plan)
        .catch((err: unknown) => this.deps.error('Failed to emit plan_updated event', normalizeError(err)));
    }
  }

  private emitOverviewTransitions(plan: DevicePlan): void {
    if (!(this.deps.isOverviewDebugEnabled?.() ?? false) || !this.deps.overviewDebugStructured) {
      return;
    }
    const nextDeviceIds = new Set<string>();
    for (const device of plan.devices) {
      nextDeviceIds.add(device.id);
      const overview = formatDeviceOverview(device);
      const signature = buildOverviewSignatureForDevice(device, overview);
      const previousSignature = this.lastOverviewSignatureByDeviceId.get(device.id);
      this.lastOverviewSignatureByDeviceId.set(device.id, signature);
      if (signature === previousSignature) continue;
      this.deps.overviewDebugStructured(buildOverviewEventForDevice(device, overview));
    }

    for (const deviceId of this.lastOverviewSignatureByDeviceId.keys()) {
      if (!nextDeviceIds.has(deviceId)) {
        this.lastOverviewSignatureByDeviceId.delete(deviceId);
      }
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
        this.recordPlanRebuildMetrics(reason, queueWaitMs, queueDepth, rebuildStart, outcome);
        stopSpan();
        const rebuildLogLevel = getPlanRebuildLogLevel(reason, durationMs, outcome);
        if (rebuildLogLevel) {
          this.deps.structuredLog?.[rebuildLogLevel]({
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
    this.latestPlanSnapshot = plan;
    this.latestPlanSnapshotUpdatedAtMs = Date.now();
    const { changes, changeMs } = this.measurePlanChanges(plan);
    const { snapshotMs, snapshotWriteMs } = this.measureSnapshotUpdate(plan, changes);
    const { statusMs, statusWriteMs } = this.measureStatusUpdate(plan, changes);
    const hadShedding = hasShedding(plan);

    if (isDryRun && hadShedding) {
      this.deps.log('Dry run: shedding planned but not executed');
    }

    const { applyMs, appliedActions, deviceWriteCount } = await this.maybeApplyPlanChanges(plan, changes, isDryRun);
    if (changes.actionChanged || !this.latestReconcilePlanSnapshot) {
      this.latestReconcilePlanSnapshot = this.latestPlanSnapshot ?? plan;
    }
    Object.assign(outcome, {
      buildMs,
      changeMs,
      snapshotMs,
      snapshotWriteMs,
      statusMs,
      statusWriteMs,
      applyMs,
      actionChanged: changes.actionChanged,
      detailChanged: changes.detailChanged,
      metaChanged: changes.metaChanged,
      appliedActions,
      deviceWriteCount,
      hadShedding,
    });
  }

  private async buildPlanForRebuild(reason: string): Promise<{ plan: DevicePlan; buildMs: number }> {
    const liveDevices = this.deps.getPlanDevices() ?? [];
    this.deps.planEngine.syncPendingTargetCommands?.(liveDevices, 'rebuild');
    this.deps.planEngine.syncPendingBinaryCommands?.(liveDevices, 'rebuild');
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
    this.deps.planEngine.prunePendingTargetCommands?.(plan);
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
    snapshotWriteMs: number;
  } {
    const snapshotStart = Date.now();
    const snapshotWriteMs = this.updatePlanSnapshot(plan, changes);
    return {
      snapshotMs: Date.now() - snapshotStart,
      snapshotWriteMs,
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
  ): Promise<{ applyMs: number; appliedActions: boolean; deviceWriteCount: number }> {
    const shouldApplyStablePlanActions = this.deps.planEngine.shouldApplyStablePlanActions?.(plan) ?? false;
    if (isDryRun || (!changes.actionChanged && !shouldApplyStablePlanActions)) {
      return { applyMs: 0, appliedActions: false, deviceWriteCount: 0 };
    }

    const applyStart = Date.now();
    let appliedActions = false;
    let deviceWriteCount = 0;
    try {
      const actuation = await this.applyPlanActions(plan);
      const rawDeviceWriteCount = actuation?.deviceWriteCount;
      deviceWriteCount = Number.isFinite(rawDeviceWriteCount) ? Math.max(0, Math.trunc(rawDeviceWriteCount)) : 0;
      appliedActions = deviceWriteCount > 0;
      if (appliedActions) {
        this.deps.schedulePostActuationRefresh?.();
      }
      const refreshed = this.refreshLatestPlanSnapshotFromSettledLiveState(plan);
      if (!refreshed) {
        this.refreshLatestPlanSnapshotPendingState();
      }
    } catch (error) {
      this.deps.error('Failed to apply plan actions', normalizeError(error));
    }
    return {
      applyMs: Date.now() - applyStart,
      appliedActions,
      deviceWriteCount,
    };
  }

  private recordPlanRebuildMetrics(
    reason: string,
    queueWaitMs: number,
    queueDepth: number,
    rebuildStart: number,
    outcome: PlanRebuildOutcome,
  ): void {
    const totalMs = Date.now() - rebuildStart;
    addPerfDuration('plan_rebuild_ms', totalMs);
    addPerfDuration('plan_rebuild_build_ms', outcome.buildMs);
    addPerfDuration('plan_rebuild_change_ms', outcome.changeMs);
    addPerfDuration('plan_rebuild_snapshot_ms', outcome.snapshotMs);
    addPerfDuration('plan_rebuild_snapshot_write_ms', outcome.snapshotWriteMs);
    addPerfDuration('plan_rebuild_status_ms', outcome.statusMs);
    addPerfDuration('plan_rebuild_status_write_ms', outcome.statusWriteMs);
    addPerfDuration('plan_rebuild_apply_ms', outcome.applyMs);
    incPerfCounter('plan_rebuild_total');
    recordPlanRebuildTrace({
      reason,
      queueDepth,
      queueWaitMs,
      buildMs: outcome.buildMs,
      changeMs: outcome.changeMs,
      snapshotMs: outcome.snapshotMs,
      snapshotWriteMs: outcome.snapshotWriteMs,
      statusMs: outcome.statusMs,
      statusWriteMs: outcome.statusWriteMs,
      applyMs: outcome.applyMs,
      totalMs,
      actionChanged: outcome.actionChanged,
      detailChanged: outcome.detailChanged,
      metaChanged: outcome.metaChanged,
      isDryRun: outcome.isDryRun,
      appliedActions: outcome.appliedActions,
      deviceWriteCount: outcome.deviceWriteCount,
      hadShedding: outcome.hadShedding,
      failed: outcome.failed,
    });
  }

  updatePelsStatus(plan: DevicePlan, changes?: StatusPlanChanges): number {
    return this.planStatusWriter.update(plan, changes);
  }

  private refreshLatestPlanSnapshotFromSettledLiveState(basePlan: DevicePlan): boolean {
    const livePlan = this.decoratePlanWithPendingTargetCommands(
      buildLiveStatePlan(basePlan, this.deps.getPlanDevices()),
    );
    if (!canRefreshPlanSnapshotFromLiveState(basePlan, livePlan)) return false;
    this.latestPlanSnapshot = livePlan;
    this.latestPlanSnapshotUpdatedAtMs = Date.now();
    this.latestReconcilePlanSnapshot = livePlan;
    this.emitPlanUpdated(livePlan);
    return true;
  }

  private refreshLatestPlanSnapshotPendingState(): boolean {
    if (!this.latestPlanSnapshot) return false;
    const nextPlan = this.decoratePlanWithPendingTargetCommands(this.latestPlanSnapshot);
    if (buildPlanDetailSignature(nextPlan) === buildPlanDetailSignature(this.latestPlanSnapshot)) {
      return false;
    }
    this.latestPlanSnapshot = nextPlan;
    this.latestPlanSnapshotUpdatedAtMs = Date.now();
    this.emitPlanUpdated(nextPlan);
    return true;
  }

  private decoratePlanWithPendingTargetCommands(plan: DevicePlan): DevicePlan {
    return this.deps.planEngine.decoratePlanWithPendingTargetCommands?.(plan) ?? plan;
  }

  destroy(): void {
    this.planSnapshotWriter.destroy();
    if (this.ownsScheduler) {
      this.scheduler.cancelAll('plan_service_destroy');
    }
  }

  getPendingSnapshotDueMs(params: {
    nowMs: number;
    activeIntent: PlanRebuildIntent | null;
  }): number {
    return this.planSnapshotWriter.getPendingSnapshotDueMs(params);
  }

  flushPendingNonActionSnapshotFromScheduler(nowMs: number): number {
    return this.planSnapshotWriter.flushPendingNonActionSnapshotFromScheduler(nowMs);
  }
}

function getPlanRebuildLogLevel(
  reason: string,
  durationMs: number,
  outcome: PlanRebuildOutcome,
): 'info' | 'debug' | null {
  if (outcome.failed) return 'info';
  if (outcome.appliedActions) return 'info';
  if (durationMs >= SLOW_PLAN_REBUILD_LOG_THRESHOLD_MS) return 'info';
  if (reason === 'initial' || reason === 'startup_snapshot_bootstrap' || reason.startsWith('settings:')) {
    return 'info';
  }
  // actionChanged-only: plan decisions changed but no commands were issued — plan debug topic
  if (outcome.actionChanged) return 'debug';
  return null;
}
