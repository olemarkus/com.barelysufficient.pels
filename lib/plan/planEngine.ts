import Homey from 'homey';
import CapacityGuard from '../core/capacityGuard';
import { DeviceManager } from '../core/deviceManager';
import type { PowerTrackerState } from '../core/powerTracker';
import type { DevicePlan, PendingTargetObservationSource, PlanInputDevice, ShedAction } from './planTypes';
import { PlanBuilder, PlanBuilderDeps } from './planBuilder';
import { PlanActuationMode, PlanExecutor, PlanExecutorDeps } from './planExecutor';
import { createPlanEngineState, PlanEngineState } from './planState';
import {
  evaluateHeadroomForDevice,
  syncHeadroomCardState,
  syncHeadroomCardTrackedUsage,
  type HeadroomCardDeviceLike,
  type HeadroomForDeviceDecision,
} from './planHeadroomDevice';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import {
  decoratePlanWithPendingTargetCommands,
  prunePendingTargetCommandsForPlan,
  syncPendingTargetCommands,
} from './planTargetControl';
import { syncPendingBinaryCommands } from './planBinaryControl';

export type PlanEngineDeps = {
  homey: Homey.App['homey'];
  deviceManager: DeviceManager;
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
  updateLocalSnapshot: (deviceId: string, updates: { target?: number | null; on?: boolean }) => void;
  markSteppedLoadDesiredStepIssued: (params: {
    deviceId: string;
    desiredStepId: string;
    previousStepId?: string;
    issuedAtMs?: number;
  }) => void;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export class PlanEngine {
  public readonly state: PlanEngineState;

  private builder: PlanBuilder;
  private executor: PlanExecutor;
  private readonly deviceDiagnostics?: DeviceDiagnosticsRecorder;
  private readonly logFn: (...args: unknown[]) => void;
  private readonly logDebugFn: (...args: unknown[]) => void;

  constructor(deps: PlanEngineDeps) {
    this.state = createPlanEngineState();
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
      getPriorityForDevice: deps.getPriorityForDevice,
      getShedBehavior: deps.getShedBehavior,
      getDynamicSoftLimitOverride: deps.getDynamicSoftLimitOverride,
      deviceDiagnostics: deps.deviceDiagnostics,
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
      updateLocalSnapshot: deps.updateLocalSnapshot,
      markSteppedLoadDesiredStepIssued: deps.markSteppedLoadDesiredStepIssued,
      logTargetRetryComparison: deps.logTargetRetryComparison,
      syncLivePlanStateAfterTargetActuation: deps.syncLivePlanStateAfterTargetActuation,
      deviceDiagnostics: deps.deviceDiagnostics,
      log: deps.log,
      logDebug: deps.logDebug,
      error: deps.error,
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

  public async applyPlanActions(plan: DevicePlan, mode: PlanActuationMode = 'plan'): Promise<void> {
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
      state: this.state,
      liveDevices: devices,
      source,
      logDebug: (message) => this.logDebugFn(message),
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
    return Object.keys(this.state.pendingBinaryCommands).length > 0;
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
  }): boolean {
    return syncHeadroomCardState({
      state: this.state,
      devices: params.devices,
      cleanupMissingDevices: params.cleanupMissingDevices,
      diagnostics: this.deviceDiagnostics,
    });
  }

  public syncHeadroomCardTrackedUsage(params: {
    deviceId: string;
    trackedKw: number;
  }): boolean {
    return syncHeadroomCardTrackedUsage({
      state: this.state,
      deviceId: params.deviceId,
      trackedKw: params.trackedKw,
      diagnostics: this.deviceDiagnostics,
    });
  }

  public async applySheddingToDevice(deviceId: string, deviceName?: string, reason?: string): Promise<void> {
    return this.executor.applySheddingToDevice(deviceId, deviceName, reason);
  }
}
