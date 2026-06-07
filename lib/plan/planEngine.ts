import Homey from 'homey';
import CapacityGuard from '../power/capacityGuard';
import type { PowerTrackerState } from '../power/tracker';
import type { DevicePlan, PendingTargetObservationSource, PlanInputDevice, ShedAction } from './planTypes';
import { PlanBuilder, PlanBuilderDeps } from './planBuilder';
import type { PlanActuationMode } from '../executor/executorTypes';
import { PlanExecutor } from '../executor/planExecutor';
import type { PlanActuationResult, PlanExecutorDeps } from '../executor/planExecutor';
import { createPlanEngineState, PlanEngineState } from './planState';
import {
  evaluateHeadroomForDevice,
  syncHeadroomCardState,
  syncHeadroomUsageObservation,
  type HeadroomCardDeviceLike,
  type HeadroomForDeviceDecision,
  type HeadroomUsageObservation,
} from './planHeadroomDevice';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import {
  decoratePlanWithPendingTargetCommands,
  prunePendingTargetCommandsForPlan,
  syncPendingTargetCommands,
} from './planTargetControl';
import {
  createPendingBinaryCommandStore,
  syncPendingBinaryCommands,
  type PendingBinaryCommandStore,
  type PendingBinaryLiveDevice,
} from '../observer/pendingBinaryCommands';
import { isPendingBinaryCommandActive } from './planObservationPolicy';
import { getLogger, type Logger as PinoLogger, type StructuredDebugEmitter } from '../logging/logger';
import type { Actuator } from '../actuator/deviceActuator';

const moduleLogger = getLogger('plan/engine');

export type PlanEngineDeps = {
  homey: Homey.App['homey'];
  deviceManager: PlanExecutorDeps['deviceManager'];
  getObservedState: PlanExecutorDeps['getObservedState'];
  actuator: Actuator;
  getCapacityGuard: () => CapacityGuard | undefined;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getCapacityDryRun: () => boolean;
  getOperatingMode: () => string;
  getModeDeviceTargets: () => Record<string, Record<string, number>>;
  getPriceOptimizationEnabled: () => boolean;
  getPriceOptimizationSettings: () => Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;
  isCurrentHourCheap: () => boolean;
  isCurrentHourExpensive: () => boolean;
  getPowerTracker: () => PowerTrackerState;
  getDailyBudgetSnapshot?: () => DailyBudgetUiPayload | null;
  // Pre-built smart-task decoration function (the app wiring constructs the
  // DeferredObjectiveDecorationController and passes its `decorate` here). The
  // engine forwards it straight to the builder — lib/plan never imports
  // lib/objectives, so neither the planner nor the executor knows about smart
  // tasks directly.
  decorateDeferredObjectives?: PlanBuilderDeps['decorateDeferredObjectives'];
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
  getPriorityForDevice: (deviceId: string) => number;
  getDynamicSoftLimitOverride?: () => number | null;
  logTargetRetryComparison?: (params: {
    deviceId: string;
    name: string;
    targetCap: string;
    desired: number;
    observedValue?: unknown;
    observedSource?: string;
    retryCount: number;
    skipContext: 'plan' | 'shedding' | 'overshoot';
  }) => Promise<void> | void;
  syncLivePlanStateAfterTargetActuation?: (source: PendingTargetObservationSource) => boolean | void;
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
  markSteppedLoadDesiredStepIssued: (params: {
    deviceId: string;
    desiredStepId: string;
    previousStepId?: string;
    issuedAtMs?: number;
    pendingWindowMs?: number;
  }) => void;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export class PlanEngine {
  public readonly state: PlanEngineState;
  /**
   * Observer-owned facade over `state.pendingBinaryCommands`. The executor's
   * binary-control dispatcher writes/deletes through this store, and plan-
   * and executor-side read sites consult it via `get`/`peek`; nothing
   * reads or evicts the backing `Record` directly. See
   * `notes/state-management/observer-transport-split.md` (PR #4).
   */
  public readonly pendingBinaryCommandStore: PendingBinaryCommandStore;

  private builder: PlanBuilder;
  private executor: PlanExecutor;
  private readonly deviceDiagnostics?: DeviceDiagnosticsRecorder;
  private readonly debugStructuredFn?: StructuredDebugEmitter;
  private readonly structuredLog: PinoLogger;

  constructor(deps: PlanEngineDeps) {
    this.state = createPlanEngineState();
    this.pendingBinaryCommandStore = createPendingBinaryCommandStore(this.state.pendingBinaryCommands);
    this.deviceDiagnostics = deps.deviceDiagnostics;
    this.debugStructuredFn = deps.debugStructured;
    this.structuredLog = deps.structuredLog ?? moduleLogger;

    const builderDeps: PlanBuilderDeps = {
      homey: deps.homey,
      getCapacityGuard: deps.getCapacityGuard,
      getCapacitySettings: deps.getCapacitySettings,
      getOperatingMode: deps.getOperatingMode,
      getModeDeviceTargets: deps.getModeDeviceTargets,
      getPriceOptimizationEnabled: deps.getPriceOptimizationEnabled,
      getPriceOptimizationSettings: deps.getPriceOptimizationSettings,
      isCurrentHourCheap: deps.isCurrentHourCheap,
      isCurrentHourExpensive: deps.isCurrentHourExpensive,
      getPowerTracker: deps.getPowerTracker,
      getDailyBudgetSnapshot: deps.getDailyBudgetSnapshot,
      getPriorityForDevice: deps.getPriorityForDevice,
      getShedBehavior: deps.getShedBehavior,
      getDynamicSoftLimitOverride: deps.getDynamicSoftLimitOverride,
      deviceDiagnostics: deps.deviceDiagnostics,
      structuredLog: deps.structuredLog,
      debugStructured: deps.debugStructured,
      decorateDeferredObjectives: deps.decorateDeferredObjectives,
      pendingBinaryCommandStore: this.pendingBinaryCommandStore,
      log: deps.log,
      logDebug: deps.logDebug,
    };

    const executorDeps: PlanExecutorDeps = {
      homey: deps.homey,
      deviceManager: deps.deviceManager,
      getObservedState: deps.getObservedState,
      actuator: deps.actuator,
      getCapacityGuard: deps.getCapacityGuard,
      getCapacitySettings: deps.getCapacitySettings,
      getCapacityDryRun: deps.getCapacityDryRun,
      getOperatingMode: deps.getOperatingMode,
      getShedBehavior: deps.getShedBehavior,
      markSteppedLoadDesiredStepIssued: deps.markSteppedLoadDesiredStepIssued,
      logTargetRetryComparison: deps.logTargetRetryComparison,
      syncLivePlanStateAfterTargetActuation: deps.syncLivePlanStateAfterTargetActuation,
      deviceDiagnostics: deps.deviceDiagnostics,
      pendingBinaryCommandStore: this.pendingBinaryCommandStore,
    };

    this.builder = new PlanBuilder(builderDeps, this.state);
    this.executor = new PlanExecutor(executorDeps, this.state);
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

  public async applyPlanActions(plan: DevicePlan, mode: PlanActuationMode = 'plan'): Promise<PlanActuationResult> {
    return this.executor.applyPlanActions(plan, mode);
  }

  public shouldApplyStablePlanActions(plan: DevicePlan): boolean {
    return this.executor.hasStablePlanActuation(plan);
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

  public getPendingBinaryCommandForDevice(
    deviceId: string,
    communicationModel?: 'local' | 'cloud',
  ): { desired: boolean } | null {
    const pending = this.pendingBinaryCommandStore.peek(deviceId);
    if (!pending || !isPendingBinaryCommandActive({ pending, communicationModel })) return null;
    return { desired: pending.desired };
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
      devices: params.devices,
      deviceId: params.deviceId,
      device: params.device,
      headroom: params.headroom,
      requiredKw: params.requiredKw,
      cleanupMissingDevices: params.cleanupMissingDevices,
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
      devices: params.devices,
      cleanupMissingDevices: params.cleanupMissingDevices,
      reconciliationContext: params.reconciliationContext,
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
      deviceId: params.deviceId,
      usageObservation: params.usageObservation,
      reconciliationContext: params.reconciliationContext,
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
