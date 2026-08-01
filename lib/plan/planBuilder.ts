/**
 * Plan assembly pipeline. One `buildDevicePlanSnapshot` call turns the live
 * device inputs into a `DevicePlan` through fixed stages: deferred-objective
 * decoration → plan context (soft limit, headroom, power freshness) →
 * shedding selection → initial device materialization → restore →
 * shed-temperature hold → reason normalization → finalization, followed by
 * overshoot bookkeeping, plan meta, and diagnostics observation. The builder
 * mutates the shared `PlanEngineState` (cooldown clocks, overshoot tracking,
 * shed-decision stamps) but performs no actuation — every device write
 * belongs to the executor.
 *
 * Shed-selection invariant (`lib/plan/shedding/AGENTS.md`): the shed set is
 * fixed once `buildSheddingPlan` returns, plus two post-shedding merges here
 * before materialization — the decoration seam's `forceShedSet` and the solar
 * dump-load hold (`resolveSurplusHold`, `lib/plan/shedding/surplusHold.ts`).
 * Every later stage — materialization,
 * restore, hold, reason normalization — only copies `shedSet` membership into
 * per-device `plannedState`/shed actions, or declines to lift an existing shed;
 * none of them may add a device to the shed set.
 *
 * Boundary (`lib/plan/AGENTS.md`): smart-task-agnostic — objectives reach
 * the builder only through the injected `decorateDeferredObjectives` seam.
 * Capacity-model internals: `docs/technical.md`.
 */
import CapacityGuard from '../power/capacityGuard';
import type { PowerTrackerState } from '../power/tracker';
import type { DevicePlan, PlanInputDevice, ShedAction } from './planTypes';
import type { PlanEngineState } from './planState';
import { computeDailyUsageSoftLimit, computeDynamicSoftLimit, computeShortfallThreshold } from './planBudget';
import { buildPlanContext, type PlanContext, type SoftLimitSource } from './planContext';
import { buildSheddingPlan, type SheddingPlan } from './shedding';
import { runSurplusPass, type PriceOptDeviceConfig } from './planBuilderSurplus';
import { sumBudgetExemptLiveUsageKw } from './planUsage';
import { PlanMaterializationStages } from './planBuilderMaterialization';
import { trackPlanStage, trackPlanStageAsync } from './planStageTiming';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { incPerfCounter } from '../utils/perfCounters';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import {
  buildDailyBudgetContext as buildPlanDailyBudgetContext,
  resolveDailySoftLimitBucket,
} from './planDailyBudgetWindow';
import { syncConfirmedRestoreAttributionState as syncConfirmedRestoreAttributionAttempt } from './admission';
import type { PendingBinaryCommandStore } from '../observer/pendingBinaryCommands';
import { resolveSoftOvershootDecision, type SoftOvershootDecision } from './planOvershoot';
import type {
  DeferredDecorationBundle,
  DeferredDecorationInput,
} from '../../packages/planner-types/src/deferredDecoration';
import { OvershootTracker } from './planBuilderOvershoot';
import { buildPlanMeta, emitPowerFreshnessTransitionLogs } from './planBuilderMeta';
import { attachDeferredReleaseIntents, buildIdentityDecorationBundle } from './planBuilderDecoration';

export type PlanBuilderDeps = {
  setCapacityInShortfall: (inShortfall: boolean) => void;
  getCapacityGuard: () => CapacityGuard | undefined;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getOperatingMode: () => string;
  getModeDeviceTargets: () => Record<string, Record<string, number>>;
  getPriceOptimizationEnabled: () => boolean;
  getPriceOptimizationSettings: () => Record<string, PriceOptDeviceConfig>;
  isCurrentHourCheap: () => boolean;
  isCurrentHourExpensive: () => boolean;
  // Producer-resolved inferred curtailed-surplus term for the surplus allocator
  // (zero-export homes); forwarded untouched to the per-device prep pass.
  getInferredSurplusKw?: () => number | null;
  // Producer-resolved per-home posture: hold a mode-target RAISE while this
  // home's own power reading is unknown (see `applyModeSeedModulation` in
  // `planDevices.ts`). Absent = no hold, which is the main home's binding.
  holdsModeTargetRaisesWhilePowerUnknown?: () => boolean;
  getPowerTracker: () => PowerTrackerState;
  getDailyBudgetSnapshot?: () => DailyBudgetUiPayload | null;
  getPriorityForDevice: (deviceId: string) => number;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
  getDynamicSoftLimitOverride?: () => number | null;
  // Observer-owned pending-binary-command store. Plan-side reads consult
  // `peek(id)` (raw read) through this facade rather than touching
  // `state.pendingBinaryCommands[id]` directly, so the store stays the
  // single source of truth for that map (observer/transport split).
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
  // Observer-resolved per-device staleness for the diagnostics freshness gate
  // (starvation must not count stale-but-unobserved time). Sourced from the
  // observer projection at the wiring layer (createPlanEngine); absent in tests
  // that don't exercise freshness, which then treat every device as fresh.
  getObservationStale?: (deviceId: string) => boolean;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
  // Smart-task (deferred-objective) decoration seam. The smart-task controller
  // (lib/objectives) evaluates objectives, commits active plans synchronously,
  // and applies admission / target-overrides / release-intents, returning a
  // `DeferredDecorationBundle`. When absent (no smart tasks wired, e.g. tests),
  // the planner uses the identity bundle and stays entirely smart-task-agnostic.
  // This is the dependency inversion that keeps lib/plan free of lib/objectives.
  decorateDeferredObjectives?: (input: DeferredDecorationInput) => DeferredDecorationBundle;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
};
const SOFT_LIMIT_EPSILON = 1e-3;

type DailySoftLimitResolution = {
  dailySoftLimitKw: number;
  budgetPaceKw: number;
  projectedExemptKw: number;
};

export class PlanBuilder {
  private readonly overshootTracker: OvershootTracker;

  // Post-shedding pipeline stages (`planBuilderMaterialization.ts`): initial
  // materialization → restore → hold → reason normalization → finalization,
  // plus the headroom-card sync and the diagnostics observation.
  private readonly stages: PlanMaterializationStages;

  constructor(private deps: PlanBuilderDeps, private state: PlanEngineState) {
    this.overshootTracker = new OvershootTracker(state, deps);
    this.stages = new PlanMaterializationStages(deps, state);
  }

  private get capacityGuard(): CapacityGuard | undefined { return this.deps.getCapacityGuard(); }
  private get capacitySettings(): { limitKw: number; marginKw: number } { return this.deps.getCapacitySettings(); }
  private get operatingMode(): string { return this.deps.getOperatingMode(); }
  private get modeDeviceTargets(): Record<string, Record<string, number>> { return this.deps.getModeDeviceTargets(); }

  private get priceOptimizationSettings(): Record<string, PriceOptDeviceConfig> {
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
    });
    this.state.hourlyBudgetExhausted = result.hourlyBudgetExhausted;
    return result.allowedKw;
  }

  /**
   * Compute the shortfall threshold for panic mode.
   * Shortfall should only trigger when projected hourly usage would breach the hard cap
   * and no devices are left to shed.
   */
  public computeShortfallThreshold(): number {
    return computeShortfallThreshold({
      capacitySettings: this.capacitySettings,
      powerTracker: this.powerTracker,
    });
  }

  public async buildDevicePlanSnapshot(devices: PlanInputDevice[]): Promise<DevicePlan> {
    return trackPlanStageAsync('plan_build_ms', () => this.buildPlanSnapshotWithTimings(devices));
  }

  private async buildPlanSnapshotWithTimings(devices: PlanInputDevice[]): Promise<DevicePlan> {
    const nowTs = Date.now();
    // Evaluate deferred objectives at the planner boundary and translate active objectives
    // into a plain managed-device shape: cap-off devices become controllable=true for the
    // cycle (so they participate in shed/restore), and idle hours seed the shedding shed-set.
    // Cap on/off only decides whether the planner cares about the device this cycle; once
    // admitted, the shedding and restore lanes act on the device with their normal logic and
    // produce their normal reasons.
    const dailyBudgetSnapshot = this.dailyBudgetSnapshot;
    // Hand the device list to the smart-task controller for decoration. The
    // controller evaluates objectives and applies admission / target-overrides /
    // release-intents, returning a smart-task-agnostic bundle. It only READS the
    // committed plan here; the active-plan RECORD (revisions) is written on the
    // lifecycle clock, not on this plan cycle. When no controller is wired the
    // planner uses the identity bundle and ignores smart tasks entirely.
    const {
      admittedDevices,
      forceShedSet,
      deferredAvoidDeviceIds,
      deferredReleaseIntentByDeviceId,
      admittedDeviceIds,
    } = trackPlanStage('plan_deferred_objective_observe_ms', () => (
      this.deps.decorateDeferredObjectives?.({ devices, dailyBudgetSnapshot, nowTs })
      ?? buildIdentityDecorationBundle(devices)
    ));

    const {
      context,
      sheddingPlan,
      overshootDecision,
    } = await this.buildContextAndShedding(admittedDevices, nowTs, dailyBudgetSnapshot);
    // Surplus allocator + the "Run on solar surplus" dump-load hold + the
    // post-shedding hold merges, all in `runSurplusPass` (hoisted so eligibility
    // exists as the shed set is assembled); returns the dump-load reason map for
    // reason normalization.
    const surplusHoldReasonById = trackPlanStage('plan_surplus_eligibility_ms', () => runSurplusPass({
      context,
      state: this.state,
      admittedDevices,
      shedSet: sheddingPlan.shedSet,
      decoration: { forceShedSet, deferredAvoidDeviceIds, deferredReleaseIntentByDeviceId, admittedDeviceIds },
      getConfig: (deviceId) => this.priceOptimizationSettings[deviceId],
      getPriority: (deviceId) => this.deps.getPriorityForDevice(deviceId),
      getInferredSurplusKw: this.deps.getInferredSurplusKw,
      debugStructured: this.deps.debugStructured,
      nowTs,
    }));
    const deviceNameById = new Map(admittedDevices.map((d) => [d.id, d.name]));

    let planDevices = this.stages.buildPlanDevices(context, sheddingPlan);
    const restoreResult = this.stages.applyRestorePlan(planDevices, context, sheddingPlan, deviceNameById);
    planDevices = restoreResult.planDevices;

    const holdResult = this.stages.applyHoldPlan(planDevices, restoreResult, sheddingPlan);
    planDevices = holdResult.planDevices;

    planDevices = this.stages.normalizeReasons(planDevices, context, restoreResult, sheddingPlan, {
      deferredObjectiveAvoidDeviceIds: deferredAvoidDeviceIds,
      surplusHoldReasonById,
    });
    planDevices = attachDeferredReleaseIntents(planDevices, deferredReleaseIntentByDeviceId, context);
    this.stages.syncHeadroomCardState(planDevices);
    const finalized = this.stages.finalizePlan(planDevices);
    // Decision-time shed clock (edge-set) + the plan-less-safe surplus-posture
    // stamp — semantics on `PlanEngineState.recordPlannedShedDecisions`.
    this.state.recordPlannedShedDecisions({
      shedIds: finalized.lastPlannedShedIds,
      surplusOnlyIds: new Set(admittedDevices.filter((dev) => dev.surplusOnly === true).map((dev) => dev.id)),
      nowTs,
    });
    trackPlanStage('plan_overshoot_ms', () => this.overshootTracker.updateOvershootState({
      context,
      capacityGuard: this.capacityGuard,
      capacityLimitKw: this.capacitySettings.limitKw,
      powerTracker: this.powerTracker,
      deviceNameById,
      planDevices: finalized.planDevices,
      overshootDecision,
      nowTs,
    }));

    const meta = trackPlanStage('plan_meta_ms', () => buildPlanMeta({
      context,
      planDevices: finalized.planDevices,
      dailyBudgetSnapshot,
      powerTracker: this.powerTracker,
      capacityGuard: this.capacityGuard,
      capacityLimitKw: this.capacitySettings.limitKw,
      hourlyBudgetExhausted: this.state.hourlyBudgetExhausted,
    }));
    this.stages.observeDiagnostics({
      context,
      planDevices: finalized.planDevices,
      restoreResult,
      nowTs,
    });
    return {
      meta,
      devices: finalized.planDevices,
    };
  }

  private async buildContextAndShedding(
    devices: PlanInputDevice[],
    nowTs: number,
    dailyBudgetSnapshot: DailyBudgetUiPayload | null,
  ): Promise<{
    context: PlanContext;
    sheddingPlan: SheddingPlan;
    overshootDecision: SoftOvershootDecision;
  }> {
    const desiredForMode = this.modeDeviceTargets[this.operatingMode] || {};
    const capacitySoftLimit = this.computeDynamicSoftLimit();
    const dailySoftLimitResolution = this.computeDailySoftLimit(dailyBudgetSnapshot, devices);
    const dailySoftLimit = dailySoftLimitResolution?.dailySoftLimitKw ?? null;
    const softLimit = dailySoftLimit !== null ? Math.min(capacitySoftLimit, dailySoftLimit) : capacitySoftLimit;
    const softLimitSource = this.resolveSoftLimitSource(capacitySoftLimit, dailySoftLimit);

    const context = trackPlanStage('plan_context_ms', () => buildPlanContext({
      devices,
      capacityGuard: this.capacityGuard,
      capacitySettings: this.capacitySettings,
      powerTracker: this.powerTracker,
      softLimit,
      capacitySoftLimit,
      dailySoftLimit,
      budgetPaceKw: dailySoftLimitResolution?.budgetPaceKw ?? null,
      projectedExemptKw: dailySoftLimitResolution?.projectedExemptKw ?? null,
      softLimitSource,
      desiredForMode,
      hourlyBudgetExhausted: this.state.hourlyBudgetExhausted,
      dailyBudget: buildPlanDailyBudgetContext(dailyBudgetSnapshot),
    }));
    this.logPowerFreshness(context);
    const overshootDecision = resolveSoftOvershootDecision({
      headroomKw: context.headroom,
      state: this.state,
      nowTs,
    });
    this.state.softOvershootPendingSinceMs = overshootDecision.pendingSinceMs;
    this.syncConfirmedRestoreAttributionAttempts(
      devices,
      this.powerTracker.lastTimestamp ?? null,
      context.powerKnown && context.headroom >= 0,
    );

    const sheddingPlan = await trackPlanStageAsync(
      'plan_shedding_ms',
      () => buildSheddingPlan(context, this.state, {
        capacityGuard: this.capacityGuard,
        powerTracker: this.powerTracker,
        getShedBehavior: (deviceId) => this.deps.getShedBehavior(deviceId),
        getPriorityForDevice: (deviceId) => this.deps.getPriorityForDevice(deviceId),
        pendingBinaryCommandStore: this.deps.pendingBinaryCommandStore,
        log: (...args: unknown[]) => this.deps.log(...args),
        debugStructured: this.deps.debugStructured,
        structuredLog: this.deps.structuredLog,
      }, overshootDecision.actionable),
    );
    this.applySheddingUpdates(sheddingPlan);

    return { context, sheddingPlan, overshootDecision };
  }

  private syncConfirmedRestoreAttributionAttempts(
    devices: PlanInputDevice[],
    wholeHomePowerSampleAtMs: number | null,
    cleanWholeHomeSample: boolean,
  ): void {
    for (const device of devices) {
      syncConfirmedRestoreAttributionAttempt({
        state: this.state,
        deviceId: device.id,
        wholeHomePowerSampleAtMs,
        cleanWholeHomeSample,
      });
    }
  }

  private resolveSoftLimitSource(capacitySoftLimit: number, dailySoftLimit: number | null): SoftLimitSource {
    if (dailySoftLimit === null) return 'capacity';
    if (Math.abs(dailySoftLimit - capacitySoftLimit) <= SOFT_LIMIT_EPSILON) return 'capacity';
    return dailySoftLimit < capacitySoftLimit ? 'daily' : 'capacity';
  }

  private computeDailySoftLimit(
    snapshot: DailyBudgetUiPayload | null,
    devices: PlanInputDevice[],
  ): DailySoftLimitResolution | null {
    const bucket = resolveDailySoftLimitBucket(snapshot, this.powerTracker);
    if (!bucket) return null;
    const projectedExemptKw = Math.max(0, sumBudgetExemptLiveUsageKw(devices) ?? 0);
    const budgetPaceKw = computeDailyUsageSoftLimit({
      ...bucket,
    });
    // Budget-exempt load should not trigger daily-budget shedding of other devices.
    // Remove exempt energy already metered this hour, then add back the exempt live
    // run rate so the effective daily limit still allows that load to remain on.
    return {
      budgetPaceKw,
      projectedExemptKw,
      dailySoftLimitKw: budgetPaceKw + projectedExemptKw,
    };
  }

  private applySheddingUpdates(sheddingPlan: SheddingPlan): void {
    if (sheddingPlan.updates.lastInstabilityMs !== undefined) {
      this.state.lastInstabilityMs = sheddingPlan.updates.lastInstabilityMs;
    }
    if (sheddingPlan.updates.lastRecoveryMs !== undefined) {
      this.state.lastRecoveryMs = sheddingPlan.updates.lastRecoveryMs;
    }
    if (sheddingPlan.updates.lastShedPlanMeasurementTs !== undefined) {
      this.state.lastShedPlanMeasurementTs = sheddingPlan.updates.lastShedPlanMeasurementTs;
    }
    if (sheddingPlan.updates.lastShedPlanPowerW !== undefined) {
      this.state.lastShedPlanPowerW = sheddingPlan.updates.lastShedPlanPowerW;
    }
    if (sheddingPlan.updates.lastShedPlanShedIds !== undefined) {
      this.state.lastShedPlanShedIds = sheddingPlan.updates.lastShedPlanShedIds;
    }
    if (sheddingPlan.updates.lastShedPlanAtMs !== undefined) {
      this.state.lastShedPlanAtMs = sheddingPlan.updates.lastShedPlanAtMs;
    }
    if (sheddingPlan.updates.lastShedPlanNeededKw !== undefined) {
      this.state.lastShedPlanNeededKw = sheddingPlan.updates.lastShedPlanNeededKw;
    }
    if (sheddingPlan.updates.lastOvershootEscalationMs !== undefined) {
      this.state.lastOvershootEscalationMs = sheddingPlan.updates.lastOvershootEscalationMs;
    }
    if (sheddingPlan.updates.lastOvershootMitigationMs !== undefined) {
      this.state.lastOvershootMitigationMs = sheddingPlan.updates.lastOvershootMitigationMs;
    }
    if (sheddingPlan.guardInShortfall !== this.state.inShortfall) {
      // Commit the durable signal before advancing the shared planner state.
      // If settings throws, the next build must still observe the transition
      // and retry instead of treating an unpersisted latch as complete.
      this.deps.setCapacityInShortfall(sheddingPlan.guardInShortfall);
      this.state.inShortfall = sheddingPlan.guardInShortfall;
      incPerfCounter('settings_set.capacity_in_shortfall');
    }
  }

  private logPowerFreshness(context: PlanContext): void {
    const previousState = this.state.lastPowerFreshnessState;
    const currentState = context.powerFreshnessState;
    const structuredLog = this.deps.structuredLog;

    emitPowerFreshnessTransitionLogs(structuredLog, previousState, currentState, context);

    this.state.lastPowerFreshnessState = currentState;
  }
}
