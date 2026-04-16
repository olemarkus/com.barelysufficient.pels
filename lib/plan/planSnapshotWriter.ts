import type Homey from 'homey';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import { DETAIL_SNAPSHOT_WRITE_THROTTLE_MS } from '../utils/timingConstants';
import type { DevicePlan, PlanChangeSet, PlanSnapshotWriteReason } from './planTypes';

type PlanSnapshotWriterDeps = {
  homey: Homey.App['homey'];
  error: (message: string, error: Error) => void;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
};

type DeferredPlanSnapshotWriteResult =
  | { success: true; writeMs: number }
  | { success: false };

export class PlanSnapshotWriter {
  private stopped = false;
  private lastPlanSnapshotWriteMs = 0;
  private pendingNonActionSnapshotReason = 'meta_only' as const;
  private pendingNonActionSnapshotPlan: DevicePlan | null = null;
  private pendingNonActionSnapshotTimer?: ReturnType<typeof setTimeout>;

  constructor(private deps: PlanSnapshotWriterDeps) {}

  update(plan: DevicePlan, changes: PlanChangeSet): number {
    if (this.stopped) return 0;
    const now = Date.now();
    const changed = changes.actionChanged || changes.detailChanged || changes.metaChanged;
    if (!changed) {
      return this.flushPendingNonActionSnapshot(now);
    }

    if (changes.actionChanged) {
      const writeMs = this.writePlanSnapshot(plan, 'action_changed', now);
      this.clearPendingNonActionSnapshot();
      return writeMs;
    }

    if (changes.detailChanged) {
      const writeMs = this.writePlanSnapshot(plan, 'detail_changed', now);
      this.clearPendingNonActionSnapshot();
      return writeMs;
    }

    if (this.canWriteNonActionSnapshot(now)) {
      const writeMs = this.writePlanSnapshot(plan, 'meta_only', now);
      this.clearPendingNonActionSnapshot();
      return writeMs;
    }

    this.schedulePendingNonActionSnapshot(plan, 'meta_only', now);
    incPerfCounter('settings_set.device_plan_snapshot_meta_write_throttled_total');
    return 0;
  }

  destroy(): void {
    this.stopped = true;
    this.clearPendingNonActionSnapshot();
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
    reason: 'meta_only',
    nowMs: number,
  ): void {
    if (this.stopped) return;
    this.pendingNonActionSnapshotPlan = plan;
    this.pendingNonActionSnapshotReason = reason;
    this.deps.debugStructured?.({
      event: 'plan_snapshot_write_throttled',
      reasonCode: 'meta_only_throttled',
      deviceCount: plan.devices.length,
      totalKw: plan.meta.totalKw ?? null,
      waitMs: this.resolveNonActionWaitMs(nowMs),
      snapshotReason: reason,
    });
    if (this.pendingNonActionSnapshotTimer) return;

    const waitMs = this.resolveNonActionWaitMs(nowMs);
    this.pendingNonActionSnapshotTimer = setTimeout(() => {
      this.pendingNonActionSnapshotTimer = undefined;
      if (this.stopped) return;
      this.flushPendingNonActionSnapshot(Date.now());
    }, waitMs);
  }

  private flushPendingNonActionSnapshot(nowMs: number): number {
    if (this.stopped) return 0;
    if (!this.pendingNonActionSnapshotPlan) return 0;
    if (!this.canWriteNonActionSnapshot(nowMs)) {
      this.schedulePendingNonActionSnapshot(
        this.pendingNonActionSnapshotPlan,
        this.pendingNonActionSnapshotReason,
        nowMs,
      );
      return 0;
    }

    const writeResult = this.writeDeferredPlanSnapshot(
      this.pendingNonActionSnapshotPlan,
      this.pendingNonActionSnapshotReason,
      nowMs,
    );
    if (!writeResult.success) {
      return 0;
    }
    this.clearPendingNonActionSnapshot();
    incPerfCounter('settings_set.device_plan_snapshot_meta_write_flushed_total');
    return writeResult.writeMs;
  }

  private clearPendingNonActionSnapshot(): void {
    if (this.pendingNonActionSnapshotTimer) {
      clearTimeout(this.pendingNonActionSnapshotTimer);
      this.pendingNonActionSnapshotTimer = undefined;
    }
    this.pendingNonActionSnapshotPlan = null;
    this.pendingNonActionSnapshotReason = 'meta_only';
  }

  private writeDeferredPlanSnapshot(
    plan: DevicePlan,
    reason: PlanSnapshotWriteReason,
    nowMs: number,
  ): DeferredPlanSnapshotWriteResult {
    try {
      return {
        success: true,
        writeMs: this.writePlanSnapshot(plan, reason, nowMs),
      };
    } catch (error) {
      const normalizedError = normalizeError(error);
      this.deps.structuredLog?.error({
        event: 'plan_snapshot_write_failed',
        reasonCode: reason,
        deviceCount: plan.devices.length,
        totalKw: plan.meta.totalKw ?? null,
        err: normalizedError,
      });
      this.deps.error('Failed to write deferred device plan snapshot', normalizedError);
      return { success: false };
    }
  }

  private writePlanSnapshot(plan: DevicePlan, reason: PlanSnapshotWriteReason, nowMs: number): number {
    if (this.stopped) return 0;
    const writeStart = Date.now();
    this.deps.homey.settings.set('device_plan_snapshot', plan);
    this.lastPlanSnapshotWriteMs = nowMs;
    const writeMs = Date.now() - writeStart;
    this.deps.structuredLog?.info({
      event: 'plan_snapshot_written',
      reasonCode: reason,
      deviceCount: plan.devices.length,
      totalKw: plan.meta.totalKw ?? null,
      writeMs,
    });
    addPerfDuration('settings_write_ms', writeMs);
    incPerfCounter('settings_set.device_plan_snapshot');
    incPerfCounter(`settings_set.device_plan_snapshot_reason.${reason}_total`);
    return writeMs;
  }
}
