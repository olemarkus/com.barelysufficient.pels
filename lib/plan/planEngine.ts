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
import type { DeferredObjectiveActivePlansV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';
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
} from '../observer/pendingBinaryCommands';
import { isPendingBinaryCommandActive } from './planObservationPolicy';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import type {
  DeferredObjectiveHoursRemainingBus,
  DeferredObjectiveHoursRemainingTracker,
  DeferredObjectiveSettingsV1,
  DeferredObjectiveStatusBus,
} from './deferredObjectives';

export type PlanEngineDeps = {
  homey: Homey.App['homey'];
  deviceManager: PlanExecutorDeps['deviceManager'];
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
  getDeferredObjectiveSettings?: () => DeferredObjectiveSettingsV1;
  getDeferredObjectiveActivePlans?: () => DeferredObjectiveActivePlansV1 | null;
  getTimeZone: () => string;
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
  deferredObjectiveDebugStructured?: StructuredDebugEmitter;
  observeDeferredObjectivePlanHistory?: PlanBuilderDeps['observeDeferredObjectivePlanHistory'];
  observeDeferredObjectiveActivePlans?: PlanBuilderDeps['observeDeferredObjectiveActivePlans'];
  getStallClassification?: PlanBuilderDeps['getStallClassification'];
  getLearnedThermostatDeadbandC?: PlanBuilderDeps['getLearnedThermostatDeadbandC'];
  getDeferredObjectiveStatusBus?: () => DeferredObjectiveStatusBus | undefined;
  getDeferredObjectiveHoursRemainingBus?: () => DeferredObjectiveHoursRemainingBus | undefined;
  getDeferredObjectiveHoursRemainingTracker?: () => DeferredObjectiveHoursRemainingTracker | undefined;
  disableDeferredObjective?: (deviceId: string) => void;
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
   * binary-control dispatcher writes/deletes through this store; plan-side
   * read sites still consult the backing `Record` directly. See
   * `notes/state-management/observer-transport-split.md` (PR #4).
   */
  public readonly pendingBinaryCommandStore: PendingBinaryCommandStore;

  private builder: PlanBuilder;
  private executor: PlanExecutor;
  private readonly deviceDiagnostics?: DeviceDiagnosticsRecorder;
  private readonly logFn: (...args: unknown[]) => void;
  private readonly logDebugFn: (...args: unknown[]) => void;

  constructor(deps: PlanEngineDeps) {
    this.state = createPlanEngineState();
    this.pendingBinaryCommandStore = createPendingBinaryCommandStore(this.state.pendingBinaryCommands);
    this.deviceDiagnostics = deps.deviceDiagnostics;
    this.logFn = deps.log;
    this.logDebugFn = deps.logDebug;

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
      getDeferredObjectiveSettings: deps.getDeferredObjectiveSettings,
      getDeferredObjectiveActivePlans: deps.getDeferredObjectiveActivePlans,
      getTimeZone: deps.getTimeZone,
      getPriorityForDevice: deps.getPriorityForDevice,
      getShedBehavior: deps.getShedBehavior,
      getDynamicSoftLimitOverride: deps.getDynamicSoftLimitOverride,
      deviceDiagnostics: deps.deviceDiagnostics,
      structuredLog: deps.structuredLog,
      debugStructured: deps.debugStructured,
      deferredObjectiveDebugStructured: deps.deferredObjectiveDebugStructured,
      observeDeferredObjectivePlanHistory: deps.observeDeferredObjectivePlanHistory,
      observeDeferredObjectiveActivePlans: deps.observeDeferredObjectiveActivePlans,
      getStallClassification: deps.getStallClassification,
      getLearnedThermostatDeadbandC: deps.getLearnedThermostatDeadbandC,
      getDeferredObjectiveStatusBus: deps.getDeferredObjectiveStatusBus,
      getDeferredObjectiveHoursRemainingBus: deps.getDeferredObjectiveHoursRemainingBus,
      getDeferredObjectiveHoursRemainingTracker: deps.getDeferredObjectiveHoursRemainingTracker,
      disableDeferredObjective: deps.disableDeferredObjective,
      log: deps.log,
      logDebug: deps.logDebug,
    };

    const executorDeps: PlanExecutorDeps = {
      homey: deps.homey,
      deviceManager: deps.deviceManager,
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
      log: (message) => this.logFn(message),
      logDebug: (message) => this.logDebugFn(message),
    });
  }

  public prunePendingTargetCommands(plan: DevicePlan): boolean {
    return prunePendingTargetCommandsForPlan({
      state: this.state,
      plan,
      logDebug: (message) => this.logDebugFn(message),
    });
  }

  public syncPendingBinaryCommands(
    devices: PlanInputDevice[],
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
