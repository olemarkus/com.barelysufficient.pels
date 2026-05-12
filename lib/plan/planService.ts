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
import { formatDeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
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
import {
  createPlanRebuildOutcome,
  hasShedding,
} from './planServiceInternals';
import { recordPlanRebuildTrace } from '../utils/planRebuildTrace';
import { normalizeError } from '../utils/errorUtils';
import { isFiniteNumber } from '../utils/appTypeGuards';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import { withRebuildContext } from '../logging/logger';
import type {
  SettingsUiPlanDeviceSnapshot,
  SettingsUiPlanSnapshot,
} from '../../packages/contracts/src/settingsUiApi';
import { normalizePlanMeta } from './planStatusHelpers';
import { buildSettingsOverviewReadModel } from './settingsOverviewReadModel';
import { PlanStatusWriter } from './planStatusWriter';
import {
  buildLiveStatePlan,
  canRefreshPlanSnapshotFromLiveState,
  hasPlanExecutionDriftAgainstIntent,
} from './planReconcileState';
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

const SLOW_PLAN_REBUILD_LOG_THRESHOLD_MS = 1500;

const serializePlanForUi = (
  plan: DevicePlan | null,
  deps: PlanServiceDeps,
): SettingsUiPlanSnapshot | null => {
  return buildSettingsOverviewReadModel(plan, {
    getOverviewStarvation: (deviceId) => deps.deviceDiagnostics?.getOverviewStarvation?.(deviceId),
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
    reasonText: formatDeviceReason(device.reason),
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
  schedulePostActuationRefresh?: () => void;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
  overviewDebugStructured?: StructuredDebugEmitter;
  isOverviewDebugEnabled?: () => boolean;
  isPlanDebugEnabled?: () => boolean;
  deviceDiagnostics?: {
    getOverviewStarvation?: (deviceId: string) => SettingsUiPlanDeviceSnapshot['starvation'] | null;
  };
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

  getLatestPlanSnapshotForUi(): SettingsUiPlanSnapshot | null {
    return serializePlanForUi(this.latestPlanSnapshot, this.deps);
  }

  serializePlanSnapshotForUi(plan: DevicePlan | null): SettingsUiPlanSnapshot | null {
    return serializePlanForUi(plan, this.deps);
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

  private updatePlanSnapshot(plan: DevicePlan, changes: PlanChangeSet): void {
    const changed = changes.actionChanged || changes.detailChanged || changes.metaChanged;
    if (changed) {
      this.emitPlanUpdated(plan);
    } else {
      this.emitOverviewTransitions(plan);
    }
  }

  private emitPlanUpdated(plan: DevicePlan): void {
    this.emitOverviewTransitions(plan);
    const api = this.deps.homey.api as { realtime?: (event: string, data: unknown) => Promise<unknown> } | undefined;
    const realtime = api?.realtime;
    if (typeof realtime === 'function') {
      realtime.call(api, 'plan_updated', serializePlanForUi(plan, this.deps))
        .catch((err: unknown) => this.deps.error('Failed to emit plan_updated event', normalizeError(err)));
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
        this.recordPlanRebuildMetrics(reason, queueWaitMs, queueDepth, rebuildStart, outcome);
        recordOpRssDelta('plan_rebuild_ms', rssBefore, safeRss());
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
      this.deps.log('Dry run: shedding planned but not executed');
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
    const shouldApplyStablePlanActions = this.deps.planEngine.shouldApplyStablePlanActions?.(plan) ?? false;
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
      this.deps.error('Failed to apply plan actions', normalizeError(error));
    }
    return {
      applyMs: Date.now() - applyStart,
      appliedActions,
      deviceWriteCount,
      commandRequestCount,
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
      commandRequestCount: outcome.commandRequestCount,
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
    return this.deps.planEngine.decoratePlanWithPendingTargetCommands?.(plan) ?? plan;
  }

}

function sanitizeActuationCount(value: unknown): number {
  return isFiniteNumber(value) ? Math.max(0, Math.trunc(value)) : 0;
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
