import type { PowerTrackerState } from '../core/powerTracker';
import {
  buildLocalDayBuckets,
  getNextLocalDayStartUtcMs,
  getZonedParts,
} from '../utils/dateUtils';
import {
  buildDefaultProfile,
  buildPlan,
  buildPriceDebugData,
  getConfidence,
  normalizeWeights,
  blendProfiles,
  sumArray,
} from './dailyBudgetMath';
import type { CombinedPriceData } from './dailyBudgetMath';
import {
  buildDayContext,
  buildBucketUsage,
  buildDailyBudgetSnapshot,
  computePlanDeviation,
  computeBudgetState,
} from './dailyBudgetState';
import type { DayContext, PriceData } from './dailyBudgetState';
import type {
  DailyBudgetSettings,
  DailyBudgetState,
  DailyBudgetUiPayload,
  DailyBudgetUpdate,
} from './dailyBudgetTypes';

type DailyBudgetManagerDeps = {
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
};

const PLAN_REBUILD_INTERVAL_MS = 60 * 60 * 1000;
const PLAN_REBUILD_USAGE_DELTA_KWH = 0.05;
const PLAN_REBUILD_USAGE_MIN_INTERVAL_MS = 5 * 60 * 1000;
const STATE_PERSIST_INTERVAL_MS = 60 * 1000;
const DEFAULT_PROFILE = buildDefaultProfile();

type ExistingPlanState = {
  planStateMismatch: boolean;
  existingPlan: number[] | null;
  deviationExisting: number;
};

type PlanResult = {
  plannedKWh: number[];
  priceData: PriceData;
  shouldLog: boolean;
};

export class DailyBudgetManager {
  private state: DailyBudgetState = {};
  private snapshot: DailyBudgetUiPayload | null = null;
  private dirty = false;
  private lastPersistMs = 0;
  private lastPlanRebuildMs = 0;

  constructor(private deps: DailyBudgetManagerDeps) {}

  loadState(raw: unknown): void {
    if (isDailyBudgetState(raw)) {
      this.state = { ...raw };
    }
  }

  exportState(): DailyBudgetState {
    return this.state;
  }

  resetLearning(): void {
    this.state.profile = {
      weights: [...DEFAULT_PROFILE],
      sampleCount: 0,
    };
    this.state.frozen = false;
    this.markDirty();
  }

  update(params: {
    nowMs?: number;
    timeZone: string;
    settings: DailyBudgetSettings;
    powerTracker: PowerTrackerState;
    combinedPrices?: CombinedPriceData | null;
    priceOptimizationEnabled: boolean;
    forcePlanRebuild?: boolean;
    capacityBudgetKWh?: number;
  }): DailyBudgetUpdate {
    const {
      nowMs = Date.now(),
      timeZone,
      settings,
      powerTracker,
      combinedPrices,
      priceOptimizationEnabled,
      forcePlanRebuild,
      capacityBudgetKWh,
    } = params;

    const context = buildDayContext({ nowMs, timeZone, powerTracker });
    this.ensureProfile();
    this.handleRollover({ context, settings, powerTracker });

    const enabled = this.isEnabled(settings);
    this.syncEnabledState(enabled);

    const planState = this.resolvePlanState({
      context,
      enabled,
      dailyBudgetKWh: settings.dailyBudgetKWh,
    });
    this.maybeFreezeFromExistingPlan({
      enabled,
      existingPlan: planState.existingPlan,
      deviationExisting: planState.deviationExisting,
    });

    const plan = this.resolvePlan({
      context,
      settings,
      enabled,
      planStateMismatch: planState.planStateMismatch,
      existingPlan: planState.existingPlan,
      combinedPrices,
      priceOptimizationEnabled,
      forcePlanRebuild,
      capacityBudgetKWh,
    });

    const budget = computeBudgetState({
      context,
      enabled,
      dailyBudgetKWh: settings.dailyBudgetKWh,
      plannedKWh: plan.plannedKWh,
      profileSampleCount: this.state.profile?.sampleCount ?? 0,
    });

    this.maybeFreezeFromDeviation(enabled, budget.deviationKWh);
    this.maybeUnfreezeFromDeviation(enabled, budget.deviationKWh);

    if (plan.shouldLog) {
      this.deps.logDebug(
        `Daily budget: used ${context.usedNowKWh.toFixed(2)} kWh, `
        + `allowed ${budget.allowedNowKWh.toFixed(2)} kWh, `
        + `remaining ${budget.remainingKWh.toFixed(2)} kWh, `
        + `confidence ${budget.confidence.toFixed(2)}`,
      );
    }

    const snapshot = buildDailyBudgetSnapshot({
      context,
      settings,
      enabled,
      plannedKWh: plan.plannedKWh,
      priceData: plan.priceData,
      budget,
      frozen: Boolean(this.state.frozen),
    });
    this.snapshot = snapshot;

    if (plan.shouldLog) {
      this.logPlanDebug({
        snapshot,
        priceOptimizationEnabled,
        capacityBudgetKWh,
      });
    }

    this.state.dateKey = context.dateKey;
    this.state.dayStartUtcMs = context.dayStartUtcMs;
    this.state.lastUsedNowKWh = context.usedNowKWh;
    this.markDirty();

    const shouldPersist = this.shouldPersist(context.nowMs);
    return { snapshot: this.snapshot, shouldPersist };
  }

  private logPlanDebug(params: {
    snapshot: DailyBudgetUiPayload;
    priceOptimizationEnabled: boolean;
    capacityBudgetKWh?: number;
  }): void {
    const { snapshot, priceOptimizationEnabled, capacityBudgetKWh } = params;
    const profileSampleCount = this.state.profile?.sampleCount ?? 0;
    const debugPayload = {
      ...snapshot,
      meta: {
        priceOptimizationEnabled,
        capacityBudgetKWh: Number.isFinite(capacityBudgetKWh) ? capacityBudgetKWh : null,
        profileSampleCount,
        profileConfidence: getConfidence(profileSampleCount),
        profileLearnedWeights: this.state.profile?.weights ?? null,
        profileEffectiveWeights: this.getEffectiveProfile(),
      },
    };
    this.deps.logDebug(`Daily budget: plan debug ${JSON.stringify(debugPayload)}`);
  }

  private handleRollover(params: {
    context: DayContext;
    settings: DailyBudgetSettings;
    powerTracker: PowerTrackerState;
  }): void {
    const { context, settings, powerTracker } = params;
    if (this.state.dateKey && this.state.dateKey !== context.dateKey && settings.enabled) {
      this.finalizePreviousDay({
        timeZone: context.timeZone,
        powerTracker,
        previousDateKey: this.state.dateKey,
        previousDayStartUtcMs: this.state.dayStartUtcMs ?? null,
      });
    }
  }

  private isEnabled(settings: DailyBudgetSettings): boolean { return settings.enabled && settings.dailyBudgetKWh > 0; }
  private syncEnabledState(enabled: boolean): void { if (!enabled && this.state.frozen) { this.state.frozen = false; this.markDirty(); } }

  private resolvePlanState(params: {
    context: DayContext;
    enabled: boolean;
    dailyBudgetKWh: number;
  }): ExistingPlanState {
    const { context, enabled, dailyBudgetKWh } = params;
    const planStateMismatch = this.hasPlanStateMismatch(context);
    if (planStateMismatch) this.resetPlanStateOnMismatch();

    const existingPlan = this.getExistingPlan(planStateMismatch, context.bucketStartUtcMs.length);
    const deviations = this.computePlanDeviations({
      context,
      enabled,
      existingPlan,
      dailyBudgetKWh,
    });

    return {
      planStateMismatch,
      existingPlan,
      deviationExisting: deviations.deviationExisting,
    };
  }

  private hasPlanStateMismatch(context: DayContext): boolean {
    if (!this.state.plannedKWh) return true;
    if (this.state.plannedKWh.length !== context.bucketStartUtcMs.length) return true;
    return this.state.dayStartUtcMs !== context.dayStartUtcMs;
  }

  private resetPlanStateOnMismatch(): void { this.state.frozen = false; this.state.lastPlanBucketStartUtcMs = null; }

  private getExistingPlan(planStateMismatch: boolean, bucketCount: number): number[] | null {
    if (planStateMismatch) return null;
    if (!Array.isArray(this.state.plannedKWh)) return null;
    if (this.state.plannedKWh.length !== bucketCount) return null;
    return this.state.plannedKWh;
  }

  private computePlanDeviations(params: {
    context: DayContext;
    enabled: boolean;
    existingPlan: number[] | null;
    dailyBudgetKWh: number;
  }): { deviationExisting: number } {
    const { context, enabled, existingPlan, dailyBudgetKWh } = params;
    if (!enabled || !existingPlan) {
      return { deviationExisting: 0 };
    }
    const { deviationKWh } = computePlanDeviation({
      enabled,
      plannedKWh: existingPlan,
      dailyBudgetKWh,
      currentBucketIndex: context.currentBucketIndex,
      usedNowKWh: context.usedNowKWh,
    });
    return {
      deviationExisting: deviationKWh,
    };
  }

  private maybeFreezeFromExistingPlan(params: {
    enabled: boolean;
    existingPlan: number[] | null;
    deviationExisting: number;
  }): void {
    const { enabled, existingPlan, deviationExisting } = params;
    if (!enabled || !existingPlan || this.state.frozen) return;
    if (deviationExisting <= 0) return;
    this.state.frozen = true;
    this.markDirty(true);
    this.deps.logDebug(`Daily budget: freeze plan (deviation ${deviationExisting.toFixed(2)} kWh)`);
  }

  private resolvePlan(params: {
    context: DayContext;
    settings: DailyBudgetSettings;
    enabled: boolean;
    planStateMismatch: boolean;
    existingPlan: number[] | null;
    combinedPrices?: CombinedPriceData | null;
    priceOptimizationEnabled: boolean;
    forcePlanRebuild?: boolean;
    capacityBudgetKWh?: number;
  }): PlanResult {
    const { context, enabled } = params;
    const shouldRebuildPlan = this.shouldRebuildPlan(params);
    const shouldLog = enabled && shouldRebuildPlan;

    if (enabled && shouldRebuildPlan) {
      const rebuilt = this.rebuildPlan(params);
      return {
        plannedKWh: rebuilt.plannedKWh,
        priceData: rebuilt.priceData,
        shouldLog,
      };
    }

    const priceData = this.resolvePriceData(params);
    const plannedKWh = enabled && this.state.plannedKWh
      ? this.state.plannedKWh
      : context.bucketUsage.map(() => 0);
    return { plannedKWh, priceData, shouldLog };
  }

  private shouldRebuildPlan(params: {
    context: DayContext;
    enabled: boolean;
    planStateMismatch: boolean;
    forcePlanRebuild?: boolean;
  }): boolean {
    const { context, enabled, planStateMismatch, forcePlanRebuild } = params;
    if (!enabled || this.state.frozen) return false;
    const currentBucketStartUtcMs = context.bucketStartUtcMs[context.currentBucketIndex];
    const lastUsedNowKWh = this.state.lastUsedNowKWh;
    const usageDeltaKWh = typeof lastUsedNowKWh === 'number'
      ? Math.abs(context.usedNowKWh - lastUsedNowKWh)
      : 0;
    const usageChanged = usageDeltaKWh >= PLAN_REBUILD_USAGE_DELTA_KWH
      && context.nowMs - this.lastPlanRebuildMs >= PLAN_REBUILD_USAGE_MIN_INTERVAL_MS;
    return (
      planStateMismatch
      || Boolean(forcePlanRebuild)
      || usageChanged
      || this.state.lastPlanBucketStartUtcMs !== currentBucketStartUtcMs
      || context.nowMs - this.lastPlanRebuildMs >= PLAN_REBUILD_INTERVAL_MS
    );
  }

  private rebuildPlan(params: {
    context: DayContext;
    settings: DailyBudgetSettings;
    existingPlan: number[] | null;
    combinedPrices?: CombinedPriceData | null;
    priceOptimizationEnabled: boolean;
    capacityBudgetKWh?: number;
  }): { plannedKWh: number[]; priceData: PriceData } {
    const {
      context,
      settings,
      existingPlan,
      combinedPrices,
      priceOptimizationEnabled,
      capacityBudgetKWh,
    } = params;
    const currentBucketStartUtcMs = context.bucketStartUtcMs[context.currentBucketIndex];
    const lockCurrentBucket = this.state.lastPlanBucketStartUtcMs === currentBucketStartUtcMs;
    const buildResult = buildPlan({
      bucketStartUtcMs: context.bucketStartUtcMs,
      bucketUsage: context.bucketUsage,
      currentBucketIndex: context.currentBucketIndex,
      usedNowKWh: context.usedNowKWh,
      dailyBudgetKWh: settings.dailyBudgetKWh,
      profileWeights: this.getEffectiveProfile(),
      timeZone: context.timeZone,
      combinedPrices,
      priceOptimizationEnabled,
      priceShapingEnabled: settings.priceShapingEnabled,
      previousPlannedKWh: existingPlan ?? undefined,
      capacityBudgetKWh,
      lockCurrentBucket,
    });
    this.state.plannedKWh = buildResult.plannedKWh;
    this.state.lastPlanBucketStartUtcMs = currentBucketStartUtcMs;
    this.state.dayStartUtcMs = context.dayStartUtcMs;
    this.lastPlanRebuildMs = context.nowMs;
    this.markDirty();
    return {
      plannedKWh: buildResult.plannedKWh,
      priceData: {
        prices: buildResult.price,
        priceFactors: buildResult.priceFactor,
        priceShapingActive: buildResult.priceShapingActive,
      },
    };
  }

  private resolvePriceData(params: {
    context: DayContext;
    settings: DailyBudgetSettings;
    enabled: boolean;
    combinedPrices?: CombinedPriceData | null;
    priceOptimizationEnabled: boolean;
  }): PriceData {
    const { context, settings, enabled, combinedPrices, priceOptimizationEnabled } = params;
    if (!enabled || !this.state.plannedKWh) return { priceShapingActive: false };
    return buildPriceDebugData({
      bucketStartUtcMs: context.bucketStartUtcMs,
      currentBucketIndex: context.currentBucketIndex,
      combinedPrices,
      priceOptimizationEnabled,
      priceShapingEnabled: settings.priceShapingEnabled,
    });
  }

  private maybeFreezeFromDeviation(enabled: boolean, deviationKWh: number): void {
    if (!enabled || deviationKWh <= 0 || this.state.frozen) return;
    this.state.frozen = true; this.markDirty(true);
    this.deps.logDebug(`Daily budget: freeze plan (deviation ${deviationKWh.toFixed(2)} kWh)`);
  }

  private maybeUnfreezeFromDeviation(enabled: boolean, deviationKWh: number): void {
    if (!enabled || deviationKWh > 0 || !this.state.frozen) return;
    this.state.frozen = false;
    this.state.lastPlanBucketStartUtcMs = null;
    this.markDirty(true);
    this.deps.logDebug(`Daily budget: unfreeze plan (deviation ${deviationKWh.toFixed(2)} kWh)`);
  }

  private shouldPersist(nowMs: number): boolean {
    const shouldPersist = this.dirty && (nowMs - this.lastPersistMs >= STATE_PERSIST_INTERVAL_MS);
    if (shouldPersist) {
      this.lastPersistMs = nowMs;
      this.dirty = false;
    }
    return shouldPersist;
  }

  getSnapshot(): DailyBudgetUiPayload | null {
    return this.snapshot;
  }

  private ensureProfile(): void {
    if (!this.state.profile || !Array.isArray(this.state.profile.weights) || this.state.profile.weights.length !== 24) {
      this.state.profile = {
        weights: [...DEFAULT_PROFILE],
        sampleCount: 0,
      };
      this.markDirty();
    }
  }

  private getEffectiveProfile(): number[] {
    const learned = this.state.profile?.weights ?? DEFAULT_PROFILE;
    const confidence = getConfidence(this.state.profile?.sampleCount ?? 0);
    return blendProfiles(DEFAULT_PROFILE, learned, confidence);
  }

  private finalizePreviousDay(params: {
    timeZone: string;
    powerTracker: PowerTrackerState;
    previousDateKey: string;
    previousDayStartUtcMs: number | null;
  }): void {
    const { timeZone, powerTracker, previousDateKey, previousDayStartUtcMs } = params;
    if (previousDayStartUtcMs === null) return;
    const previousNextDayStartUtcMs = getNextLocalDayStartUtcMs(previousDayStartUtcMs, timeZone);
    const { bucketStartUtcMs } = buildLocalDayBuckets({
      dayStartUtcMs: previousDayStartUtcMs,
      nextDayStartUtcMs: previousNextDayStartUtcMs,
      timeZone,
    });
    const { bucketUsage } = buildBucketUsage({ bucketStartUtcMs, powerTracker });
    const totalKWh = sumArray(bucketUsage);
    if (totalKWh <= 0) {
      this.state.frozen = false;
      this.state.lastPlanBucketStartUtcMs = null;
      this.state.plannedKWh = [];
      this.markDirty(true);
      this.deps.logDebug(`Daily budget: skip learning for ${previousDateKey} (0 kWh)`);
      return;
    }
    const hourlyTotals = Array.from({ length: 24 }, () => 0);
    bucketStartUtcMs.forEach((ts, index) => {
      const bucketHour = getZonedParts(new Date(ts), timeZone).hour;
      hourlyTotals[bucketHour] = (hourlyTotals[bucketHour] ?? 0) + (bucketUsage[index] ?? 0);
    });
    const nextWeights = hourlyTotals.map((value) => value / totalKWh);
    this.updateProfile(nextWeights);
    this.state.frozen = false;
    this.state.lastPlanBucketStartUtcMs = null;
    this.state.plannedKWh = [];
    this.markDirty(true);
    this.deps.logDebug(`Daily budget: finalized ${previousDateKey} (${totalKWh.toFixed(2)} kWh)`);
  }

  private updateProfile(dayWeights: number[]): void {
    const profile = this.state.profile ?? { weights: [...DEFAULT_PROFILE], sampleCount: 0 };
    if (dayWeights.length !== 24) return;
    const sampleCount = Math.max(0, profile.sampleCount ?? 0);
    const nextCount = sampleCount + 1;
    const nextWeights = profile.weights.map((value, index) => (
      (value * sampleCount + dayWeights[index]) / nextCount
    ));
    this.state.profile = {
      weights: normalizeWeights(nextWeights),
      sampleCount: nextCount,
    };
  }

  private markDirty(force = false): void { this.dirty = true; if (force) this.lastPersistMs = 0; }
}

function isDailyBudgetState(value: unknown): value is DailyBudgetState {
  if (!value || typeof value !== 'object') return false;
  const state = value as DailyBudgetState;
  if (state.profile) {
    if (!Array.isArray(state.profile.weights) || state.profile.weights.length !== 24) return false;
    if (typeof state.profile.sampleCount !== 'number') return false;
  }
  if (state.plannedKWh && !Array.isArray(state.plannedKWh)) return false;
  return true;
}

export {
  blendProfiles,
  buildAllowedCumKWh,
  buildDefaultProfile,
  buildPlan,
  buildPriceDebugData,
  buildPriceFactors,
  buildWeightsFromPlan,
  getConfidence,
  normalizeWeights,
  resolveCurrentBucketIndex,
  sumArray,
} from './dailyBudgetMath';
export type { CombinedPriceData } from './dailyBudgetMath';
