import type { PowerLimitCeiling } from '../../packages/contracts/src/capacitySettings';
import type { PowerTrackerState } from '../power/tracker';
import { buildDefaultProfile, buildPlan } from './dailyBudgetMath';
import { buildSnapshotAndLogDebug } from './dailyBudgetManagerSnapshot';
import {
  describePlanningCeiling,
  hasPlanningCeilingMoved,
  logDailyBudgetPlanDebug,
  resolveExistingPlanState,
  shouldRebuildDailyBudgetPlan,
} from './dailyBudgetManagerPlan';
import type { BuildPlanResult } from './dailyBudgetPlanCore';
import { buildPriceData, NO_PRICE_DATA, type PriceData } from './dailyBudgetPrices';
import { computeAdjacentDaysSeedSignature } from './dailyBudgetSnapshotState';
import { buildDailyBudgetPreview, buildPreviewDayContext, type DailyBudgetPreview } from './dailyBudgetPreview';
import {
  buildDayContext,
  computeBudgetState,
  computePlanDeviation,
  isDailyBudgetEnabled,
  type DayContext,
} from './dailyBudgetState';
import { buildDailyBudgetHistory } from './dailyBudgetHistory';
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
  type DailyBudgetPlanInputs,
  type ExistingPlanState,
  type PlanResult,
} from './dailyBudgetManagerTypes';
import { finalizePreviousDayLearning } from './dailyBudgetLearning';
import { resetDailyBudgetLearningState } from './dailyBudgetLearningReset';
import { ensureObservedHourlyStats, resolveObservedGrossBackgroundKwh } from './dailyBudgetObservedStats';
import { resolveObservedHourlyStats } from './observedHourlyStats';
import {
  ensureDailyBudgetProfile,
  getEffectiveProfileData,
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
      combinedPrices = null,
      priceOptimizationEnabled,
      planningCeiling,
      refreshObservedStats = true,
      refreshConfidence = false,
      includeConfidenceBootstrapDebug = false,
      recomputeFrozenPlan = false,
      persistReason,
    } = params;

    const context = buildDayContext(nowMs, timeZone, powerTracker);
    this.closedDaysHistoryMark = describeClosedDaysHistory(powerTracker, context);
    this.planningCeilingMark = describePlanningCeiling(planningCeiling);
    if (persistReason) this.markDirty(persistReason);
    const profileResult = ensureDailyBudgetProfile(this.state, DEFAULT_PROFILE);
    if (profileResult.changed) this.markDirty('manual');
    this.state = profileResult.state;
    if (refreshObservedStats) this.maybeUpdateObservedStats(powerTracker, timeZone, context.nowMs);
    this.handleRollover(context, settings, powerTracker);
    const enabled = isDailyBudgetEnabled(settings);
    this.syncEnabledState(enabled);
    const planState = this.preparePlanState(context, enabled, settings.dailyBudgetKWh);
    this.clearFrozenPlanForRecompute(context, enabled, recomputeFrozenPlan);

    // Off, the day carries no prices; on, the plan and the payload read the same ones.
    const priceData = enabled
      ? buildPriceData(context, settings, combinedPrices, priceOptimizationEnabled)
      : NO_PRICE_DATA;
    const plan = this.resolvePlan(context, params, enabled, planState, priceData);
    const budget = { ...computeBudgetState(
      context,
      enabled,
      settings.dailyBudgetKWh,
      plan.plannedKWh,
      getProfileSampleCount(this.state),
      getProfileSplitSampleCount(this.state),
    ) };
    // Bootstrap intervals are debug-only; they ride along whenever the backtest runs.
    const cr = resolveConfidence(
      this.confidenceCache, context, powerTracker, budget.profileBlendConfidence,
      refreshConfidence, includeConfidenceBootstrapDebug,
    );
    budget.confidence = cr.confidence;
    // Freeze/unfreeze follows the controllable budget view rather than raw reported
    // usage so exempt devices can overrun the household budget without reshaping the plan.
    const budgetControlDeviationKWh = computePlanDeviation(
      context,
      enabled,
      plan.plannedKWh,
      settings.dailyBudgetKWh,
      context.budgetControlUsedNowKWh,
    ).deviationKWh;
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
      priceOptimizationEnabled,
    });
    this.snapshot = snapshot;
    this.recordRuntimeState(context);
    return { snapshot, persistReason: this.consumePersistReason() };
  }

  private handleRollover(context: DayContext, settings: DailyBudgetSettings, powerTracker: PowerTrackerState): void {
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

  private preparePlanState(context: DayContext, enabled: boolean, dailyBudgetKWh: number): ExistingPlanState {
    const planStateResult = resolveExistingPlanState(this.state, context, enabled, dailyBudgetKWh);
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

  private resolvePlan(
    context: DayContext,
    params: DailyBudgetUpdateParams,
    enabled: boolean,
    planState: ExistingPlanState,
    priceData: PriceData,
  ): PlanResult {
    const { settings } = params;
    const priceSignature = computeAdjacentDaysSeedSignature(context.dateKey, params.combinedPrices ?? null);
    const shouldRebuildPlan = shouldRebuildDailyBudgetPlan({
      context,
      enabled,
      planStateMismatch: planState.planStateMismatch,
      forcePlanRebuild: params.forcePlanRebuild,
      recomputeFrozenPlan: params.recomputeFrozenPlan,
      frozen: Boolean(this.state.frozen),
      lastPlanBucketStartUtcMs: this.state.lastPlanBucketStartUtcMs,
      lastUsedNowKWh: this.state.lastUsedNowKWh,
      lastPlanRebuildMs: this.lastPlanRebuildMs,
      pricesChanged: this.lastPlanPriceSignature !== null && priceSignature !== this.lastPlanPriceSignature,
      planningCeilingChanged: hasPlanningCeilingMoved(this.lastPlanCeilingMark, this.planningCeilingMark),
    });

    if (enabled && shouldRebuildPlan) {
      const rebuilt = this.rebuildPlan(context, settings, planState.existingPlan, priceData, params.planningCeiling);
      this.lastPlanPriceSignature = priceSignature;
      this.lastPlanCeilingMark = this.planningCeilingMark;
      return { ...rebuilt, priceData };
    }

    const plannedKWh = enabled && this.state.plannedKWh ? this.state.plannedKWh : context.bucketUsage.map(() => 0);
    const storedBreakdown: StoredPlanBreakdown = enabled
      ? this.getStoredPlanBreakdown(plannedKWh.length, context, settings.controlledUsageWeight)
      : { grossBackfilled: false, grossBackfillComplete: false };
    return {
      plannedKWh,
      plannedUncontrolledKWh: storedBreakdown.plannedUncontrolledKWh,
      plannedGrossUncontrolledKWh: storedBreakdown.plannedGrossUncontrolledKWh,
      plannedControlledKWh: storedBreakdown.plannedControlledKWh,
      priceData,
    };
  }

  private rebuildPlan(
    context: DayContext,
    settings: DailyBudgetSettings,
    existingPlan: number[] | null,
    priceData: PriceData,
    planningCeiling: PowerLimitCeiling | null,
  ): BuildPlanResult {
    const plan = buildPlan(
      context,
      settings,
      getEffectiveProfileData(this.state, settings, DEFAULT_PROFILE),
      resolveObservedHourlyStats(this.state),
      // The stored split, gross line and build hour belong to the plan only while it fits this day.
      existingPlan ? { ...this.state, plannedKWh: existingPlan } : null,
      priceData,
      planningCeiling,
    );
    this.state.plannedKWh = plan.plannedKWh;
    this.state.plannedUncontrolledKWh = plan.plannedUncontrolledKWh.slice();
    this.state.plannedGrossUncontrolledKWh = plan.plannedGrossUncontrolledKWh.slice();
    this.state.plannedControlledKWh = plan.plannedControlledKWh.slice();
    const previousPlanBucketStartUtcMs = this.state.lastPlanBucketStartUtcMs;
    const currentBucketStartUtcMs = context.bucketStartUtcMs[context.currentBucketIndex];
    this.state.lastPlanBucketStartUtcMs = currentBucketStartUtcMs;
    this.state.dayStartUtcMs = context.dayStartUtcMs;
    this.lastPlanRebuildMs = context.nowMs;
    this.markDirty(previousPlanBucketStartUtcMs === currentBucketStartUtcMs ? 'plan' : 'bucket');
    return plan;
  }

  private clearStoredPlanBreakdown(): void {
    this.state.plannedUncontrolledKWh = undefined;
    this.state.plannedGrossUncontrolledKWh = undefined;
    this.state.plannedControlledKWh = undefined;
  }

  private getStoredPlanBreakdown(
    bucketCount: number,
    context: DayContext,
    controlledUsageWeight: number,
  ): StoredPlanBreakdown {
    const result = resolveStoredPlanBreakdown(this.state, bucketCount, context, controlledUsageWeight);
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

  buildHistory(
    dayStartUtcMs: number,
    timeZone: string,
    powerTracker: PowerTrackerState,
    settings: DailyBudgetSettings,
    inputs: DailyBudgetPlanInputs,
  ): DailyBudgetDayPayload | null {
    return buildDailyBudgetHistory({
      dayStartUtcMs,
      timeZone,
      powerTracker,
      combinedPrices: inputs.combinedPrices,
      priceShapingEnabled: settings.priceShapingEnabled,
      profileSampleCount: this.state.profile?.sampleCount ?? 0,
      profileBreakdown: getEffectiveProfileData(this.state, settings, DEFAULT_PROFILE).breakdown,
      planningCeiling: inputs.planningCeiling,
    });
  }

  buildPreview(
    dayStartUtcMs: number,
    timeZone: string,
    settings: DailyBudgetSettings,
    inputs: DailyBudgetPlanInputs,
  ): DailyBudgetPreview {
    const profileResult = ensureDailyBudgetProfile(this.state, DEFAULT_PROFILE);
    if (profileResult.changed) this.markDirty('manual');
    this.state = profileResult.state;
    return buildDailyBudgetPreview(
      this.state,
      settings,
      buildPreviewDayContext(dayStartUtcMs, timeZone),
      inputs,
      DEFAULT_PROFILE,
    );
  }

  /**
   * Writes tomorrow's preview to the `daily_budget` debug topic as the `next_day`
   * plan entry. The service calls this when it rebuilds the adjacent days: on a
   * forced update (settings, commands), or when the prices, the learned model,
   * the closed-day history mark or the planning ceiling move, or the day rolls
   * over. The entry therefore follows those rebuilds rather than every rebuild
   * of today's plan, and can repeat unchanged when only today's side moved (a
   * today-only price change, a closed-day mark). `inputs` are the ones `preview`
   * was built on.
   */
  logNextDayPlan(preview: DailyBudgetPreview, settings: DailyBudgetSettings, inputs: DailyBudgetPlanInputs): void {
    if (!isDailyBudgetEnabled(settings) || !(this.deps.isDebugTopicEnabled?.('daily_budget') ?? true)) return;
    logDailyBudgetPlanDebug({
      debugStructured: (payload) => this.emitDebug(payload),
      snapshot: preview.snapshot,
      priceData: preview.priceData,
      priceOptimizationEnabled: inputs.priceOptimizationEnabled,
      planningCeiling: inputs.planningCeiling,
      settings,
      state: this.state,
      defaultProfile: DEFAULT_PROFILE,
      variant: 'next_day',
      bounds: preview.bounds,
    });
  }

  private markDirty(reason: DailyBudgetStatePersistReason): void { this.persistReasons.add(reason); }
}

export { buildDefaultProfile } from './dailyBudgetMath';
