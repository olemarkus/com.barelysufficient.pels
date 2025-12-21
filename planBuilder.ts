import Homey from 'homey';
import CapacityGuard from './capacityGuard';
import type { PowerTrackerState } from './powerTracker';
import type { DevicePlan, PlanInputDevice, ShedAction } from './planTypes';
import type { PlanEngineState } from './planState';
import { computeDynamicSoftLimit, computeShortfallThreshold } from './planBudget';
import { buildPlanContext } from './planContext';
import { buildSheddingPlan } from './planShedding';
import { buildInitialPlanDevices } from './planDevices';
import { applyRestorePlan } from './planRestore';
import {
  applyShedTemperatureHold,
  finalizePlanDevices,
  normalizeShedReasons,
} from './planReasons';

export type PlanBuilderDeps = {
  homey: Homey.App['homey'];
  getCapacityGuard: () => CapacityGuard | undefined;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getOperatingMode: () => string;
  getModeDeviceTargets: () => Record<string, Record<string, number>>;
  getPriceOptimizationEnabled: () => boolean;
  getPriceOptimizationSettings: () => Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;
  isCurrentHourCheap: () => boolean;
  isCurrentHourExpensive: () => boolean;
  getPowerTracker: () => PowerTrackerState;
  getPriorityForDevice: (deviceId: string) => number;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null };
  getDynamicSoftLimitOverride?: () => number | null;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
};

export class PlanBuilder {
  constructor(private deps: PlanBuilderDeps, private state: PlanEngineState) {}

  private get capacityGuard(): CapacityGuard | undefined {
    return this.deps.getCapacityGuard();
  }

  private get capacitySettings(): { limitKw: number; marginKw: number } {
    return this.deps.getCapacitySettings();
  }

  private get operatingMode(): string {
    return this.deps.getOperatingMode();
  }

  private get modeDeviceTargets(): Record<string, Record<string, number>> {
    return this.deps.getModeDeviceTargets();
  }

  private get priceOptimizationEnabled(): boolean {
    return this.deps.getPriceOptimizationEnabled();
  }

  private get priceOptimizationSettings(): Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }> {
    return this.deps.getPriceOptimizationSettings();
  }

  private get powerTracker(): PowerTrackerState {
    return this.deps.getPowerTracker();
  }

  public computeDynamicSoftLimit(): number {
    const override = this.deps.getDynamicSoftLimitOverride?.();
    if (typeof override === 'number' && Number.isFinite(override)) {
      this.state.hourlyBudgetExhausted = false;
      return override;
    }
    const result = computeDynamicSoftLimit({
      capacitySettings: this.capacitySettings,
      powerTracker: this.powerTracker,
      logDebug: (...args: unknown[]) => this.deps.logDebug(...args),
    });
    this.state.hourlyBudgetExhausted = result.hourlyBudgetExhausted;
    return result.allowedKw;
  }

  /**
   * Compute the shortfall threshold - the "real" soft limit without EOH capping.
   * Shortfall should only trigger when power exceeds this threshold AND no devices left to shed.
   * During end-of-hour, the soft limit for shedding is artificially lowered to prepare
   * for the next hour, but we shouldn't alert shortfall just because of that constraint.
   */
  public computeShortfallThreshold(): number {
    return computeShortfallThreshold({
      capacitySettings: this.capacitySettings,
      powerTracker: this.powerTracker,
    });
  }

  public buildDevicePlanSnapshot(devices: PlanInputDevice[]): DevicePlan {
    const desiredForMode = this.modeDeviceTargets[this.operatingMode] || {};
    const softLimit = this.computeDynamicSoftLimit();
    const context = buildPlanContext({
      devices,
      capacityGuard: this.capacityGuard,
      capacitySettings: this.capacitySettings,
      powerTracker: this.powerTracker,
      softLimit,
      desiredForMode,
      hourlyBudgetExhausted: this.state.hourlyBudgetExhausted,
    });

    const sheddingPlan = buildSheddingPlan(context, this.state, {
      capacityGuard: this.capacityGuard,
      powerTracker: this.powerTracker,
      getShedBehavior: (deviceId) => this.deps.getShedBehavior(deviceId),
      getPriorityForDevice: (deviceId) => this.deps.getPriorityForDevice(deviceId),
      log: (...args: unknown[]) => this.deps.log(...args),
      logDebug: (...args: unknown[]) => this.deps.logDebug(...args),
    });
    if (sheddingPlan.updates.lastOvershootMs !== undefined) {
      this.state.lastOvershootMs = sheddingPlan.updates.lastOvershootMs;
    }
    if (sheddingPlan.updates.lastShedPlanMeasurementTs !== undefined) {
      this.state.lastShedPlanMeasurementTs = sheddingPlan.updates.lastShedPlanMeasurementTs;
    }
    if (sheddingPlan.guardInShortfall !== this.state.inShortfall) {
      this.state.inShortfall = sheddingPlan.guardInShortfall;
      this.deps.homey.settings.set('capacity_in_shortfall', sheddingPlan.guardInShortfall);
    }

    let planDevices = buildInitialPlanDevices({
      context,
      state: this.state,
      shedSet: sheddingPlan.shedSet,
      shedReasons: sheddingPlan.shedReasons,
      guardInShortfall: sheddingPlan.guardInShortfall,
      deps: {
        getPriorityForDevice: (deviceId) => this.deps.getPriorityForDevice(deviceId),
        getShedBehavior: (deviceId) => this.deps.getShedBehavior(deviceId),
        isCurrentHourCheap: () => this.deps.isCurrentHourCheap(),
        isCurrentHourExpensive: () => this.deps.isCurrentHourExpensive(),
        getPriceOptimizationEnabled: () => this.priceOptimizationEnabled,
        getPriceOptimizationSettings: () => this.priceOptimizationSettings,
      },
    });

    const restoreResult = applyRestorePlan({
      planDevices,
      context,
      state: this.state,
      sheddingActive: sheddingPlan.sheddingActive,
      deps: {
        powerTracker: this.powerTracker,
        getShedBehavior: (deviceId) => this.deps.getShedBehavior(deviceId),
        log: (...args: unknown[]) => this.deps.log(...args),
        logDebug: (...args: unknown[]) => this.deps.logDebug(...args),
      },
    });
    planDevices = restoreResult.planDevices;
    this.state.pendingSwapTargets = restoreResult.stateUpdates.pendingSwapTargets;
    this.state.pendingSwapTimestamps = restoreResult.stateUpdates.pendingSwapTimestamps;
    this.state.swappedOutFor = restoreResult.stateUpdates.swappedOutFor;
    this.state.lastSwapPlanMeasurementTs = restoreResult.stateUpdates.lastSwapPlanMeasurementTs;

    const holdResult = applyShedTemperatureHold({
      planDevices,
      state: this.state,
      shedReasons: sheddingPlan.shedReasons,
      inShedWindow: restoreResult.inShedWindow,
      inCooldown: restoreResult.inCooldown,
      activeOvershoot: restoreResult.activeOvershoot,
      restoreHysteresis: restoreResult.restoreHysteresis,
      availableHeadroom: restoreResult.availableHeadroom,
      restoredOneThisCycle: restoreResult.restoredOneThisCycle,
      restoredThisCycle: restoreResult.restoredThisCycle,
      shedCooldownRemainingSec: restoreResult.shedCooldownRemainingSec,
      holdDuringRestoreCooldown: restoreResult.inRestoreCooldown,
      getShedBehavior: (deviceId) => this.deps.getShedBehavior(deviceId),
    });
    planDevices = holdResult.planDevices;

    if (restoreResult.restoredThisCycle.size > 0) {
      this.state.lastRestoreMs = Date.now();
    }

    planDevices = normalizeShedReasons({
      planDevices,
      shedReasons: sheddingPlan.shedReasons,
      guardInShortfall: sheddingPlan.guardInShortfall,
      headroomRaw: context.headroomRaw,
      restoreHysteresis: restoreResult.restoreHysteresis,
      inCooldown: restoreResult.inCooldown,
      activeOvershoot: restoreResult.activeOvershoot,
      inRestoreCooldown: restoreResult.inRestoreCooldown,
      shedCooldownRemainingSec: restoreResult.shedCooldownRemainingSec,
      restoreCooldownRemainingSec: restoreResult.restoreCooldownRemainingSec,
    });

    const finalized = finalizePlanDevices(planDevices);
    planDevices = finalized.planDevices;
    this.state.lastPlannedShedIds = finalized.lastPlannedShedIds;

    return {
      meta: {
        totalKw: context.total,
        softLimitKw: context.softLimit,
        headroomKw: context.headroom,
        hourlyBudgetExhausted: this.state.hourlyBudgetExhausted,
        usedKWh: context.usedKWh,
        budgetKWh: context.budgetKWh,
        minutesRemaining: context.minutesRemaining,
      },
      devices: planDevices,
    };
  }
}
