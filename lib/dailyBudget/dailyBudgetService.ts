/* eslint-disable max-lines -- daily budget service keeps day/state/forecast in one flow. */
import type Homey from 'homey';
import type { PowerTrackerState } from '../power/tracker';
import { isFiniteNumber } from '../utils/appTypeGuards';
import {
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
  shiftDateKey,
} from '../utils/dateUtils';
import { readCombinedPriceData } from '../price/priceStore';
import {
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
  DAILY_BUDGET_STATE,
  DEBUG_LOGGING_TOPICS,
} from '../utils/settingsKeys';
import {
  MAX_DAILY_BUDGET_KWH,
  MIN_DAILY_BUDGET_KWH,
  PRICE_FLEX_HIGH,
  PRICE_FLEX_HIGH_THRESHOLD,
  PRICE_FLEX_LOW,
  PRICE_FLEX_MEDIUM,
  PRICE_SHAPING_FLEX_SHARE,
  UNMANAGED_RESERVE_CONSERVATIVE_MODE,
  UNMANAGED_RESERVE_MODE,
} from './dailyBudgetConstants';
import { DailyBudgetManager } from './dailyBudgetManager';
import type { CombinedPriceData } from './dailyBudgetManager';
import { composeHotPathDailyBudgetSnapshot, computeAdjacentDaysSeedSignature } from './dailyBudgetSnapshotState';
import {
  DailyBudgetStatePersistencePolicy,
  maybePersistDailyBudgetState,
  persistDailyBudgetState,
} from './dailyBudgetStatePersistence';
import type {
  DailyBudgetDayPayload,
  DailyBudgetModelPreviewResponse,
  DailyBudgetSettings,
  DailyBudgetSettingsInput,
  DailyBudgetStatePersistReason,
  DailyBudgetUiPayload,
} from './dailyBudgetTypes';
import { incPerfCounter } from '../utils/perfCounters';
import { recordOpDuration, safeRss } from '../utils/opRssTracker';
import { startRuntimeSpan } from '../utils/runtimeTrace';
import { normalizeDebugLoggingTopics } from '../../packages/shared-domain/src/utils/debugLogging';
import { normalizeError } from '../utils/errorUtils';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import { getLogger } from '../logging/logger';
import { resolveUsableCapacityKw } from '../power/capacityModel';

const moduleLogger = getLogger('dailyBudget/service');

type DailyBudgetServiceDeps = {
  homey: Homey.App['homey'];
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  isDebugTopicEnabled?: (topic: 'daily_budget') => boolean;
  error: (...args: unknown[]) => void;
  getPowerTracker: () => PowerTrackerState;
  getPriceOptimizationEnabled: () => boolean;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  requestPriceRefetch: () => void;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
};

type BudgetLogState = {
  enabled: boolean;
  dailyBudgetKWh: number;
  exceeded: boolean;
};

export type DailyBudgetPeriodicStatusFields = {
  event: 'daily_budget_periodic_status';
  originalBudgetKWh: number;
  currentBudgetKWh: number;
  actualKWh: number;
  budgetedKWh: number;
  remainingOriginalKWh: number;
  remainingCurrentKWh: number;
  exceeded: boolean;
};

const normalizeUnmanagedReserveMode = (value: unknown): number => {
  if (!isFiniteNumber(value)) return UNMANAGED_RESERVE_MODE;
  return value >= 0.5 ? UNMANAGED_RESERVE_CONSERVATIVE_MODE : UNMANAGED_RESERVE_MODE;
};

const normalizePriceFlexShare = (value: unknown): number => {
  if (!isFiniteNumber(value)) return PRICE_SHAPING_FLEX_SHARE;
  const bounded = Math.min(1, Math.max(0, value));
  if (bounded <= PRICE_FLEX_LOW) return PRICE_FLEX_LOW;
  if (bounded > PRICE_FLEX_HIGH_THRESHOLD) return PRICE_FLEX_HIGH;
  return PRICE_FLEX_MEDIUM;
};

export class DailyBudgetService {
  private manager: DailyBudgetManager;
  private settings: DailyBudgetSettings = {
    enabled: false,
    dailyBudgetKWh: 0,
    priceShapingEnabled: true,
    controlledUsageWeight: UNMANAGED_RESERVE_MODE,
    priceShapingFlexShare: PRICE_SHAPING_FLEX_SHARE,
  };
  private snapshot: DailyBudgetUiPayload | null = null;
  private daySnapshots: Record<string, DailyBudgetDayPayload> = {};
  private adjacentDaysSeedSignature: string | null = null;
  private lastBudgetLogState: BudgetLogState | null = null;
  private persistencePolicy = new DailyBudgetStatePersistencePolicy();

  constructor(private deps: DailyBudgetServiceDeps) {
    this.manager = new DailyBudgetManager({
      log: (...args: unknown[]) => this.deps.log(...args),
      logDebug: (...args: unknown[]) => this.deps.logDebug(...args),
      isDebugTopicEnabled: (topic) => this.deps.isDebugTopicEnabled?.(topic) ?? true,
      structuredDebug: (payload: Record<string, unknown>) => this.emitStructuredDailyBudgetDebug(payload),
      debugStructured: this.deps.debugStructured,
    });
  }

  loadSettings(): void {
    const enabled = this.deps.homey.settings.get(DAILY_BUDGET_ENABLED) as unknown;
    const budgetKWh = this.deps.homey.settings.get(DAILY_BUDGET_KWH) as unknown;
    const priceShapingEnabled = this.deps.homey.settings.get(DAILY_BUDGET_PRICE_SHAPING_ENABLED) as unknown;
    const controlledWeight = this.deps.homey.settings.get(DAILY_BUDGET_CONTROLLED_WEIGHT) as unknown;
    const priceFlexShare = this.deps.homey.settings.get(DAILY_BUDGET_PRICE_FLEX_SHARE) as unknown;
    const rawBudget = isFiniteNumber(budgetKWh) ? Math.max(0, budgetKWh) : 0;
    const boundedBudget = rawBudget === 0
      ? 0
      : Math.min(MAX_DAILY_BUDGET_KWH, Math.max(MIN_DAILY_BUDGET_KWH, rawBudget));
    this.settings = {
      enabled: enabled === true,
      dailyBudgetKWh: boundedBudget,
      priceShapingEnabled: priceShapingEnabled !== false,
      controlledUsageWeight: normalizeUnmanagedReserveMode(controlledWeight),
      priceShapingFlexShare: normalizePriceFlexShare(priceFlexShare),
    };
  }

  loadState(): void {
    this.manager.loadState(this.deps.homey.settings.get(DAILY_BUDGET_STATE));
    this.persistencePolicy.initialize(this.manager.exportState());
  }

  private logError(message: string, error: unknown): void {
    this.deps.error(message, normalizeError(error));
  }

  private createManagerClone(): DailyBudgetManager {
    const manager = new DailyBudgetManager({
      log: (...args: unknown[]) => this.deps.log(...args),
      logDebug: (...args: unknown[]) => this.deps.logDebug(...args),
      isDebugTopicEnabled: (topic) => this.deps.isDebugTopicEnabled?.(topic) ?? true,
      structuredDebug: (payload: Record<string, unknown>) => this.emitStructuredDailyBudgetDebug(payload),
      debugStructured: this.deps.debugStructured,
    });
    manager.loadState(this.manager.exportState());
    return manager;
  }

  private resolveSettingsInput(input: DailyBudgetSettingsInput): DailyBudgetSettings {
    const enabled = typeof input.enabled === 'boolean' ? input.enabled : this.settings.enabled;
    const rawBudget = isFiniteNumber(input.dailyBudgetKWh)
      ? Math.max(0, input.dailyBudgetKWh)
      : this.settings.dailyBudgetKWh;
    if (enabled && (rawBudget < MIN_DAILY_BUDGET_KWH || rawBudget > MAX_DAILY_BUDGET_KWH)) {
      throw new Error(`Daily budget must be between ${MIN_DAILY_BUDGET_KWH} and ${MAX_DAILY_BUDGET_KWH} kWh.`);
    }
    const boundedBudget = rawBudget === 0
      ? 0
      : Math.min(MAX_DAILY_BUDGET_KWH, Math.max(MIN_DAILY_BUDGET_KWH, rawBudget));
    const controlledUsageWeight = isFiniteNumber(input.controlledUsageWeight)
      ? Math.min(1, Math.max(0, input.controlledUsageWeight))
      : this.settings.controlledUsageWeight;
    const priceShapingFlexShare = isFiniteNumber(input.priceShapingFlexShare)
      ? Math.min(1, Math.max(0, input.priceShapingFlexShare))
      : this.settings.priceShapingFlexShare;
    return {
      enabled,
      dailyBudgetKWh: boundedBudget,
      priceShapingEnabled: typeof input.priceShapingEnabled === 'boolean'
        ? input.priceShapingEnabled
        : this.settings.priceShapingEnabled,
      controlledUsageWeight,
      priceShapingFlexShare,
    };
  }

  private persistSettings(settings: DailyBudgetSettings): void {
    this.deps.homey.settings.set(DAILY_BUDGET_ENABLED, settings.enabled);
    this.deps.homey.settings.set(DAILY_BUDGET_KWH, settings.dailyBudgetKWh);
    this.deps.homey.settings.set(DAILY_BUDGET_PRICE_SHAPING_ENABLED, settings.priceShapingEnabled);
    this.deps.homey.settings.set(DAILY_BUDGET_CONTROLLED_WEIGHT, settings.controlledUsageWeight);
    this.deps.homey.settings.set(DAILY_BUDGET_PRICE_FLEX_SHARE, settings.priceShapingFlexShare);
  }

  private get priceStoreDeps() {
    return { homey: this.deps.homey, requestRefetch: this.deps.requestPriceRefetch };
  }
  private resolveTimeZone(): string {
    try {
      const tz = this.deps.homey.clock?.getTimezone?.();
      if (typeof tz === 'string' && tz.trim()) return tz;
    } catch (error) {
      this.logError('Daily budget: failed to read timezone', error);
    }
    return 'Europe/Oslo';
  }

  updateState(params: {
    nowMs?: number;
    forcePlanRebuild?: boolean;
    includeAdjacentDays?: boolean;
    refreshObservedStats?: boolean;
    refreshConfidence?: boolean;
    includeConfidenceBootstrapDebug?: boolean;
    emitStructuredEvent?: boolean;
    recomputeFrozenPlan?: boolean;
    persistReason?: DailyBudgetStatePersistReason;
  } = {}): void {
    const stopSpan = startRuntimeSpan('daily_budget_update');
    const start = Date.now();
    const updateRssBefore = safeRss();
    const nowMs = params.nowMs ?? Date.now();
    const includeAdjacentDays = params.includeAdjacentDays === true;
    const timeZone = this.resolveTimeZone();
    const combinedPrices = readCombinedPriceData(this.priceStoreDeps, new Date(nowMs), timeZone);
    const capacity = this.deps.getCapacitySettings();
    const capacityBudgetKWh = resolveUsableCapacityKw(capacity);
    try {
      const computeStart = Date.now();
      const computeRssBefore = safeRss();
      const update = this.manager.update({
        nowMs,
        timeZone,
        settings: this.settings,
        powerTracker: this.deps.getPowerTracker(),
        combinedPrices,
        priceOptimizationEnabled: this.deps.getPriceOptimizationEnabled(),
        forcePlanRebuild: params.forcePlanRebuild,
        capacityBudgetKWh,
        refreshObservedStats: params.refreshObservedStats,
        refreshConfidence: params.refreshConfidence,
        includeConfidenceBootstrapDebug: params.includeConfidenceBootstrapDebug,
        recomputeFrozenPlan: params.recomputeFrozenPlan,
        persistReason: params.persistReason,
      });
      incPerfCounter('daily_budget_compute_total');
      recordOpDuration('daily_budget_compute_ms', computeStart, computeRssBefore);
      this.setDaySnapshot(update.snapshot, nowMs, combinedPrices, includeAdjacentDays);
      const snap = update.snapshot;
      if (params.emitStructuredEvent !== false && this.shouldEmitBudgetRecomputed(snap)) {
        (this.deps.structuredLog ?? moduleLogger).info({
          event: 'budget_recomputed',
          newBudgetKWh: snap.budget.dailyBudgetKWh,
          actualKWh: snap.state.usedNowKWh,
          remainingNewKWh: snap.state.remainingKWh,
          exceeded: snap.state.exceeded,
        });
      }
      if (update.persistReason) this.maybePersistState(update.persistReason, nowMs);
    } catch (error) {
      this.logError('Daily budget: failed to update state', error);
    } finally {
      stopSpan();
      incPerfCounter('daily_budget_update_total');
      recordOpDuration('daily_budget_update_ms', start, updateRssBefore);
    }
  }

  private maybePersistState(reason: DailyBudgetStatePersistReason, nowMs: number): void {
    maybePersistDailyBudgetState({
      settings: this.deps.homey.settings, policy: this.persistencePolicy,
      state: this.manager.exportState(), reason, nowMs,
    });
  }

  persistState(reason: DailyBudgetStatePersistReason = 'manual', nowMs = Date.now()): void {
    persistDailyBudgetState({
      settings: this.deps.homey.settings, policy: this.persistencePolicy,
      state: this.manager.exportState(), reason, nowMs,
    });
  }

  resetLearning(): void { this.manager.resetLearning(); this.persistState('reset'); }

  private buildTomorrowPreview(
    nowMs: number,
    manager: DailyBudgetManager = this.manager,
    settings: DailyBudgetSettings = this.settings,
  ): DailyBudgetDayPayload | null {
    try {
      const timeZone = this.resolveTimeZone();
      const todayKey = getDateKeyInTimeZone(new Date(nowMs), timeZone);
      const todayStartUtcMs = getDateKeyStartMs(todayKey, timeZone);
      const tomorrowStartUtcMs = getNextLocalDayStartUtcMs(todayStartUtcMs, timeZone);
      const combinedPrices = readCombinedPriceData(this.priceStoreDeps, new Date(nowMs), timeZone);
      const capacity = this.deps.getCapacitySettings();
      const capacityBudgetKWh = resolveUsableCapacityKw(capacity);
      return manager.buildPreview({
        dayStartUtcMs: tomorrowStartUtcMs,
        timeZone,
        settings,
        combinedPrices,
        priceOptimizationEnabled: this.deps.getPriceOptimizationEnabled(),
        capacityBudgetKWh,
      });
    } catch (error) {
      this.logError('Daily budget: failed to build tomorrow preview', error);
      return null;
    }
  }

  private buildYesterdayHistory(nowMs: number): DailyBudgetDayPayload | null {
    const context = this.resolveYesterdayContext(nowMs);
    if (!context) return null;
    const { timeZone, yesterdayStartUtcMs } = context;
    try {
      const combinedPrices = readCombinedPriceData(this.priceStoreDeps, new Date(nowMs), timeZone);
      return this.manager.buildHistory({
        dayStartUtcMs: yesterdayStartUtcMs,
        timeZone,
        powerTracker: this.deps.getPowerTracker(),
        combinedPrices,
        priceOptimizationEnabled: this.deps.getPriceOptimizationEnabled(),
        priceShapingEnabled: this.settings.priceShapingEnabled,
        controlledUsageWeight: this.settings.controlledUsageWeight,
      });
    } catch (error) {
      this.logError('Daily budget: failed to build yesterday history', error);
      return null;
    }
  }

  private resolveYesterdayContext(nowMs: number): { timeZone: string; yesterdayStartUtcMs: number } | null {
    try {
      const timeZone = this.resolveTimeZone();
      const todayKey = getDateKeyInTimeZone(new Date(nowMs), timeZone);
      const yesterdayKey = shiftDateKey(todayKey, -1);
      const yesterdayStartUtcMs = getDateKeyStartMs(yesterdayKey, timeZone);
      return { timeZone, yesterdayStartUtcMs };
    } catch (error) {
      this.logError('Daily budget: failed to resolve yesterday date', error);
      return null;
    }
  }

  getSnapshot(): DailyBudgetUiPayload | null { return this.snapshot; }

  private shouldEmitBudgetRecomputed(snapshot: DailyBudgetDayPayload): boolean {
    const nextState: BudgetLogState = {
      enabled: snapshot.budget.enabled,
      dailyBudgetKWh: snapshot.budget.dailyBudgetKWh,
      exceeded: snapshot.state.exceeded,
    };
    const previous = this.lastBudgetLogState;
    this.lastBudgetLogState = nextState;
    if (!previous) return true;
    return previous.enabled !== nextState.enabled
      || previous.dailyBudgetKWh !== nextState.dailyBudgetKWh
      || previous.exceeded !== nextState.exceeded;
  }

  private shouldIncludeConfidenceBootstrapDebug(): boolean {
    if (this.deps.homey.settings.get('debug_logging_enabled') === true) return true;
    const rawTopics = this.deps.homey.settings.get(DEBUG_LOGGING_TOPICS) as unknown;
    return normalizeDebugLoggingTopics(rawTopics).includes('daily_budget');
  }

  private emitStructuredDailyBudgetDebug(payload: Record<string, unknown>): void {
    if (!this.shouldIncludeConfidenceBootstrapDebug()) return;
    (this.deps.structuredLog ?? moduleLogger).info({
      ...payload,
      debugTopic: 'daily_budget',
    });
  }

  getPeriodicStatusFields(): DailyBudgetPeriodicStatusFields | null {
    const nowMs = Date.now();
    this.updateState({ nowMs, forcePlanRebuild: false, emitStructuredEvent: false });
    const snapshot = this.getTodaySnapshot();
    if (!snapshot || !snapshot.budget.enabled) return null;
    const plannedKWh = snapshot.buckets?.plannedKWh ?? [];
    const currentIndex = snapshot.currentBucketIndex ?? 0;
    const plannedNow = plannedKWh[currentIndex] ?? 0;
    const actualNow = snapshot.buckets?.actualKWh?.[currentIndex];
    const currentUsage = typeof actualNow === 'number' && Number.isFinite(actualNow) ? actualNow : 0;
    const plannedRemaining = plannedKWh
      .slice(currentIndex + 1)
      .reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0)
      + Math.max(0, plannedNow - currentUsage);
    const originalBudget = snapshot.budget.dailyBudgetKWh;
    const usedNow = snapshot.state.usedNowKWh;
    const allowedNow = snapshot.state.allowedNowKWh;
    const currentBudget = usedNow + plannedRemaining;
    const remainingOriginal = originalBudget - usedNow;
    const remainingNew = plannedRemaining;
    return {
      event: 'daily_budget_periodic_status',
      originalBudgetKWh: originalBudget,
      currentBudgetKWh: currentBudget,
      actualKWh: usedNow,
      budgetedKWh: allowedNow,
      remainingOriginalKWh: remainingOriginal,
      remainingCurrentKWh: remainingNew,
      exceeded: snapshot.state.exceeded,
    };
  }

  getPeriodicStatusLog(): string | null {
    const fields = this.getPeriodicStatusFields();
    if (!fields) return null;
    return (
      `Daily budget: original=${fields.originalBudgetKWh.toFixed(2)}kWh, `
      + `current=${fields.currentBudgetKWh.toFixed(2)}kWh, `
      + `actual=${fields.actualKWh.toFixed(2)}kWh, `
      + `budgeted=${fields.budgetedKWh.toFixed(2)}kWh, `
      + `remaining(original)=${fields.remainingOriginalKWh.toFixed(2)}kWh, `
      + `remaining(new)=${fields.remainingCurrentKWh.toFixed(2)}kWh`
    );
  }

  getUiPayload(): DailyBudgetUiPayload | null {
    const nowMs = Date.now();
    this.updateState({
      nowMs,
      forcePlanRebuild: false,
      includeAdjacentDays: true,
      refreshConfidence: true,
      includeConfidenceBootstrapDebug: this.shouldIncludeConfidenceBootstrapDebug(),
    });
    if (!this.snapshot) return null;
    return this.snapshot;
  }

  recomputeTodayPlan(): DailyBudgetUiPayload | null {
    const nowMs = Date.now();
    this.updateState({
      nowMs,
      forcePlanRebuild: true,
      recomputeFrozenPlan: true,
      includeAdjacentDays: true,
      refreshConfidence: true,
      includeConfidenceBootstrapDebug: this.shouldIncludeConfidenceBootstrapDebug(),
      persistReason: 'manual',
    });
    return this.snapshot;
  }

  previewModelSettings(input: DailyBudgetSettingsInput): DailyBudgetModelPreviewResponse {
    const nowMs = Date.now();
    const settings = this.resolveSettingsInput(input);
    const active = this.snapshot;
    const manager = this.createManagerClone();
    const timeZone = this.resolveTimeZone();
    const combinedPrices = readCombinedPriceData(this.priceStoreDeps, new Date(nowMs), timeZone);
    const capacity = this.deps.getCapacitySettings();
    const capacityBudgetKWh = resolveUsableCapacityKw(capacity);
    const update = manager.update({
      nowMs,
      timeZone,
      settings,
      powerTracker: this.deps.getPowerTracker(),
      combinedPrices,
      priceOptimizationEnabled: this.deps.getPriceOptimizationEnabled(),
      forcePlanRebuild: true,
      recomputeFrozenPlan: true,
      capacityBudgetKWh,
      refreshObservedStats: false,
      refreshConfidence: true,
      includeConfidenceBootstrapDebug: this.shouldIncludeConfidenceBootstrapDebug(),
    });
    const tomorrowSnapshot = this.applyOverallModelConfidence(
      this.buildTomorrowPreview(nowMs, manager, settings),
      update.snapshot,
    );
    const candidate: DailyBudgetUiPayload = {
      days: {
        [update.snapshot.dateKey]: update.snapshot,
        ...(tomorrowSnapshot ? { [tomorrowSnapshot.dateKey]: tomorrowSnapshot } : {}),
      },
      todayKey: update.snapshot.dateKey,
      tomorrowKey: tomorrowSnapshot?.dateKey ?? null,
      yesterdayKey: null,
    };
    return { active, candidate, settings };
  }

  applyModelSettings(input: DailyBudgetSettingsInput): DailyBudgetUiPayload | null {
    const settings = this.resolveSettingsInput(input);
    this.persistSettings(settings);
    this.settings = settings;
    return this.recomputeTodayPlan();
  }

  private applyOverallModelConfidence(
    snapshot: DailyBudgetDayPayload | null,
    reference: DailyBudgetDayPayload,
  ): DailyBudgetDayPayload | null {
    if (!snapshot) return null;
    // Confidence represents the model quality as a whole, not a per-day forecast delta.
    return {
      ...snapshot,
      state: {
        ...snapshot.state,
        confidence: reference.state.confidence,
        confidenceDebug: reference.state.confidenceDebug,
      },
    };
  }

  // Hot-path compose preserves cached tomorrow but never seeds it. Rebuild
  // adjacent days whenever the seed signature changes so fresh start, price
  // reload, and date rollover all surface tomorrow to the deferred-objective
  // policyHorizon — see `computeAdjacentDaysSeedSignature`.
  private setDaySnapshot(snap: DailyBudgetDayPayload, nowMs: number,
    prices: CombinedPriceData | null, includeAdjacentDays = false): void {
    const seedSignature = computeAdjacentDaysSeedSignature(snap.dateKey, prices);
    if (includeAdjacentDays || seedSignature !== this.adjacentDaysSeedSignature) {
      this.adjacentDaysSeedSignature = seedSignature;
      this.rebuildSnapshotWithAdjacentDays(snap, nowMs);
      return;
    }
    ({ daySnapshots: this.daySnapshots, snapshot: this.snapshot }
      = composeHotPathDailyBudgetSnapshot(snap, this.snapshot));
  }

  private rebuildSnapshotWithAdjacentDays(snapshot: DailyBudgetDayPayload, nowMs: number): void {
    const todayKey = snapshot.dateKey;
    const tomorrowSnapshot = this.applyOverallModelConfidence(this.buildTomorrowPreview(nowMs), snapshot);
    const yesterdaySnapshot = this.applyOverallModelConfidence(this.buildYesterdayHistory(nowMs), snapshot);
    this.daySnapshots = {
      [todayKey]: snapshot,
      ...(tomorrowSnapshot ? { [tomorrowSnapshot.dateKey]: tomorrowSnapshot } : {}),
      ...(yesterdaySnapshot ? { [yesterdaySnapshot.dateKey]: yesterdaySnapshot } : {}),
    };
    this.snapshot = {
      days: { ...this.daySnapshots },
      todayKey,
      tomorrowKey: tomorrowSnapshot?.dateKey ?? null,
      yesterdayKey: yesterdaySnapshot?.dateKey ?? null,
    };
  }

  private getTodaySnapshot(): DailyBudgetDayPayload | null {
    if (!this.snapshot) return null;
    return this.snapshot.days[this.snapshot.todayKey] ?? null;
  }
}
