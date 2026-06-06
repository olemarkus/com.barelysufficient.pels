import type { PowerTrackerState } from '../power/tracker';
import { buildDefaultProfile, buildPlan, buildPriceDebugData } from './dailyBudgetMath';
import type { CombinedPriceData } from './dailyBudgetMath';
import { buildSnapshotAndLogDebug } from './dailyBudgetManagerSnapshot';
import {
  resolveExistingPlanState,
  resolvePlanLockState,
  shouldRebuildDailyBudgetPlan,
} from './dailyBudgetManagerPlan';
import { buildDailyBudgetPreview } from './dailyBudgetPreview';
import { buildDayContext, computeBudgetState, computePlanDeviation } from './dailyBudgetState';
import { buildDailyBudgetHistory } from './dailyBudgetHistory';
import type { DayContext, PriceData } from './dailyBudgetState';
import type {
  DailyBudgetDayPayload,
  DailyBudgetSettings,
  DailyBudgetState,
  DailyBudgetStatePersistReason,
  DailyBudgetUpdate,
} from './dailyBudgetTypes';
import {
  type DailyBudgetUpdateParams,
  isDailyBudgetState,
  type DailyBudgetManagerDeps,
  type ExistingPlanState,
  type PlanResult,
  type RebuildPlanDebug,
} from './dailyBudgetManagerTypes';
import { CONTROLLED_USAGE_WEIGHT } from './dailyBudgetConstants';
import { finalizePreviousDayLearning } from './dailyBudgetLearning';
import { ensureObservedHourlyStats } from './dailyBudgetObservedStats';
import {
  ensureDailyBudgetProfile,
  getEffectiveProfileData,
  getProfileBreakdown,
  getProfileSampleCount,
  getProfileSplitSampleCount,
} from './dailyBudgetProfile';
import {
  type ConfidenceCache,
  createConfidenceCache,
  getCachedConfidence,
  resolveConfidence,
} from './dailyBudgetConfidence';
import { resolveDailyBudgetPersistReason } from './dailyBudgetStatePersistence';
import { getLogger } from '../logging/logger';

const DEFAULT_PROFILE = buildDefaultProfile();
const moduleLogger = getLogger('daily_budget');
// Hoisted once so `emitDebug` allocates no per-call closure on the (test-only;
// production always wires `debugStructured`) fallback path.
const debugFallbackEmit = (payload: Record<string, unknown>): void => moduleLogger.debug(payload);

export class DailyBudgetManager {
  private state: DailyBudgetState = {};
  private snapshot: DailyBudgetDayPayload | null = null;
  private persistReasons = new Set<DailyBudgetStatePersistReason>();
  private lastPlanRebuildMs = 0;
  private confidenceCache: ConfidenceCache = createConfidenceCache();

  constructor(private deps: DailyBudgetManagerDeps) { }

  // Topic-gated (`daily_budget`) structured debug for lifecycle events. Falls
  // back to the module logger at debug level when no emitter is wired (tests).
  private emitDebug(payload: Record<string, unknown>): void {
    (this.deps.debugStructured ?? debugFallbackEmit)(payload);
  }
  loadState(raw: unknown): void { if (isDailyBudgetState(raw)) this.state = { ...raw }; }
  exportState(): DailyBudgetState {
    const state = { ...this.state };
    if (typeof state.profileSampleCount === 'number' && state.profile) state.profile = {
      ...state.profile, sampleCount: state.profileSampleCount,
    };
    return state;
  }
  resetLearning(): void {
    this.state.profileUncontrolled = { weights: [...DEFAULT_PROFILE], sampleCount: 0 };
    this.state.profileControlled = { weights: [...DEFAULT_PROFILE], sampleCount: 0 };
    this.state.profileControlledShare = 0;
    this.state.profileSampleCount = 0;
    this.state.profileSplitSampleCount = 0;
    this.state.profileObservedMaxUncontrolledKWh = Array.from({ length: 24 }, () => 0);
    this.state.profileObservedMaxControlledKWh = Array.from({ length: 24 }, () => 0);
    this.state.profileObservedMinUncontrolledKWh = Array.from({ length: 24 }, () => 0);
    this.state.profileObservedMinControlledKWh = Array.from({ length: 24 }, () => 0);
    this.state.profileObservedP50UncontrolledKWh = Array.from({ length: 24 }, () => 0);
    this.state.profileObservedP75UncontrolledKWh = Array.from({ length: 24 }, () => 0);
    this.state.profileObservedP90UncontrolledKWh = Array.from({ length: 24 }, () => 0);
    this.state.profileObservedUncontrolledSampleCounts = Array.from({ length: 24 }, () => 0);
    this.state.profile = undefined;
    this.state.frozen = false;
  }
  update(params: DailyBudgetUpdateParams): DailyBudgetUpdate {
    const {
      nowMs = Date.now(),
      timeZone,
      settings,
      powerTracker,
      combinedPrices,
      priceOptimizationEnabled,
      forcePlanRebuild,
      capacityBudgetKWh,
      refreshObservedStats = true,
      refreshConfidence = false,
      includeConfidenceBootstrapDebug = false,
      recomputeFrozenPlan = false,
      persistReason,
    } = params;

    const context = buildDayContext({ nowMs, timeZone, powerTracker });
    if (persistReason) this.markDirty(persistReason);
    const profileResult = ensureDailyBudgetProfile(this.state, DEFAULT_PROFILE);
    if (profileResult.changed) this.markDirty('manual');
    this.state = profileResult.state;
    if (refreshObservedStats) this.maybeUpdateObservedStats(powerTracker, timeZone, context.nowMs);
    this.handleRollover({ context, settings, powerTracker });
    const enabled = this.isEnabled(settings);
    this.syncEnabledState(enabled);
    const planState = this.preparePlanState({
      context,
      enabled,
      dailyBudgetKWh: settings.dailyBudgetKWh,
    });
    this.clearFrozenPlanForRecompute(context, enabled, recomputeFrozenPlan);

    const plan = this.resolvePlan({
      context,
      settings,
      enabled,
      planStateMismatch: planState.planStateMismatch,
      existingPlan: planState.existingPlan,
      combinedPrices,
      priceOptimizationEnabled,
      forcePlanRebuild,
      recomputeFrozenPlan,
      capacityBudgetKWh,
    });
    const budget = { ...computeBudgetState({
      context,
      enabled,
      dailyBudgetKWh: settings.dailyBudgetKWh,
      plannedKWh: plan.plannedKWh,
      profileSampleCount: getProfileSampleCount(this.state),
      profileSplitSampleCount: getProfileSplitSampleCount(this.state),
    }) };
    const cr = refreshConfidence
      ? resolveConfidence({
        cache: this.confidenceCache, nowMs: context.nowMs, timeZone, powerTracker,
        profileBlendConfidence: budget.profileBlendConfidence,
        dateKey: context.dateKey,
        // Bootstrap confidence intervals are debug-only and should not run on routine updates.
        includeBootstrapDebug: includeConfidenceBootstrapDebug,
      })
      : getCachedConfidence({
        cache: this.confidenceCache,
        profileBlendConfidence: budget.profileBlendConfidence,
      });
    budget.confidence = cr.confidence;
    // Freeze/unfreeze follows the controllable budget view rather than raw reported
    // usage so exempt devices can overrun the household budget without reshaping the plan.
    const budgetControlDeviationKWh = computePlanDeviation({
      enabled,
      plannedKWh: plan.plannedKWh,
      dailyBudgetKWh: settings.dailyBudgetKWh,
      currentBucketIndex: context.currentBucketIndex,
      currentBucketProgress: context.currentBucketProgress,
      usedNowKWh: context.budgetControlUsedNowKWh,
    }).deviationKWh;
    this.maybeFreezeFromDeviation(enabled, budgetControlDeviationKWh);
    this.maybeUnfreezeFromDeviation(enabled, budgetControlDeviationKWh);
    const snapshot = buildSnapshotAndLogDebug({
      deps: this.deps,
      debugStructured: (payload) => this.emitDebug(payload),
      state: this.state,
      settings,
      enabled,
      plan,
      budget,
      context,
      defaultProfile: DEFAULT_PROFILE,
      confidenceDebug: cr.debug,
      capacityBudgetKWh,
      combinedPrices,
      priceOptimizationEnabled,
    });
    this.snapshot = snapshot;
    this.recordRuntimeState(context);
    return { snapshot, persistReason: this.consumePersistReason() };
  }

  private handleRollover(params: {
    context: DayContext;
    settings: DailyBudgetSettings;
    powerTracker: PowerTrackerState;
  }): void {
    const { context, settings, powerTracker } = params;
    if (!this.state.dateKey || this.state.dateKey === context.dateKey || !settings.enabled) return;
    const result = finalizePreviousDayLearning({
      state: this.state,
      timeZone: context.timeZone,
      powerTracker,
      previousDateKey: this.state.dateKey,
      previousDayStartUtcMs: this.state.dayStartUtcMs ?? null,
      defaultProfile: DEFAULT_PROFILE,
      nowMs: context.nowMs,
    });
    if (result.logEvent) this.emitDebug(result.logEvent);
    if (result.shouldMarkDirty) this.markDirty('rollover');
    this.state = result.nextState;
  }

  private isEnabled(settings: DailyBudgetSettings): boolean { return settings.enabled && settings.dailyBudgetKWh > 0; }
  private syncEnabledState(enabled: boolean): void {
    if (!enabled && this.state.frozen) {
      this.state.frozen = false;
      this.markDirty('frozen');
    }
    if (!enabled) this.clearStoredPlanBreakdown();
  }

  private clearFrozenPlanForRecompute(context: DayContext, enabled: boolean, recomputeFrozenPlan: boolean): void {
    if (!enabled || !recomputeFrozenPlan || !this.state.frozen) return;
    const currentBucketStartUtcMs = context.bucketStartUtcMs[context.currentBucketIndex];
    if (Number.isFinite(currentBucketStartUtcMs)) {
      this.state.lastPlanBucketStartUtcMs = currentBucketStartUtcMs;
    }
    this.state.frozen = false;
    this.markDirty('manual');
    this.emitDebug({ event: 'daily_budget_recompute_requested', reason: 'clearing_frozen_plan' });
  }

  private preparePlanState(params: {
    context: DayContext; enabled: boolean; dailyBudgetKWh: number;
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
      this.clearStoredPlanBreakdown();
      this.markDirty('plan');
    }
    const planState = planStateResult.planState;
    if (enabled && planState.existingPlan && !this.state.frozen && planState.deviationExisting > 0) {
      this.state.frozen = true;
      this.markDirty('frozen');
      this.emitDebug({ event: 'daily_budget_plan_frozen', deviationKWh: planState.deviationExisting });
    }
    return planState;
  }

  private resolvePlan(params: {
    context: DayContext; settings: DailyBudgetSettings; enabled: boolean; planStateMismatch: boolean;
    existingPlan: number[] | null; combinedPrices?: CombinedPriceData | null;
    priceOptimizationEnabled: boolean; forcePlanRebuild?: boolean; recomputeFrozenPlan?: boolean;
    capacityBudgetKWh?: number;
  }): PlanResult {
    const { context, enabled } = params;
    const shouldRebuildPlan = shouldRebuildDailyBudgetPlan({
      context,
      enabled,
      planStateMismatch: params.planStateMismatch,
      forcePlanRebuild: params.forcePlanRebuild,
      recomputeFrozenPlan: params.recomputeFrozenPlan,
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
        uncontrolledReserveDiagnostics: rebuilt.uncontrolledReserveDiagnostics,
      };
    }

    const priceData = this.resolvePriceData(params);
    const plannedKWh = enabled && this.state.plannedKWh ? this.state.plannedKWh : context.bucketUsage.map(() => 0);
    const storedBreakdown = enabled ? this.getStoredPlanBreakdown(plannedKWh.length) : {};
    return {
      plannedKWh,
      plannedUncontrolledKWh: storedBreakdown.plannedUncontrolledKWh,
      plannedControlledKWh: storedBreakdown.plannedControlledKWh,
      priceData,
      shouldLog,
      planDebug: undefined,
    };
  }

  private rebuildPlan(params: {
    context: DayContext; settings: DailyBudgetSettings; existingPlan: number[] | null;
    combinedPrices?: CombinedPriceData | null; priceOptimizationEnabled: boolean;
    capacityBudgetKWh?: number;
  }): {
    plannedKWh: number[]; plannedUncontrolledKWh: number[]; plannedControlledKWh: number[];
    priceData: PriceData;
    planDebug: RebuildPlanDebug;
    uncontrolledReserveDiagnostics: ReturnType<typeof buildPlan>['uncontrolledReserveDiagnostics'];
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
      bucketUsage: context.budgetControlBucketUsage,
      currentBucketIndex: context.currentBucketIndex,
      usedNowKWh: context.budgetControlUsedNowKWh,
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
      previousPlannedUncontrolledKWh: this.state.plannedUncontrolledKWh,
      previousPlannedControlledKWh: this.state.plannedControlledKWh,
      capacityBudgetKWh,
      lockCurrentBucket: lockState.lockCurrentBucket,
      controlledUsageWeight: settings.controlledUsageWeight,
      profileObservedMaxUncontrolledKWh: this.state.profileObservedMaxUncontrolledKWh,
      profileObservedMaxControlledKWh: this.state.profileObservedMaxControlledKWh,
      profileObservedMinUncontrolledKWh: this.state.profileObservedMinUncontrolledKWh,
      profileObservedMinControlledKWh: this.state.profileObservedMinControlledKWh,
      profileObservedP50UncontrolledKWh: this.state.profileObservedP50UncontrolledKWh,
      profileObservedP75UncontrolledKWh: this.state.profileObservedP75UncontrolledKWh,
      profileObservedP90UncontrolledKWh: this.state.profileObservedP90UncontrolledKWh,
      profileObservedUncontrolledSampleCounts: this.state.profileObservedUncontrolledSampleCounts,
    });
    this.state.plannedKWh = buildResult.plannedKWh;
    this.state.plannedUncontrolledKWh = buildResult.plannedUncontrolledKWh.slice();
    this.state.plannedControlledKWh = buildResult.plannedControlledKWh.slice();
    const previousPlanBucketStartUtcMs = this.state.lastPlanBucketStartUtcMs;
    this.state.lastPlanBucketStartUtcMs = lockState.currentBucketStartUtcMs;
    this.state.dayStartUtcMs = context.dayStartUtcMs;
    this.lastPlanRebuildMs = context.nowMs;
    this.markDirty(previousPlanBucketStartUtcMs === lockState.currentBucketStartUtcMs ? 'plan' : 'bucket');
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
      uncontrolledReserveDiagnostics: buildResult.uncontrolledReserveDiagnostics,
    };
  }

  private resolvePriceData(params: {
    context: DayContext; settings: DailyBudgetSettings; enabled: boolean;
    combinedPrices?: CombinedPriceData | null; priceOptimizationEnabled: boolean;
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

  private clearStoredPlanBreakdown(): void {
    this.state.plannedUncontrolledKWh = undefined;
    this.state.plannedControlledKWh = undefined;
  }

  private getStoredPlanBreakdown(bucketCount: number): {
    plannedUncontrolledKWh?: number[]; plannedControlledKWh?: number[];
  } {
    const { plannedUncontrolledKWh, plannedControlledKWh } = this.state;
    const hasStoredSplit = Array.isArray(plannedUncontrolledKWh)
      && Array.isArray(plannedControlledKWh)
      && plannedUncontrolledKWh.length === bucketCount
      && plannedControlledKWh.length === bucketCount;
    if (!hasStoredSplit) return {};
    return { plannedUncontrolledKWh, plannedControlledKWh };
  }

  private maybeUpdateObservedStats(
    powerTracker: PowerTrackerState, timeZone: string, nowMs: number,
  ): void {
    const result = ensureObservedHourlyStats({ state: this.state, powerTracker, timeZone, nowMs });
    if (result.changed) {
      this.state = result.nextState;
      this.markDirty('observed_stats');
      if (result.logEvent) this.emitDebug(result.logEvent);
    }
  }

  private maybeFreezeFromDeviation(enabled: boolean, deviationKWh: number): void {
    if (!enabled || deviationKWh <= 0 || this.state.frozen) return;
    this.state.frozen = true; this.markDirty('frozen');
    this.emitDebug({ event: 'daily_budget_plan_frozen', deviationKWh });
  }

  private maybeUnfreezeFromDeviation(enabled: boolean, deviationKWh: number): void {
    if (!enabled || deviationKWh > 0 || !this.state.frozen) return;
    this.state.frozen = false;
    this.state.lastPlanBucketStartUtcMs = null;
    this.markDirty('frozen');
    this.emitDebug({ event: 'daily_budget_plan_unfrozen', deviationKWh });
  }

  private consumePersistReason(): DailyBudgetStatePersistReason | null {
    const reason = resolveDailyBudgetPersistReason(this.persistReasons);
    this.persistReasons.clear(); return reason;
  }

  private recordRuntimeState(context: DayContext): void {
    this.state.dateKey = context.dateKey;
    this.state.dayStartUtcMs = context.dayStartUtcMs;
    this.state.lastUsedNowKWh = context.budgetControlUsedNowKWh;
    this.markDirty('runtime');
  }

  getSnapshot(): DailyBudgetDayPayload | null {
    return this.snapshot;
  }

  buildHistory(params: {
    dayStartUtcMs: number; timeZone: string; powerTracker: PowerTrackerState;
    combinedPrices?: CombinedPriceData | null; priceOptimizationEnabled: boolean;
    priceShapingEnabled: boolean; controlledUsageWeight?: number;
  }): DailyBudgetDayPayload | null {
    const profileBreakdown = getProfileBreakdown(
      this.state,
      params.controlledUsageWeight ?? CONTROLLED_USAGE_WEIGHT,
      DEFAULT_PROFILE,
    );
    return buildDailyBudgetHistory({
      ...params,
      profileSampleCount: this.state.profile?.sampleCount ?? 0,
      profileBreakdown,
    });
  }

  buildPreview(params: {
    dayStartUtcMs: number; timeZone: string; settings: DailyBudgetSettings;
    combinedPrices?: CombinedPriceData | null; priceOptimizationEnabled: boolean;
    capacityBudgetKWh?: number;
  }): DailyBudgetDayPayload {
    const profileResult = ensureDailyBudgetProfile(this.state, DEFAULT_PROFILE);
    if (profileResult.changed) this.markDirty('manual');
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
      profileObservedP50UncontrolledKWh: this.state.profileObservedP50UncontrolledKWh,
      profileObservedP75UncontrolledKWh: this.state.profileObservedP75UncontrolledKWh,
      profileObservedP90UncontrolledKWh: this.state.profileObservedP90UncontrolledKWh,
      profileObservedUncontrolledSampleCounts: this.state.profileObservedUncontrolledSampleCounts,
    });
  }

  private markDirty(reason: DailyBudgetStatePersistReason): void { this.persistReasons.add(reason); }
}

export { buildDefaultProfile, buildPlan, buildPriceDebugData } from './dailyBudgetMath';
export type { CombinedPriceData } from './dailyBudgetMath';
