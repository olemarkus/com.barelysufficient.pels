import Homey from 'homey';
import CapacityGuard from '../core/capacityGuard';
import type { PowerTrackerState } from '../core/powerTracker';
import type { DevicePlan, DevicePlanDevice, PlanInputDevice, ShedAction } from './planTypes';
import type { PlanEngineState } from './planState';
import { computeDailyUsageSoftLimit, computeDynamicSoftLimit, computeShortfallThreshold } from './planBudget';
import { buildPlanContext, type PlanContext, type SoftLimitSource } from './planContext';
import { buildSheddingPlan, type SheddingPlan } from './planShedding';
import { buildInitialPlanDevices } from './planDevices';
import { applyRestorePlan, type RestorePlanResult } from './planRestore';
import { sumControlledUsageKw } from './planUsage';
import {
  applyShedTemperatureHold,
  finalizePlanDevices,
  normalizeShedReasons,
} from './planReasons';
import { getHourBucketKey } from '../utils/dateUtils';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';

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
  getDailyBudgetSnapshot?: () => DailyBudgetUiPayload | null;
  getPriorityForDevice: (deviceId: string) => number;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null };
  getDynamicSoftLimitOverride?: () => number | null;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
};

const getCurrentHourKWh = (buckets?: Record<string, number>): number | undefined => {
  const value = buckets?.[getHourBucketKey()];
  return typeof value === 'number' ? value : undefined;
};

export class PlanBuilder {
  constructor(private deps: PlanBuilderDeps, private state: PlanEngineState) { }

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

  private get dailyBudgetSnapshot(): DailyBudgetUiPayload | null {
    return this.deps.getDailyBudgetSnapshot?.() ?? null;
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

  public async buildDevicePlanSnapshot(devices: PlanInputDevice[]): Promise<DevicePlan> {
    const desiredForMode = this.modeDeviceTargets[this.operatingMode] || {};
    const dailyBudgetSnapshot = this.dailyBudgetSnapshot;
    const capacitySoftLimit = this.computeDynamicSoftLimit();
    const dailySoftLimit = this.computeDailySoftLimit(dailyBudgetSnapshot);
    const softLimit = dailySoftLimit !== null ? Math.min(capacitySoftLimit, dailySoftLimit) : capacitySoftLimit;
    const softLimitSource = this.resolveSoftLimitSource(capacitySoftLimit, dailySoftLimit);
    const context = buildPlanContext({
      devices,
      capacityGuard: this.capacityGuard,
      capacitySettings: this.capacitySettings,
      powerTracker: this.powerTracker,
      softLimit,
      capacitySoftLimit,
      dailySoftLimit,
      softLimitSource,
      desiredForMode,
      hourlyBudgetExhausted: this.state.hourlyBudgetExhausted,
      dailyBudget: this.buildDailyBudgetContext(dailyBudgetSnapshot),
    });

    const sheddingPlan = await buildSheddingPlan(context, this.state, {
      capacityGuard: this.capacityGuard,
      powerTracker: this.powerTracker,
      getShedBehavior: (deviceId) => this.deps.getShedBehavior(deviceId),
      getPriorityForDevice: (deviceId) => this.deps.getPriorityForDevice(deviceId),
      log: (...args: unknown[]) => this.deps.log(...args),
      logDebug: (...args: unknown[]) => this.deps.logDebug(...args),
    });
    this.applySheddingUpdates(sheddingPlan);

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

    const restoreResult = this.applyRestorePlanAndUpdateState({
      planDevices,
      context,
      sheddingActive: sheddingPlan.sheddingActive,
    });
    planDevices = restoreResult.planDevices;

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
      meta: this.buildPlanMeta(context, planDevices, dailyBudgetSnapshot),
      devices: planDevices,
    };
  }

  private resolveSoftLimitSource(capacitySoftLimit: number, dailySoftLimit: number | null): SoftLimitSource {
    if (dailySoftLimit === null) return 'capacity';
    if (dailySoftLimit === capacitySoftLimit) return 'both';
    return dailySoftLimit < capacitySoftLimit ? 'daily' : 'capacity';
  }

  private computeDailySoftLimit(snapshot: DailyBudgetUiPayload | null): number | null {
    if (!snapshot?.budget.enabled) return null;
    const plannedKWh = snapshot.buckets.plannedKWh;
    const bucketStartUtc = snapshot.buckets.startUtc;
    const index = snapshot.currentBucketIndex;
    if (!Array.isArray(plannedKWh) || !Array.isArray(bucketStartUtc)) return null;
    if (index < 0 || index >= plannedKWh.length || index >= bucketStartUtc.length) return null;
    const bucketStartIso = bucketStartUtc[index];
    const bucketStartMs = new Date(bucketStartIso).getTime();
    if (!Number.isFinite(bucketStartMs)) return null;
    const bucketEndMs = index + 1 < bucketStartUtc.length
      ? new Date(bucketStartUtc[index + 1]).getTime()
      : bucketStartMs + 60 * 60 * 1000;
    if (!Number.isFinite(bucketEndMs)) return null;
    const usedKWh = this.powerTracker.buckets?.[bucketStartIso] ?? 0;
    const planned = plannedKWh[index];
    if (!Number.isFinite(planned)) return null;
    return computeDailyUsageSoftLimit({
      plannedKWh: planned,
      usedKWh,
      bucketStartMs,
      bucketEndMs,
      logDebug: (...args: unknown[]) => this.deps.logDebug(...args),
    });
  }

  private extractDailyBudgetHourKWh(snapshot: DailyBudgetUiPayload | null): number | undefined {
    if (!snapshot?.budget.enabled) return undefined;
    const plannedKWh = snapshot.buckets.plannedKWh;
    const index = snapshot.currentBucketIndex;
    if (!Array.isArray(plannedKWh) || index < 0 || index >= plannedKWh.length) return undefined;
    const value = plannedKWh[index];
    return Number.isFinite(value) ? value : undefined;
  }

  private buildDailyBudgetContext(snapshot: DailyBudgetUiPayload | null): PlanContext['dailyBudget'] | undefined {
    if (!snapshot) return undefined;
    return {
      enabled: snapshot.budget.enabled,
      usedNowKWh: snapshot.state.usedNowKWh,
      allowedNowKWh: snapshot.state.allowedNowKWh,
      remainingKWh: snapshot.state.remainingKWh,
      exceeded: snapshot.state.exceeded,
      frozen: snapshot.state.frozen,
    };
  }

  private applySheddingUpdates(sheddingPlan: SheddingPlan): void {
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
  }

  private applyRestorePlanAndUpdateState(params: {
    planDevices: DevicePlanDevice[];
    context: PlanContext;
    sheddingActive: boolean;
  }): RestorePlanResult {
    const { planDevices, context, sheddingActive } = params;
    const restoreResult = applyRestorePlan({
      planDevices,
      context,
      state: this.state,
      sheddingActive,
      deps: {
        powerTracker: this.powerTracker,
        getShedBehavior: (deviceId) => this.deps.getShedBehavior(deviceId),
        log: (...args: unknown[]) => this.deps.log(...args),
        logDebug: (...args: unknown[]) => this.deps.logDebug(...args),
      },
    });
    this.state.pendingSwapTargets = restoreResult.stateUpdates.pendingSwapTargets;
    this.state.pendingSwapTimestamps = restoreResult.stateUpdates.pendingSwapTimestamps;
    this.state.swappedOutFor = restoreResult.stateUpdates.swappedOutFor;
    this.state.lastSwapPlanMeasurementTs = restoreResult.stateUpdates.lastSwapPlanMeasurementTs;
    return restoreResult;
  }

  private buildPlanMeta(
    context: PlanContext,
    planDevices: DevicePlanDevice[],
    dailyBudgetSnapshot: DailyBudgetUiPayload | null,
  ): DevicePlan['meta'] {
    const controlledKw = sumControlledUsageKw(planDevices);
    const uncontrolledKw = typeof context.total === 'number' && controlledKw !== null
      ? Math.max(0, context.total - controlledKw)
      : undefined;
    return {
      totalKw: context.total,
      softLimitKw: context.softLimit,
      capacitySoftLimitKw: context.capacitySoftLimit,
      dailySoftLimitKw: context.dailySoftLimit,
      softLimitSource: context.softLimitSource,
      headroomKw: context.headroom,
      hourlyBudgetExhausted: this.state.hourlyBudgetExhausted,
      usedKWh: context.usedKWh,
      budgetKWh: context.budgetKWh,
      minutesRemaining: context.minutesRemaining,
      controlledKw: controlledKw ?? undefined,
      uncontrolledKw,
      hourControlledKWh: getCurrentHourKWh(this.powerTracker.controlledBuckets),
      hourUncontrolledKWh: getCurrentHourKWh(this.powerTracker.uncontrolledBuckets),
      dailyBudgetRemainingKWh: dailyBudgetSnapshot?.state.remainingKWh ?? 0,
      dailyBudgetExceeded: dailyBudgetSnapshot?.state.exceeded ?? false,
      dailyBudgetHourKWh: this.extractDailyBudgetHourKWh(dailyBudgetSnapshot),
    };
  }
}
