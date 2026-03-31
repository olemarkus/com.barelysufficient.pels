/* eslint-disable max-lines -- plan service keeps rebuild/reconcile sequencing in one place. */
import type Homey from 'homey';
import { PriceLevel } from '../price/priceLevels';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import { startRuntimeSpan } from '../utils/runtimeTrace';
import { DETAIL_SNAPSHOT_WRITE_THROTTLE_MS } from '../utils/timingConstants';
import {
  buildPlanChangeLines,
  buildPlanDetailSignature,
  buildPlanSignature,
} from './planLogging';
import {
  createPlanRebuildOutcome,
  hasShedding,
  type PlanChangeSet,
  type PlanRebuildOutcome,
  type PlanSnapshotWriteReason,
  type StatusPlanChanges,
} from './planServiceInternals';
import { recordPlanRebuildTrace } from '../utils/planRebuildTrace';
import { normalizeError } from '../utils/errorUtils';
import type { Logger as PinoLogger } from '../logging/logger';
import { withRebuildContext } from '../logging/logger';
import { normalizePlanMeta } from './planStatusHelpers';
import { PlanStatusWriter } from './planStatusWriter';
import {
  buildLiveStatePlan,
  canRefreshPlanSnapshotFromLiveState,
  hasPlanExecutionDriftAgainstIntent,
} from './planReconcileState';
import type { PlanEngine } from './planEngine';
import type { DevicePlan, PendingTargetObservationSource, PlanInputDevice } from './planTypes';
import type { HeadroomCardDeviceLike, HeadroomForDeviceDecision } from './planHeadroomDevice';
import type { PlanActuationMode } from './planExecutor';

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
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  structuredLog?: PinoLogger;
};

export class PlanService {
  private lastActionPlanSignature = '';
  private lastDetailPlanSignature = '';
  private lastPlanMetaSignature = '';
  private latestPlanSnapshot: DevicePlan | null = null;
  private latestReconcilePlanSnapshot: DevicePlan | null = null;
  private lastPlanSnapshotWriteMs = 0;
  private hasPendingNonActionSnapshot = false;
  private pendingNonActionSnapshotReason: Exclude<PlanSnapshotWriteReason, 'action_changed'> = 'meta_only';
  private pendingNonActionSnapshotPlan: DevicePlan | null = null;
  private pendingNonActionSnapshotTimer?: ReturnType<typeof setTimeout>;
  private planOperationQueue: Promise<void> = Promise.resolve();
  private queuedRebuilds = 0;
  private planStatusWriter: PlanStatusWriter;

  constructor(private deps: PlanServiceDeps) {
    this.planStatusWriter = new PlanStatusWriter({
      homey: deps.homey,
      getCombinedPrices: deps.getCombinedPrices,
      isCurrentHourCheap: deps.isCurrentHourCheap,
      isCurrentHourExpensive: deps.isCurrentHourExpensive,
      getLastPowerUpdate: deps.getLastPowerUpdate,
      error: deps.error,
    });
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

  applyPlanActions(plan: DevicePlan, mode: PlanActuationMode = 'plan'): Promise<void> {
    return this.deps.planEngine.applyPlanActions(plan, mode);
  }

  applySheddingToDevice(deviceId: string, deviceName?: string, reason?: string): Promise<void> {
    return this.enqueuePlanOperation(
      async () => {
        await this.deps.planEngine.applySheddingToDevice(deviceId, deviceName, reason);
        this.deps.schedulePostActuationRefresh?.();
      },
      `Failed to apply shedding to ${deviceName || deviceId}`,
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

  async rebuildPlanFromCache(reason = 'unspecified'): Promise<void> {
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

    await this.enqueuePlanOperation(
      async () => {
        const waitMs = Date.now() - enqueuedAt;
        addPerfDuration('plan_rebuild_queue_wait_ms', waitMs);
        if (waitMs > 0) {
          incPerfCounter('plan_rebuild_queue_waited_total');
        }
        await this.performPlanRebuild({ reason, queueWaitMs: waitMs, queueDepth });
      },
      'Failed to rebuild plan',
      undefined,
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

    this.lastActionPlanSignature = actionSignature;
    this.lastDetailPlanSignature = detailSignature;
    this.lastPlanMetaSignature = metaSignature;

    return {
      actionSignature,
      detailSignature,
      metaSignature,
      actionChanged,
      detailChanged,
      metaChanged,
    };
  }

  private updatePlanSnapshot(plan: DevicePlan, changes: PlanChangeSet): number {
    const now = Date.now();
    const changed = changes.actionChanged || changes.detailChanged || changes.metaChanged;
    if (!changed) {
      return this.flushPendingNonActionSnapshot(now);
    }

    if (changes.actionChanged) {
      const writeMs = this.writePlanSnapshot(plan, 'action_changed', now);
      this.clearPendingNonActionSnapshot();
      this.emitPlanUpdated(plan);
      return writeMs;
    }

    if (changes.detailChanged) {
      const writeMs = this.writePlanSnapshot(plan, 'detail_changed', now);
      this.clearPendingNonActionSnapshot();
      this.emitPlanUpdated(plan);
      return writeMs;
    }

    if (this.canWriteNonActionSnapshot(now)) {
      const writeMs = this.writePlanSnapshot(plan, 'meta_only', now);
      this.clearPendingNonActionSnapshot();
      this.emitPlanUpdated(plan);
      return writeMs;
    }

    this.schedulePendingNonActionSnapshot(plan, 'meta_only', now);
    incPerfCounter('settings_set.device_plan_snapshot_meta_write_throttled_total');
    this.emitPlanUpdated(plan);
    return 0;
  }

  private canWriteNonActionSnapshot(nowMs: number): boolean {
    if (this.lastPlanSnapshotWriteMs === 0) return true;
    return nowMs - this.lastPlanSnapshotWriteMs >= DETAIL_SNAPSHOT_WRITE_THROTTLE_MS;
  }

  private resolveNonActionWaitMs(nowMs: number): number {
    if (this.lastPlanSnapshotWriteMs === 0) return 0;
    const elapsedMs = nowMs - this.lastPlanSnapshotWriteMs;
    return Math.max(0, DETAIL_SNAPSHOT_WRITE_THROTTLE_MS - elapsedMs);
  }

  private schedulePendingNonActionSnapshot(
    plan: DevicePlan,
    reason: Exclude<PlanSnapshotWriteReason, 'action_changed'>,
    nowMs: number,
  ): void {
    this.hasPendingNonActionSnapshot = true;
    this.pendingNonActionSnapshotPlan = plan;
    this.pendingNonActionSnapshotReason = reason;
    if (this.pendingNonActionSnapshotTimer) return;

    const waitMs = this.resolveNonActionWaitMs(nowMs);
    this.pendingNonActionSnapshotTimer = setTimeout(() => {
      this.pendingNonActionSnapshotTimer = undefined;
      this.flushPendingNonActionSnapshot(Date.now());
    }, waitMs);
  }

  private flushPendingNonActionSnapshot(nowMs: number): number {
    if (!this.hasPendingNonActionSnapshot || !this.pendingNonActionSnapshotPlan) return 0;
    if (!this.canWriteNonActionSnapshot(nowMs)) {
      this.schedulePendingNonActionSnapshot(
        this.pendingNonActionSnapshotPlan,
        this.pendingNonActionSnapshotReason,
        nowMs,
      );
      return 0;
    }

    const writeMs = this.writePlanSnapshot(
      this.pendingNonActionSnapshotPlan,
      this.pendingNonActionSnapshotReason,
      nowMs,
    );
    this.clearPendingNonActionSnapshot();
    incPerfCounter('settings_set.device_plan_snapshot_meta_write_flushed_total');
    return writeMs;
  }

  private clearPendingNonActionSnapshot(): void {
    if (this.pendingNonActionSnapshotTimer) {
      clearTimeout(this.pendingNonActionSnapshotTimer);
      this.pendingNonActionSnapshotTimer = undefined;
    }
    this.hasPendingNonActionSnapshot = false;
    this.pendingNonActionSnapshotPlan = null;
    this.pendingNonActionSnapshotReason = 'meta_only';
  }

  private writePlanSnapshot(plan: DevicePlan, reason: PlanSnapshotWriteReason, nowMs: number): number {
    const writeStart = Date.now();
    this.deps.homey.settings.set('device_plan_snapshot', plan);
    this.lastPlanSnapshotWriteMs = nowMs;
    const writeMs = Date.now() - writeStart;
    addPerfDuration('settings_write_ms', writeMs);
    incPerfCounter('settings_set.device_plan_snapshot');
    incPerfCounter(`settings_set.device_plan_snapshot_reason.${reason}_total`);
    return writeMs;
  }

  private emitPlanUpdated(plan: DevicePlan): void {
    const api = this.deps.homey.api as { realtime?: (event: string, data: unknown) => Promise<unknown> } | undefined;
    const realtime = api?.realtime;
    if (typeof realtime === 'function') {
      realtime.call(api, 'plan_updated', plan)
        .catch((err: unknown) => this.deps.error('Failed to emit plan_updated event', normalizeError(err)));
    }
  }

  private async performPlanRebuild(params: {
    reason: string;
    queueWaitMs: number;
    queueDepth: number;
  }): Promise<void> {
    const { reason, queueWaitMs, queueDepth } = params;
    const isDryRun = this.deps.getCapacityDryRun();
    const rebuildId = `rb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const rebuildStart = Date.now();
    const stopSpan = startRuntimeSpan(`plan_rebuild(${reason})`);
    const outcome = createPlanRebuildOutcome(isDryRun);

    const run = async (): Promise<void> => {
      this.deps.structuredLog?.info({ event: 'plan_rebuild_started', rebuildId, reasonCode: reason });

      try {
        await this.executePlanRebuild(isDryRun, outcome);
      } catch (error) {
        outcome.failed = true;
        incPerfCounter('plan_rebuild_failed_total');
        throw error;
      } finally {
        const durationMs = Date.now() - rebuildStart;
        this.recordPlanRebuildMetrics(reason, queueWaitMs, queueDepth, rebuildStart, outcome);
        stopSpan();
        this.deps.structuredLog?.info({
          event: 'plan_rebuild_completed',
          rebuildId,
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
          failed: outcome.failed,
        });
      }
    };

    await withRebuildContext(rebuildId, run);
  }

  private async executePlanRebuild(
    isDryRun: boolean,
    outcome: PlanRebuildOutcome,
  ): Promise<void> {
    const { plan, buildMs } = await this.buildPlanForRebuild();
    this.latestPlanSnapshot = plan;
    const { changes, changeMs } = this.measurePlanChanges(plan);
    const { snapshotMs, snapshotWriteMs } = this.measureSnapshotUpdate(plan, changes);
    const { statusMs, statusWriteMs } = this.measureStatusUpdate(plan, changes);
    const hadShedding = hasShedding(plan);

    if (isDryRun && hadShedding) {
      this.deps.log('Dry run: shedding planned but not executed');
    }

    const { applyMs, appliedActions } = await this.maybeApplyPlanChanges(plan, changes, isDryRun);
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
      hadShedding,
    });
  }

  private async buildPlanForRebuild(): Promise<{ plan: DevicePlan; buildMs: number }> {
    const liveDevices = this.deps.getPlanDevices() ?? [];
    this.deps.planEngine.syncPendingTargetCommands?.(liveDevices, 'rebuild');
    this.deps.planEngine.syncPendingBinaryCommands?.(liveDevices, 'rebuild');
    const buildStart = Date.now();
    let plan = await this.buildDevicePlanSnapshot(liveDevices);
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
  ): Promise<{ applyMs: number; appliedActions: boolean }> {
    const shouldApplyStablePlanActions = this.deps.planEngine.shouldApplyStablePlanActions?.(plan) ?? false;
    if (isDryRun || (!changes.actionChanged && !shouldApplyStablePlanActions)) {
      return { applyMs: 0, appliedActions: false };
    }

    const applyStart = Date.now();
    let appliedActions = false;
    try {
      await this.applyPlanActions(plan);
      appliedActions = true;
      this.deps.schedulePostActuationRefresh?.();
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
    this.emitPlanUpdated(nextPlan);
    return true;
  }

  private decoratePlanWithPendingTargetCommands(plan: DevicePlan): DevicePlan {
    return this.deps.planEngine.decoratePlanWithPendingTargetCommands?.(plan) ?? plan;
  }

  destroy(): void {
    this.clearPendingNonActionSnapshot();
  }
}
