import type { PhasePower } from '../../lib/plan/phase/phasePower';
import type { ExecutionState } from '../../lib/executor/executionState';
import { syncPendingTargetCommands, prunePendingTargetCommands } from '../../lib/executor/pendingTargetObservation';
import type { DeviceDiagnosticsRecorder } from '../../lib/diagnostics/deviceDiagnosticsService';
import { syncTrackedSteppedCommands } from '../../lib/executor/syncSteppedCommands';
import type { SteppedSettleDevice } from '../../lib/observer/steppedSettleSnapshot';
import type { SteppedCommandStore } from '../../lib/executor/steppedCommandStore';
import type { SteppedReportedStepStore } from '../../lib/observer/steppedReportedStep';
import type { PlanExecutor } from '../../lib/executor/planExecutor';
import type { PlanActuationResult } from '../../lib/planContract/planActuationResult';
import type { ExecutionPlan } from '../../lib/planContract/executionPlan';
import type { Logger as PinoLogger } from '../../lib/logging/logger';
import {
  syncPendingBinaryCommands,
  type PendingBinaryCommandStore,
} from '../../lib/observer/pendingBinaryCommands';
import type { PendingBinaryLiveDevice } from '../../lib/ports/controlCommandConfirmation';
import type { PlanEngine } from '../../lib/plan/planEngine';
import type { PlanBuilder } from '../../lib/plan/planBuilder';
import {
  evaluateHeadroomForDevice,
  syncHeadroomCardSnapshot,
  syncHeadroomUsageObservation,
  type HeadroomCardDeviceLike,
  type HeadroomCardQuery,
  type HeadroomForDeviceDecision,
} from '../../lib/plan/planHeadroomDevice';
import type { PlanEngineState } from '../../lib/plan/planState';
import {
  decoratePlanWithPendingTargetCommands,
  resolveWantedPendingTargetCommands,
} from '../../lib/plan/planTargetControl';
import type {
  DevicePlan,
  PendingTargetObservationSource,
  PlanInputDevice,
} from '../../lib/plan/planTypes';


export type PlanEngineComposition = {
  chargingPhases: import('../../lib/ports/chargingPhases').ChargingPhaseOwner;
  state: PlanEngineState;
  execution: ExecutionState;
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  steppedCommandStore: SteppedCommandStore;
  steppedReportedStore: SteppedReportedStepStore;
  builder: PlanBuilder;
  executor: Pick<PlanExecutor,
    | 'getDeviceExecutionStates'
    | 'handleShortfall'
    | 'handleShortfallCleared'
    | 'applyPlanActions'
    | 'hasStablePlanActuation'
    | 'hasExecutionWorkOutstanding'
    | 'isInverterReleaseRecoveryReady'
    | 'getPendingInverterReleaseCount'
    | 'handleConfirmedBinaryCommand'
    | 'retainContestedCommands'
    | 'getObservationRevision'
    | 'syncStorageCommands'>;
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
  structuredLog: PinoLogger;
};

/** Setup-owned facade binding the planner and executor to one state instance. */
export class ComposedPlanEngine implements PlanEngine {
  public readonly state: PlanEngineState;
  private readonly execution: ExecutionState;
  public readonly pendingBinaryCommandStore: PendingBinaryCommandStore;

  private readonly steppedCommandStore: SteppedCommandStore;

  private readonly steppedReportedStore: SteppedReportedStepStore;

  private readonly builder: PlanBuilder;
  private readonly executor: PlanEngineComposition['executor'];
  private readonly deviceDiagnostics?: DeviceDiagnosticsRecorder;
  private readonly structuredLog: PinoLogger;

  public constructor(composition: PlanEngineComposition) {
    this.chargingPhases = composition.chargingPhases;
    this.state = composition.state;
    this.execution = composition.execution;
    this.pendingBinaryCommandStore = composition.pendingBinaryCommandStore;
    this.steppedCommandStore = composition.steppedCommandStore;
    this.steppedReportedStore = composition.steppedReportedStore;
    this.builder = composition.builder;
    this.executor = composition.executor;
    this.deviceDiagnostics = composition.deviceDiagnostics;
    this.structuredLog = composition.structuredLog;
  }

  public async buildDevicePlanSnapshot(devices: PlanInputDevice[]): Promise<DevicePlan> {
    return this.builder.buildDevicePlanSnapshot(devices);
  }

  private readonly chargingPhases: import('../../lib/ports/chargingPhases').ChargingPhaseOwner;

  public readChargingPhaseControl(deviceId: string) {
    return this.chargingPhases.read(deviceId);
  }

  public readChargingPhaseEnvelopes() { return this.chargingPhases.readPermittedEnvelopes(); }
  public readChargingPhaseExecutionGate() { return this.chargingPhases; }

  public computeCapacityPace(): number | null {
    return this.builder.computeCapacityPace();
  }

  public computePhysicalPowerLimit(): number | null {
    return this.builder.computePhysicalPowerLimit();
  }

  public computePhasePower(netKw: number): PhasePower {
    return this.builder.computePhasePower(netKw);
  }

  public computePhaseDeficitKw(netKw: number): number {
    return this.builder.computePhaseDeficitKw(netKw);
  }

  public computeShortfallThreshold(): number | null {
    return this.builder.computeShortfallThreshold();
  }

  public async handleShortfall(deficitKw: number): Promise<void> {
    return this.executor.handleShortfall(deficitKw);
  }

  public async handleShortfallCleared(): Promise<void> {
    return this.executor.handleShortfallCleared();
  }

  public async applyPlanActions(plan: ExecutionPlan): Promise<PlanActuationResult> {
    return this.executor.applyPlanActions(plan);
  }

  public getDeviceExecutionStates(plan: ExecutionPlan) {
    return this.executor.getDeviceExecutionStates(plan);
  }

  public shouldApplyStablePlanActions(plan: ExecutionPlan): boolean {
    return this.executor.hasStablePlanActuation(plan);
  }

  public getObservationRevision(): number {
    return this.executor.getObservationRevision();
  }

  public hasExecutionWorkOutstanding(plan: ExecutionPlan, observationRevisionAtBuild: number): boolean {
    return this.executor.hasExecutionWorkOutstanding(plan, observationRevisionAtBuild);
  }

  public syncPendingTargetCommands(
    devices: PlanInputDevice[],
    source: PendingTargetObservationSource,
  ): boolean {
    return syncPendingTargetCommands(
      this.execution, devices, source, (payload) => this.structuredLog.info(payload),
    );
  }

  public prunePendingTargetCommands(plan: DevicePlan): boolean {
    return prunePendingTargetCommands(this.execution, resolveWantedPendingTargetCommands(plan));
  }

  public retainContestedCommands(plan: ExecutionPlan): void {
    this.executor.retainContestedCommands(plan);
  }

  public syncSteppedCommands(getDevices: () => readonly SteppedSettleDevice[]): boolean {
    return syncTrackedSteppedCommands(this.steppedCommandStore, this.steppedReportedStore, getDevices);
  }

  public syncStorageCommands(): void {
    this.executor.syncStorageCommands();
  }

  public syncPendingBinaryCommands(
    devices: PendingBinaryLiveDevice[],
    source: PendingTargetObservationSource,
  ): boolean {
    return syncPendingBinaryCommands(
      this.pendingBinaryCommandStore,
      devices,
      source,
      (confirmation) => this.executor.handleConfirmedBinaryCommand(confirmation),
    );
  }

  public decoratePlanWithPendingTargetCommands(plan: DevicePlan): DevicePlan {
    return decoratePlanWithPendingTargetCommands(this.state, plan);
  }

  public hasPendingTargetCommands(): boolean {
    return this.execution.hasPendingTargetCommands();
  }

  public isInverterReleaseRecoveryReady(): boolean { return this.executor.isInverterReleaseRecoveryReady(); }

  public getPendingInverterReleaseCount(plan: ExecutionPlan): number {
    return this.executor.getPendingInverterReleaseCount(plan);
  }

  public hasPendingTargetCommandsOlderThan(thresholdMs: number): boolean {
    return this.execution.hasPendingTargetCommandsOlderThan(thresholdMs);
  }

  public hasPendingBinaryCommands(): boolean {
    return this.pendingBinaryCommandStore.hasAny();
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

  public evaluateHeadroomForDevice(query: HeadroomCardQuery): HeadroomForDeviceDecision {
    return evaluateHeadroomForDevice(this.state, query, Date.now(), this.deviceDiagnostics);
  }

  public syncHeadroomCardState(devices: HeadroomCardDeviceLike[]): void {
    syncHeadroomCardSnapshot(this.state, devices, Date.now(), 'snapshot_refresh', this.deviceDiagnostics);
  }

  public syncHeadroomUsageObservation(deviceId: string, usageKw: number): void {
    syncHeadroomUsageObservation(this.state, deviceId, usageKw, Date.now(), this.deviceDiagnostics);
  }

  public beginStartupRestoreStabilization(nowMs: number): void {
    this.state.restoreBackoff.beginStartupBlock(nowMs);
  }

  public clearStartupRestoreStabilization(nowTs: number): boolean {
    return this.state.restoreBackoff.clearStartupBlock(nowTs);
  }
}
