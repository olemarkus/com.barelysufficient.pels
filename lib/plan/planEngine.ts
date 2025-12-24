import Homey from 'homey';
import CapacityGuard from '../core/capacityGuard';
import { DeviceManager } from '../core/deviceManager';
import type { PowerTrackerState } from '../core/powerTracker';
import type { DevicePlan, PlanInputDevice, ShedAction } from './planTypes';
import { PlanBuilder, PlanBuilderDeps } from './planBuilder';
import { PlanExecutor, PlanExecutorDeps } from './planExecutor';
import { createPlanEngineState, PlanEngineState } from './planState';

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
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null };
  getPriorityForDevice: (deviceId: string) => number;
  getDynamicSoftLimitOverride?: () => number | null;
  applySheddingToDevice?: (deviceId: string, deviceName?: string, reason?: string) => Promise<void>;
  updateLocalSnapshot: (deviceId: string, updates: { target?: number | null; on?: boolean }) => void;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export class PlanEngine {
  public readonly state: PlanEngineState;

  private builder: PlanBuilder;
  private executor: PlanExecutor;

  constructor(private deps: PlanEngineDeps) {
    this.state = createPlanEngineState();

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
      getPriorityForDevice: deps.getPriorityForDevice,
      getShedBehavior: deps.getShedBehavior,
      getDynamicSoftLimitOverride: deps.getDynamicSoftLimitOverride,
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
      applySheddingToDevice: deps.applySheddingToDevice,
      updateLocalSnapshot: deps.updateLocalSnapshot,
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

  public async applyPlanActions(plan: DevicePlan): Promise<void> {
    return this.executor.applyPlanActions(plan);
  }

  public async applySheddingToDevice(deviceId: string, deviceName?: string, reason?: string): Promise<void> {
    return this.executor.applySheddingToDevice(deviceId, deviceName, reason);
  }
}
