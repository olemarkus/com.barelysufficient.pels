import type { PowerTrackerState } from '../core/powerTracker';
import {
  buildDefaultProfile,
  buildPlan,
  buildPriceDebugData,
} from './dailyBudgetMath';
import type { CombinedPriceData } from './dailyBudgetMath';
import { buildSnapshot, logBudgetSummaryIfNeeded, logPlanDebugIfNeeded } from './dailyBudgetManagerSnapshot';
import {
  resolveExistingPlanState,
  resolvePlanLockState,
  shouldRebuildDailyBudgetPlan,
} from './dailyBudgetManagerPlan';
import { logNextDayPlanDebug } from './dailyBudgetNextDayDebug';
import { buildDailyBudgetPreview } from './dailyBudgetPreview';
import {
  buildDayContext,
  computeBudgetState,
} from './dailyBudgetState';
import { buildDailyBudgetHistory } from './dailyBudgetHistory';
import type { DayContext, PriceData } from './dailyBudgetState';
import type {
  DailyBudgetDayPayload,
  DailyBudgetSettings,
  DailyBudgetState,
  DailyBudgetUpdate,
} from './dailyBudgetTypes';
import { isDailyBudgetState, type DailyBudgetManagerDeps, type ExistingPlanState, type PlanResult } from './dailyBudgetManagerTypes';
import { finalizePreviousDayLearning } from './dailyBudgetLearning';
import { ensureObservedHourlyStats } from './dailyBudgetObservedStats';
import {
  ensureDailyBudgetProfile,
  getEffectiveProfileData,
  getProfileSampleCount,
  getProfileSplitSampleCount,
} from './dailyBudgetProfile';

const DEFAULT_PROFILE = buildDefaultProfile();

export class DailyBudgetManager {
  private static readonly STATE_PERSIST_INTERVAL_MS = 60 * 1000;
  private state: DailyBudgetState = {};
  private snapshot: DailyBudgetDayPayload | null = null;
  private lastPlannedUncontrolledKWh: number[] | null = null;
  private lastPlannedControlledKWh: number[] | null = null;
  private dirty = false;
  private lastPersistMs = 0;
  private lastPlanRebuildMs = 0;

  constructor(private deps: DailyBudgetManagerDeps) { }
  loadState(raw: unknown): void {
    if (isDailyBudgetState(raw)) {
      this.state = { ...raw };
    }
  }
  exportState(): DailyBudgetState {
    const state = { ...this.state };
    if (typeof state.profileSampleCount === 'number' && state.profile) {
      state.profile = { ...state.profile, sampleCount: state.profileSampleCount };
    }
    return state;
  }
  resetLearning(): void {
    this.state.profileUncontrolled = {
      weights: [...DEFAULT_PROFILE],
      sampleCount: 0,
    };
    this.state.profileControlled = {
      weights: [...DEFAULT_PROFILE],
      sampleCount: 0,
    };
    this.state.profileControlledShare = 0;
    this.state.profileSampleCount = 0;
    this.state.profileSplitSampleCount = 0;
    this.state.profileObservedMaxUncontrolledKWh = Array.from({ length: 24 }, () => 0);
    this.state.profileObservedMaxControlledKWh = Array.from({ length: 24 }, () => 0);
    this.state.profileObservedMinUncontrolledKWh = Array.from({ length: 24 }, () => 0);
    this.state.profileObservedMinControlledKWh = Array.from({ length: 24 }, () => 0);
    this.state.profile = undefined;
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
    const profileResult = ensureDailyBudgetProfile(this.state, DEFAULT_PROFILE);
    if (profileResult.changed) this.markDirty();
    this.state = profileResult.state;
    const observedResult = ensureObservedHourlyStats({
      state: this.state,
      powerTracker,
      timeZone,
      nowMs: context.nowMs,
    });
    if (observedResult.changed) {
      this.state = observedResult.nextState;
      this.markDirty(true);
      if (observedResult.logMessage) this.deps.logDebug(observedResult.logMessage);
    }
    this.handleRollover({ context, settings, powerTracker });

    const enabled = this.isEnabled(settings);
    this.syncEnabledState(enabled);

    const planState = this.preparePlanState({
      context,
      enabled,
      dailyBudgetKWh: settings.dailyBudgetKWh,
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
      profileSampleCount: getProfileSampleCount(this.state),
      profileSplitSampleCount: getProfileSplitSampleCount(this.state),
    });

    this.maybeFreezeFromDeviation(enabled, budget.deviationKWh);
    this.maybeUnfreezeFromDeviation(enabled, budget.deviationKWh);
    logBudgetSummaryIfNeeded({
      logDebug: this.deps.logDebug,
      shouldLog: plan.shouldLog,
      context,
      budget,
    });

    const snapshot = buildSnapshot({
      state: this.state,
      settings,
      enabled,
      plan,
      budget,
      context,
      defaultProfile: DEFAULT_PROFILE,
    });
    this.snapshot = snapshot;

    logPlanDebugIfNeeded({
      logDebug: this.deps.logDebug,
      shouldLog: plan.shouldLog,
      snapshot,
      priceData: plan.priceData,
      priceOptimizationEnabled,
      capacityBudgetKWh,
      settings,
      state: this.state,
      defaultProfile: DEFAULT_PROFILE,
      planDebug: plan.planDebug,
    });
    logNextDayPlanDebug({
      logDebug: this.deps.logDebug,
      shouldLog: plan.shouldLog,
      context,
      settings,
      state: this.state,
      combinedPrices,
      priceOptimizationEnabled,
      capacityBudgetKWh,
      defaultProfile: DEFAULT_PROFILE,
    });

    this.state.dateKey = context.dateKey;
    this.state.dayStartUtcMs = context.dayStartUtcMs;
    this.state.lastUsedNowKWh = context.usedNowKWh;
    this.markDirty();

    const shouldPersist = this.shouldPersist(context.nowMs);
    return { snapshot, shouldPersist };
  }

  private handleRollover(params: {
    context: DayContext;
    settings: DailyBudgetSettings;
    powerTracker: PowerTrackerState;
  }): void {
    const { context, settings, powerTracker } = params;
    if (this.state.dateKey && this.state.dateKey !== context.dateKey && settings.enabled) {
      const result = finalizePreviousDayLearning({
        state: this.state,
        timeZone: context.timeZone,
        powerTracker,
        previousDateKey: this.state.dateKey,
        previousDayStartUtcMs: this.state.dayStartUtcMs ?? null,
        defaultProfile: DEFAULT_PROFILE,
        nowMs: context.nowMs,
      });
      if (result.logMessage) this.deps.logDebug(result.logMessage);
      if (result.shouldMarkDirty) this.markDirty(true);
      this.state = result.nextState;
    }
  }

  private isEnabled(settings: DailyBudgetSettings): boolean { return settings.enabled && settings.dailyBudgetKWh > 0; }
  private syncEnabledState(enabled: boolean): void {
    if (!enabled && this.state.frozen) {
      this.state.frozen = false;
      this.markDirty();
    }
    if (!enabled) {
      this.lastPlannedUncontrolledKWh = null;
      this.lastPlannedControlledKWh = null;
    }
  }

  private preparePlanState(params: {
    context: DayContext;
    enabled: boolean;
    dailyBudgetKWh: number;
  }): ExistingPlanState {
    const { context, enabled, dailyBudgetKWh } = params;
    const planStateResult = resolveExistingPlanState({
      state: this.state,
      context,
      enabled,
      dailyBudgetKWh,
    });
    if (planStateResult.resetPlanState) {
      this.state.frozen = false;
      this.state.lastPlanBucketStartUtcMs = null;
      this.lastPlannedUncontrolledKWh = null;
      this.lastPlannedControlledKWh = null;
    }
    const planState = planStateResult.planState;
    if (enabled && planState.existingPlan && !this.state.frozen && planState.deviationExisting > 0) {
      this.state.frozen = true;
      this.markDirty(true);
      this.deps.logDebug(`Daily budget: freeze plan (deviation ${planState.deviationExisting.toFixed(2)} kWh)`);
    }
    return planState;
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
    const shouldRebuildPlan = shouldRebuildDailyBudgetPlan({
      context,
      enabled,
      planStateMismatch: params.planStateMismatch,
      forcePlanRebuild: params.forcePlanRebuild,
      frozen: Boolean(this.state.frozen),
      lastPlanBucketStartUtcMs: this.state.lastPlanBucketStartUtcMs,
      lastUsedNowKWh: this.state.lastUsedNowKWh,
      lastPlanRebuildMs: this.lastPlanRebuildMs,
    });
    const shouldLog = enabled && shouldRebuildPlan;

    if (enabled && shouldRebuildPlan) {
      const rebuilt = this.rebuildPlan(params);
      return {
        plannedKWh: rebuilt.plannedKWh,
        plannedUncontrolledKWh: rebuilt.plannedUncontrolledKWh,
        plannedControlledKWh: rebuilt.plannedControlledKWh,
        priceData: rebuilt.priceData,
        shouldLog,
        planDebug: rebuilt.planDebug,
      };
    }

    const priceData = this.resolvePriceData(params);
    const plannedKWh = enabled && this.state.plannedKWh
      ? this.state.plannedKWh
      : context.bucketUsage.map(() => 0);
    const hasStoredSplit = enabled
      && Array.isArray(this.lastPlannedUncontrolledKWh)
      && Array.isArray(this.lastPlannedControlledKWh)
      && this.lastPlannedUncontrolledKWh.length === plannedKWh.length
      && this.lastPlannedControlledKWh.length === plannedKWh.length;
    const plannedUncontrolledKWh = hasStoredSplit
      ? this.lastPlannedUncontrolledKWh ?? undefined
      : undefined;
    const plannedControlledKWh = hasStoredSplit
      ? this.lastPlannedControlledKWh ?? undefined
      : undefined;
    return {
      plannedKWh,
      plannedUncontrolledKWh,
      plannedControlledKWh,
      priceData,
      shouldLog,
      planDebug: undefined,
    };
  }

  private rebuildPlan(params: {
    context: DayContext;
    settings: DailyBudgetSettings;
    existingPlan: number[] | null;
    combinedPrices?: CombinedPriceData | null;
    priceOptimizationEnabled: boolean;
    capacityBudgetKWh?: number;
  }): {
    plannedKWh: number[];
    plannedUncontrolledKWh: number[];
    plannedControlledKWh: number[];
    priceData: PriceData;
    planDebug: {
      lockCurrentBucket: boolean;
      shouldLockCurrent: boolean;
      remainingStartIndex: number;
      hasPreviousPlan: boolean;
    };
  } {
    const {
      context,
      settings,
      existingPlan,
      combinedPrices,
      priceOptimizationEnabled,
      capacityBudgetKWh,
    } = params;
    const lockState = resolvePlanLockState({
      context,
      existingPlan,
      lastPlanBucketStartUtcMs: this.state.lastPlanBucketStartUtcMs,
    });
    const profileData = getEffectiveProfileData(this.state, settings, DEFAULT_PROFILE);
    const buildResult = buildPlan({
        bucketStartUtcMs: context.bucketStartUtcMs,
        bucketUsage: context.bucketUsage,
        currentBucketIndex: context.currentBucketIndex,
        usedNowKWh: context.usedNowKWh,
        dailyBudgetKWh: settings.dailyBudgetKWh,
        profileWeights: profileData.combinedWeights,
        profileWeightsControlled: profileData.breakdown.controlled,
        profileWeightsUncontrolled: profileData.breakdown.uncontrolled,
        timeZone: context.timeZone,
        combinedPrices,
        priceOptimizationEnabled,
        priceShapingEnabled: settings.priceShapingEnabled,
        priceShapingFlexShare: settings.priceShapingFlexShare,
        previousPlannedKWh: existingPlan ?? undefined,
        capacityBudgetKWh,
        lockCurrentBucket: lockState.lockCurrentBucket,
        controlledUsageWeight: settings.controlledUsageWeight,
        profileObservedMaxUncontrolledKWh: this.state.profileObservedMaxUncontrolledKWh,
        profileObservedMaxControlledKWh: this.state.profileObservedMaxControlledKWh,
        profileObservedMinUncontrolledKWh: this.state.profileObservedMinUncontrolledKWh,
        profileObservedMinControlledKWh: this.state.profileObservedMinControlledKWh,
      });
    this.state.plannedKWh = buildResult.plannedKWh;
    this.lastPlannedUncontrolledKWh = buildResult.plannedUncontrolledKWh.slice();
    this.lastPlannedControlledKWh = buildResult.plannedControlledKWh.slice();
    this.state.lastPlanBucketStartUtcMs = lockState.currentBucketStartUtcMs;
    this.state.dayStartUtcMs = context.dayStartUtcMs;
    this.lastPlanRebuildMs = context.nowMs;
    this.markDirty();
    return {
      plannedKWh: buildResult.plannedKWh,
      plannedUncontrolledKWh: buildResult.plannedUncontrolledKWh,
      plannedControlledKWh: buildResult.plannedControlledKWh,
      priceData: {
        prices: buildResult.price,
        priceFactors: buildResult.priceFactor,
        priceShapingActive: buildResult.priceShapingActive,
        priceSpreadFactor: buildResult.priceSpreadFactor,
        effectivePriceShapingFlexShare: buildResult.effectivePriceShapingFlexShare,
      },
      planDebug: {
        lockCurrentBucket: lockState.lockCurrentBucket,
        shouldLockCurrent: lockState.shouldLockCurrent,
        remainingStartIndex: lockState.remainingStartIndex,
        hasPreviousPlan: lockState.hasPreviousPlan,
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
      priceShapingFlexShare: settings.priceShapingFlexShare,
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
    const shouldPersist = this.dirty
      && (nowMs - this.lastPersistMs >= DailyBudgetManager.STATE_PERSIST_INTERVAL_MS);
    if (shouldPersist) {
      this.lastPersistMs = nowMs;
      this.dirty = false;
    }
    return shouldPersist;
  }

  getSnapshot(): DailyBudgetDayPayload | null {
    return this.snapshot;
  }

  buildHistory(params: {
    dayStartUtcMs: number;
    timeZone: string;
    powerTracker: PowerTrackerState;
    combinedPrices?: CombinedPriceData | null;
    priceOptimizationEnabled: boolean;
    priceShapingEnabled: boolean;
  }): DailyBudgetDayPayload | null {
    return buildDailyBudgetHistory({
      ...params,
      profileSampleCount: this.state.profile?.sampleCount ?? 0,
    });
  }

  buildPreview(params: {
    dayStartUtcMs: number;
    timeZone: string;
    settings: DailyBudgetSettings;
    combinedPrices?: CombinedPriceData | null;
    priceOptimizationEnabled: boolean;
    capacityBudgetKWh?: number;
  }): DailyBudgetDayPayload {
    const profileResult = ensureDailyBudgetProfile(this.state, DEFAULT_PROFILE);
    if (profileResult.changed) this.markDirty();
    this.state = profileResult.state;
    const { settings } = params;
    const enabled = this.isEnabled(settings);
    const profileData = getEffectiveProfileData(this.state, settings, DEFAULT_PROFILE);
    return buildDailyBudgetPreview({
      ...params,
      enabled,
      priceShapingEnabled: settings.priceShapingEnabled,
      profileWeights: profileData.combinedWeights,
      profileSampleCount: profileData.sampleCount,
      profileSplitSampleCount: getProfileSplitSampleCount(this.state),
      profileBreakdown: profileData.breakdown,
      profileObservedMaxUncontrolledKWh: this.state.profileObservedMaxUncontrolledKWh,
      profileObservedMaxControlledKWh: this.state.profileObservedMaxControlledKWh,
      profileObservedMinUncontrolledKWh: this.state.profileObservedMinUncontrolledKWh,
      profileObservedMinControlledKWh: this.state.profileObservedMinControlledKWh,
    });
  }

  private markDirty(force = false): void { this.dirty = true; if (force) this.lastPersistMs = 0; }
}

export {
  blendProfiles,
  buildAllowedCumKWh,
  buildCompositeWeights,
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
