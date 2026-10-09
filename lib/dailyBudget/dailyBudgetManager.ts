import type { PowerLimitCeiling } from '../../packages/contracts/src/capacitySettings';
import type { PowerTrackerState } from '../power/tracker';
import { buildDefaultProfile, buildPlan, buildPriceDebugData, type CombinedPriceData } from './dailyBudgetMath';
import { buildSnapshotAndLogDebug } from './dailyBudgetManagerSnapshot';
import {
  describePlanningCeiling,
  hasPlanningCeilingMoved,
  resolveExistingPlanState,
  resolvePlanLockState,
  shouldRebuildDailyBudgetPlan,
} from './dailyBudgetManagerPlan';
import { computeAdjacentDaysSeedSignature } from './dailyBudgetSnapshotState';
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
  type DailyBudgetManagerDeps,
  type ExistingPlanState,
  type PlanResult,
  type RebuildPlanDebug,
} from './dailyBudgetManagerTypes';
import { CONTROLLED_USAGE_WEIGHT } from './dailyBudgetConstants';
import { finalizePreviousDayLearning } from './dailyBudgetLearning';
import { resetDailyBudgetLearningState } from './dailyBudgetLearningReset';
import { ensureObservedHourlyStats, resolveObservedGrossBackgroundKwh } from './dailyBudgetObservedStats';
import { resolveObservedHourlyStats } from './observedHourlyStats';
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
  describeClosedDaysHistory,
  resolveConfidence,
} from './dailyBudgetConfidenceCache';
import { resolveDailyBudgetPersistReason } from './dailyBudgetStatePersistence';
import { getLogger } from '../logging/logger';
import { resolveStoredPlanBreakdown, type StoredPlanBreakdown } from './dailyBudgetStoredPlanBreakdown';

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
  /**
   * The price fingerprint the plan was last built on. New prices reshape the
   * remaining hours at the next update rather than waiting for the hour or the
   * interval; a change of price is not a plan-rebuild trigger in its own right
   * (`lib/plan/planRebuildTrigger.ts`), so this is where it takes effect.
   * In memory only: a restart rebuilds the plan anyway.
   */
  private lastPlanPriceSignature: string | null = null;
  /**
   * The planning ceiling the plan was last built on (`describePlanningCeiling`).
   * Toggling a power limit forces a replan, but that replan can read settings
   * that have not caught up yet; comparing on every update replans as soon as the
   * accepted ceiling moves, whoever asked for the update. `null` until a plan is
   * built. In memory only: a restart rebuilds the plan anyway.
   */
  private lastPlanCeilingMark: string | null = null;
  /** The planning ceiling of the latest update: an input of tomorrow's preview. */
  private planningCeilingMark = '';
  private confidenceCache: ConfidenceCache = createConfidenceCache();
  /** `describeClosedDaysHistory` as of the last update. */
  private closedDaysHistoryMark = '';
  /** Bumped whenever the learned model behind the adjacent-day views changes. */
  private learnedModelRevision = 0;

  constructor(private deps: DailyBudgetManagerDeps) { }

  // Topic-gated (`daily_budget`) structured debug for lifecycle events. Falls
  // back to the module logger at debug level when no emitter is wired (tests).
  private emitDebug(payload: Record<string, unknown>): void {
    (this.deps.debugStructured ?? debugFallbackEmit)(payload);
  }
  loadState(state: DailyBudgetState | null): void { if (state !== null) this.state = { ...state }; }
  /** See `resolveObservedGrossBackgroundKwh`. */
  observedGrossBackgroundKwh(hourOfDay: number): number | undefined {
    return resolveObservedGrossBackgroundKwh(this.state, hourOfDay);
  }
  /**
   * Pure read: it copies, and never mutates `this.state`. `maybePersistDailyBudgetState`
   * calls this behind a throttle and skips it entirely when the throttle rejects the
   * write, so an export that memoized, bumped a revision, or lazily materialized an
   * array would silently break that skip path.
   */
  exportState(): DailyBudgetState {
    const state = { ...this.state };
    if (typeof state.profileSampleCount === 'number' && state.profile) state.profile = {
      ...state.profile, sampleCount: state.profileSampleCount,
    };
    return state;
  }
  resetLearning(): void {
    this.state = resetDailyBudgetLearningState(this.state, DEFAULT_PROFILE);
    this.learnedModelRevision += 1;
  }
  /**
   * Changes whenever an input of tomorrow's preview or yesterday's history moves
   * that today's routine update does not otherwise reveal: a past day written
   * after the fact, or a change to the learned model.
   */
  getAdjacentDaysInputsMark(): string {
    return `${this.closedDaysHistoryMark}|${this.learnedModelRevision}|${this.planningCeilingMark}`;
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
      planningCeiling,
      refreshObservedStats = true,
      refreshConfidence = false,
      includeConfidenceBootstrapDebug = false,
      recomputeFrozenPlan = false,
      persistReason,
    } = params;

    const context = buildDayContext({ nowMs, timeZone, powerTracker });
    this.closedDaysHistoryMark = describeClosedDaysHistory(powerTracker, context);
    this.planningCeilingMark = describePlanningCeiling(planningCeiling);
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
      planningCeiling,
    });
    const budget = { ...computeBudgetState({
      context,
      enabled,
      dailyBudgetKWh: settings.dailyBudgetKWh,
      plannedKWh: plan.plannedKWh,
      profileSampleCount: getProfileSampleCount(this.state),
      profileSplitSampleCount: getProfileSplitSampleCount(this.state),
    }) };
    // Bootstrap intervals are debug-only; they ride along whenever the backtest runs.
    const cr = resolveConfidence(
      this.confidenceCache, context, powerTracker, budget.profileBlendConfidence,
      refreshConfidence, includeConfidenceBootstrapDebug,
    );
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
    this.maybeUnfreezeFromDeviation(context, enabled, budgetControlDeviationKWh);
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
      planningCeiling,
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
    this.learnedModelRevision += 1;
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
    planningCeiling: PowerLimitCeiling | null;
  }): PlanResult {
    const { context, enabled } = params;
    const priceSignature = computeAdjacentDaysSeedSignature(context.dateKey, params.combinedPrices ?? null);
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
      pricesChanged: this.lastPlanPriceSignature !== null && priceSignature !== this.lastPlanPriceSignature,
      planningCeilingChanged: hasPlanningCeilingMoved(this.lastPlanCeilingMark, this.planningCeilingMark),
    });
    const shouldLog = enabled && shouldRebuildPlan;

    if (enabled && shouldRebuildPlan) {
      const rebuilt = this.rebuildPlan(params);
      this.lastPlanPriceSignature = priceSignature;
      this.lastPlanCeilingMark = this.planningCeilingMark;
      return { ...rebuilt, shouldLog };
    }

    const priceData = this.resolvePriceData(params);
    const plannedKWh = enabled && this.state.plannedKWh ? this.state.plannedKWh : context.bucketUsage.map(() => 0);
    const storedBreakdown: StoredPlanBreakdown = enabled
      ? this.getStoredPlanBreakdown({
        bucketCount: plannedKWh.length,
        context,
        controlledUsageWeight: params.settings.controlledUsageWeight,
      })
      : { grossBackfilled: false, grossBackfillComplete: false };
    return {
      plannedKWh,
      plannedUncontrolledKWh: storedBreakdown.plannedUncontrolledKWh,
      plannedGrossUncontrolledKWh: storedBreakdown.plannedGrossUncontrolledKWh,
      plannedControlledKWh: storedBreakdown.plannedControlledKWh,
      priceData,
      shouldLog,
      planDebug: undefined,
    };
  }

  private rebuildPlan(params: {
    context: DayContext; settings: DailyBudgetSettings; existingPlan: number[] | null;
    combinedPrices?: CombinedPriceData | null; priceOptimizationEnabled: boolean;
    planningCeiling: PowerLimitCeiling | null;
  }): {
    plannedKWh: number[];
    plannedUncontrolledKWh: number[];
    plannedGrossUncontrolledKWh: number[];
    plannedControlledKWh: number[];
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
      planningCeiling,
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
      previousPlannedGrossUncontrolledKWh: this.state.plannedGrossUncontrolledKWh,
      previousPlannedControlledKWh: this.state.plannedControlledKWh,
      planningCeiling,
      lockCurrentBucket: lockState.lockCurrentBucket,
      controlledUsageWeight: settings.controlledUsageWeight,
      observedStats: resolveObservedHourlyStats(this.state),
    });
    this.state.plannedKWh = buildResult.plannedKWh;
    this.state.plannedUncontrolledKWh = buildResult.plannedUncontrolledKWh.slice();
    this.state.plannedGrossUncontrolledKWh = buildResult.plannedGrossUncontrolledKWh.slice();
    this.state.plannedControlledKWh = buildResult.plannedControlledKWh.slice();
    const previousPlanBucketStartUtcMs = this.state.lastPlanBucketStartUtcMs;
    this.state.lastPlanBucketStartUtcMs = lockState.currentBucketStartUtcMs;
    this.state.dayStartUtcMs = context.dayStartUtcMs;
    this.lastPlanRebuildMs = context.nowMs;
    this.markDirty(previousPlanBucketStartUtcMs === lockState.currentBucketStartUtcMs ? 'plan' : 'bucket');
    return {
      plannedKWh: buildResult.plannedKWh,
      plannedUncontrolledKWh: buildResult.plannedUncontrolledKWh,
      plannedGrossUncontrolledKWh: buildResult.plannedGrossUncontrolledKWh,
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
    this.state.plannedGrossUncontrolledKWh = undefined;
    this.state.plannedControlledKWh = undefined;
  }

  private getStoredPlanBreakdown(params: {
    bucketCount: number;
    context: DayContext;
    controlledUsageWeight: number;
  }): StoredPlanBreakdown {
    const result = resolveStoredPlanBreakdown({ state: this.state, ...params });
    if (result.grossBackfilled && result.grossBackfillComplete && result.plannedGrossUncontrolledKWh) {
      this.state.plannedGrossUncontrolledKWh = result.plannedGrossUncontrolledKWh.slice();
      this.markDirty('plan');
    }
    return result;
  }

  private maybeUpdateObservedStats(
    powerTracker: PowerTrackerState, timeZone: string, nowMs: number,
  ): void {
    const result = ensureObservedHourlyStats({ state: this.state, powerTracker, timeZone, nowMs });
    if (result.changed) {
      this.state = result.nextState;
      this.learnedModelRevision += 1;
      this.markDirty('observed_stats');
      if (result.logEvent) this.emitDebug(result.logEvent);
    }
  }

  private maybeFreezeFromDeviation(enabled: boolean, deviationKWh: number): void {
    if (!enabled || deviationKWh <= 0 || this.state.frozen) return;
    this.state.frozen = true; this.markDirty('frozen');
    this.emitDebug({ event: 'daily_budget_plan_frozen', deviationKWh });
  }

  private maybeUnfreezeFromDeviation(context: DayContext, enabled: boolean, deviationKWh: number): void {
    if (!enabled || deviationKWh > 0 || !this.state.frozen) return;
    this.state.frozen = false;
    // Re-establish the current-hour lock (mirrors `clearFrozenPlanForRecompute`)
    // and reset the rebuild clock: the next update then re-spreads only FUTURE
    // hours. Nulling the lock here used to make that rebuild reallocate the hour
    // in progress from `remaining = budget - used` — collapsing it right after an
    // overrun, and (via the lock going stale across frozen hour transitions) on
    // the first rebuild after a restart. The clock reset is needed because
    // per-sample usage deltas stay below the usage-change rebuild trigger, so the
    // stale frozen plan would otherwise ride until the hourly interval.
    const currentBucketStartUtcMs = context.bucketStartUtcMs[context.currentBucketIndex];
    if (Number.isFinite(currentBucketStartUtcMs)) this.state.lastPlanBucketStartUtcMs = currentBucketStartUtcMs;
    this.lastPlanRebuildMs = 0;
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
    planningCeiling: PowerLimitCeiling | null;
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
    planningCeiling: PowerLimitCeiling | null;
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
      observedStats: resolveObservedHourlyStats(this.state),
    });
  }

  private markDirty(reason: DailyBudgetStatePersistReason): void { this.persistReasons.add(reason); }
}

export { buildDefaultProfile, buildPlan } from './dailyBudgetMath';
export type { CombinedPriceData } from './dailyBudgetMath';
