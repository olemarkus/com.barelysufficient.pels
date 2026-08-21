import type { DeviceDiagnosticsRecorder } from '../../lib/diagnostics/deviceDiagnosticsService';
import {
  canRefreshPlanSnapshotFromLiveState,
  hasPlanExecutionDriftAgainstIntent,
} from '../../lib/executor/executorConvergence';
import type { PlanExecutor } from '../../lib/executor/planExecutor';
import type { PlanActuationResult } from '../../lib/planContract/planActuationResult';
import { getLogger, type Logger as PinoLogger, type StructuredDebugEmitter } from '../../lib/logging/logger';
import {
  syncPendingBinaryCommands,
  type PendingBinaryCommandStore,
  type PendingBinaryLiveDevice,
} from '../../lib/observer/pendingBinaryCommands';
import type { PlanEngine } from '../../lib/plan/planEngine';
import type { PlanBuilder } from '../../lib/plan/planBuilder';
import {
  evaluateHeadroomForDevice,
  syncHeadroomCardState,
  syncHeadroomUsageObservation,
  type HeadroomCardDeviceLike,
  type HeadroomForDeviceDecision,
  type HeadroomUsageObservation,
} from '../../lib/plan/planHeadroomDevice';
import type { PlanEngineState } from '../../lib/plan/planState';
import {
  decoratePlanWithPendingTargetCommands,
  prunePendingTargetCommandsForPlan,
  syncPendingTargetCommands,
} from '../../lib/plan/planTargetControl';
import type {
  DevicePlan,
  PendingTargetObservationSource,
  PlanInputDevice,
} from '../../lib/plan/planTypes';

const moduleLogger = getLogger('plan/engine');

export type PlanEngineComposition = {
  state: PlanEngineState;
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  builder: PlanBuilder;
  executor: Pick<PlanExecutor,
    | 'handleShortfall'
    | 'handleShortfallCleared'
    | 'applyPlanActions'
    | 'hasStablePlanActuation'
    | 'handleConfirmedBinaryCommand'
    | 'driftObservationDeps'
    | 'getObservationRevision'
    | 'applySheddingToDevice'>;
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
  debugStructured?: StructuredDebugEmitter;
  structuredLog?: PinoLogger;
};

/** Setup-owned facade binding the planner and executor to one state instance. */
export class ComposedPlanEngine implements PlanEngine {
  public readonly state: PlanEngineState;
  public readonly pendingBinaryCommandStore: PendingBinaryCommandStore;

  private readonly builder: PlanBuilder;
  private readonly executor: PlanEngineComposition['executor'];
  private readonly deviceDiagnostics?: DeviceDiagnosticsRecorder;
  private readonly debugStructuredFn?: StructuredDebugEmitter;
  private readonly structuredLog: PinoLogger;

  public constructor(composition: PlanEngineComposition) {
    this.state = composition.state;
    this.pendingBinaryCommandStore = composition.pendingBinaryCommandStore;
    this.builder = composition.builder;
    this.executor = composition.executor;
    this.deviceDiagnostics = composition.deviceDiagnostics;
    this.debugStructuredFn = composition.debugStructured;
    this.structuredLog = composition.structuredLog ?? moduleLogger;
  }

  public async buildDevicePlanSnapshot(devices: PlanInputDevice[]): Promise<DevicePlan> {
    return this.builder.buildDevicePlanSnapshot(devices);
  }

  public computeDynamicSoftLimit(): number {
    return this.builder.computeDynamicSoftLimit();
  }

  public computeShortfallThreshold(): number {
    return this.builder.computeShortfallThreshold();
  }

  public async handleShortfall(deficitKw: number): Promise<void> {
    return this.executor.handleShortfall(deficitKw);
  }

  public async handleShortfallCleared(): Promise<void> {
    return this.executor.handleShortfallCleared();
  }

  public async applyPlanActions(plan: DevicePlan): Promise<PlanActuationResult> {
    return this.executor.applyPlanActions(plan);
  }

  public shouldApplyStablePlanActions(plan: DevicePlan): boolean {
    return this.executor.hasStablePlanActuation(plan);
  }

  public hasSettledActuation(basePlan: DevicePlan, livePlan: DevicePlan): boolean {
    return canRefreshPlanSnapshotFromLiveState(basePlan, livePlan);
  }

  public getObservationRevision(): number {
    return this.executor.getObservationRevision();
  }

  public hasExecutionWorkOutstanding(
    plannedSnapshot: DevicePlan,
    observationRevisionAtBuild: number,
  ): boolean {
    // The plan was decided against the observations as of
    // `observationRevisionAtBuild`. If the observer has accepted a write since,
    // this plan has not been decided against the world it would now be applied
    // to — and acting anyway is an apply-without-decide, the shape that breached
    // the hard cap (`inc_26449fb9`). Decline; the observation that moved is
    // itself a rebuild trigger, and the re-decide is the honest answer.
    if (this.executor.getObservationRevision() !== observationRevisionAtBuild) return false;
    return hasPlanExecutionDriftAgainstIntent(plannedSnapshot, this.executor.driftObservationDeps());
  }

  public syncPendingTargetCommands(
    devices: PlanInputDevice[],
    source: PendingTargetObservationSource,
  ): boolean {
    return syncPendingTargetCommands({
      state: this.state,
      liveDevices: devices,
      source,
      structuredInfo: (payload) => this.structuredLog.info(payload),
      debugStructured: this.debugStructuredFn,
    });
  }

  public prunePendingTargetCommands(plan: DevicePlan): boolean {
    return prunePendingTargetCommandsForPlan({
      state: this.state,
      plan,
      debugStructured: this.debugStructuredFn,
    });
  }

  public syncPendingBinaryCommands(
    devices: PendingBinaryLiveDevice[],
    source: PendingTargetObservationSource,
  ): boolean {
    return syncPendingBinaryCommands({
      store: this.pendingBinaryCommandStore,
      liveDevices: devices,
      source,
      onConfirmed: ({ deviceId, liveDevice, pending, confirmedAtMs }) => {
        this.executor.handleConfirmedBinaryCommand({
          deviceId,
          liveDevice,
          pending,
          confirmedAtMs,
        });
      },
    });
  }

  public decoratePlanWithPendingTargetCommands(plan: DevicePlan): DevicePlan {
    return decoratePlanWithPendingTargetCommands(this.state, plan);
  }

  public hasPendingTargetCommands(): boolean {
    return Object.keys(this.state.pendingTargetCommands).length > 0;
  }

  public hasPendingTargetCommandsOlderThan(thresholdMs: number): boolean {
    const nowMs = Date.now();
    return Object.values(this.state.pendingTargetCommands)
      .some((pending) => (nowMs - pending.startedMs) >= thresholdMs);
  }

  public hasPendingBinaryCommands(): boolean {
    return this.pendingBinaryCommandStore.hasAny();
  }

  public getPendingBinaryCommandForDevice(deviceId: string): { desired: boolean } | null {
    const pending = this.pendingBinaryCommandStore.get(deviceId);
    if (!pending) return null;
    return { desired: pending.desired };
  }

  public hasAttributablePendingBinaryCommand(deviceId: string): boolean {
    return this.pendingBinaryCommandStore.isBinaryChangeAttributableToPels(deviceId);
  }

  public clearRecentBinaryOffCommand(
    deviceId: string,
    observedOnAtMs?: number,
  ): void {
    this.pendingBinaryCommandStore.clearRecentConfirmedOff(deviceId, observedOnAtMs);
  }

  public evaluateHeadroomForDevice(params: {
    devices: HeadroomCardDeviceLike[];
    deviceId: string;
    device?: HeadroomCardDeviceLike;
    headroom: number;
    requiredKw: number;
    cleanupMissingDevices?: boolean;
  }): HeadroomForDeviceDecision | null {
    return evaluateHeadroomForDevice({
      state: this.state,
      ...params,
      diagnostics: this.deviceDiagnostics,
    });
  }

  public syncHeadroomCardState(params: {
    devices: HeadroomCardDeviceLike[];
    cleanupMissingDevices?: boolean;
    reconciliationContext?: 'snapshot_refresh';
  }): boolean {
    return syncHeadroomCardState({
      state: this.state,
      ...params,
      diagnostics: this.deviceDiagnostics,
    });
  }

  public syncHeadroomUsageObservation(params: {
    deviceId: string;
    usageObservation: HeadroomUsageObservation;
    reconciliationContext?: 'snapshot_refresh';
  }): boolean {
    return syncHeadroomUsageObservation({
      state: this.state,
      ...params,
      diagnostics: this.deviceDiagnostics,
    });
  }

  public async applySheddingToDevice(deviceId: string, deviceName: string, reason?: string): Promise<boolean> {
    return this.executor.applySheddingToDevice(deviceId, deviceName, reason);
  }

  public beginStartupRestoreStabilization(durationMs = 60_000, nowTs = Date.now()): void {
    this.state.startupRestoreBlockedUntilMs = nowTs + Math.max(0, durationMs);
  }

  public clearStartupRestoreStabilization(nowTs = Date.now()): boolean {
    if (this.state.startupRestoreBlockedUntilMs === null) return false;
    this.state.startupRestoreBlockedUntilMs = nowTs - 1;
    return true;
  }
}
