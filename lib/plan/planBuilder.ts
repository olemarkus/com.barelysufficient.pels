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
import { resolveLastTotalPowerKw } from '../power/lastTotalPower';
import type { PowerTrackerState } from '../power/tracker';
import { PowerFreshnessMonitor, type PowerCycleDisplay } from '../power/powerCycleReading';
import type { DevicePlan, PlanInputDevice, ShedBehavior } from './planTypes';
import type { PlanEngineState } from './planState';
import { computeDailyUsageSoftLimit, computeDynamicSoftLimit, computeShortfallThreshold } from './planBudget';
import {
  buildPlanContext,
  type CurrentHourPriceLevel,
  type PlanContext,
  type SoftLimitSource,
} from './planContext';
import { buildSheddingPlan, type SheddingPlan } from './shedding';
import { runSurplusPass, type PriceOptDeviceConfig } from './planBuilderSurplus';
import { sumBudgetExemptProjectedUsageKw } from './planUsage';
import { PlanMaterializationStages } from './planBuilderMaterialization';
import { resolveNormalizedShedFloors } from './normalizedShedFloor';
import type { TemperaturePlanInputKind } from '../../packages/planner-types/src/planInputDevice';
import { trackPlanStage, trackPlanStageAsync } from './planStageTiming';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { incPerfCounter } from '../utils/perfCounters';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import {
  buildDailyBudgetContext as buildPlanDailyBudgetContext,
  resolveDailySoftLimitBucket,
} from './planDailyBudgetWindow';
import {
  ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS,
  syncConfirmedRestoreAttributionState as syncConfirmedRestoreAttributionAttempt,
} from './admission';
import type { PendingBinaryCommandStore } from '../observer/pendingBinaryCommands';
import { resolveSoftOvershootDecision, type SoftOvershootDecision } from './planOvershoot';
import type {
  DeferredDecorationBundle,
  DeferredDecorationInput,
} from '../../packages/planner-types/src/deferredDecoration';
import { OvershootTracker } from './planBuilderOvershoot';
import { buildPlanMeta } from './planBuilderMeta';
import { attachDeferredReleaseIntents, buildIdentityDecorationBundle } from './planBuilderDecoration';

export type PlanBuilderDeps = {
  setCapacityInShortfall: (inShortfall: boolean) => void;
  /** Per-home dry-run posture — the same fact `shouldApplyPlan` consults
   * before actuating. */
  getCapacityDryRun: () => boolean;
  capacityGuard: CapacityGuard;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getOperatingMode: () => string;
  getModeDeviceTargets: () => Record<string, Record<string, number>>;
  getPriceOptimizationEnabled: () => boolean;
  getPriceOptimizationSettings: () => Record<string, PriceOptDeviceConfig>;
  // Producer-resolved: both current-hour flags from ONE combined-series build.
  getCurrentHourPriceLevel: () => CurrentHourPriceLevel;
  // Producer-resolved inferred curtailed-surplus term for the surplus allocator
  // (zero-export homes); forwarded untouched to the per-device prep pass.
  getInferredSurplusKw?: () => number | null;
  // Producer-resolved per-home posture: hold a mode-target RAISE while this
  // home's own power reading is unknown (see `applyModeSeedModulation` in
  // `planDevices.ts`). Absent = no hold, which is the main home's binding.
  holdsModeTargetRaisesWhilePowerUnknown?: () => boolean;
  getPowerTracker: () => PowerTrackerState;
  getDailyBudgetSnapshot?: () => DailyBudgetUiPayload | null;
  getShedBehavior: (deviceId: string) => ShedBehavior;
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

// Neither cheap nor expensive: what `resolveCurrentHourPriceLevel` answers when
// nothing in this build can spend a price delta, so no price call is made.
const NO_CURRENT_HOUR_PRICE_LEVEL: CurrentHourPriceLevel = { cheap: false, expensive: false };

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

  /**
   * Per builder, so a main home and its meter areas keep separate freshness
   * histories. Owned by `lib/power`; the builder only drives it once per cycle.
   */
  private readonly powerFreshnessMonitor: PowerFreshnessMonitor;

  constructor(private deps: PlanBuilderDeps, private state: PlanEngineState) {
    this.overshootTracker = new OvershootTracker(state, deps);
    this.stages = new PlanMaterializationStages(deps, state);
    this.powerFreshnessMonitor = new PowerFreshnessMonitor(deps.structuredLog, () => state.appStartedAtMs);
  }

  private get capacityGuard(): CapacityGuard { return this.deps.capacityGuard; }
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

  /**
   * The capacity pace as a plain read: the same number `stampCapacityPace`
   * returns, override precedence included, and no write.
   *
   * Every caller outside the plan build gets this one. A periodic status log, a
   * Flow condition asking "is there available power", the rebuild scheduler's
   * threshold input and the shortfall log line all ask what the pace *is*; none
   * of them is deciding a plan, so none of them may leave a stamp behind.
   *
   * The window this closes is narrow but real. Most of a build is one turn of
   * the event loop, so nothing can get between the stamp and the reads — but the
   * guard's shortfall path awaits a settings write (`ShortfallExecutor`), and
   * that await sits between the shed decision (`buildSheddingPlan` reads
   * `hourlyBudgetExhausted` before `updateGuardState`) and the reason and meta
   * passes that label it (`planBuilderMaterialization`, `buildPlanMeta`, both
   * after). While this method also wrote, a caller firing in that window across
   * an hour boundary re-stamped the flag, and the plan explained itself against
   * an hour its own decision never saw.
   */
  public computeDynamicSoftLimit(): number {
    return this.resolveCapacityPace().paceKw;
  }

  /**
   * The build's call: the same resolution, plus the two `PlanEngineState` fields
   * the rest of this cycle reads off it. The one writer of both — keep it that
   * way, so "what hour is it" is answered once per plan rather than by whoever
   * last asked for the number.
   */
  private stampCapacityPace(): number {
    const resolved = this.resolveCapacityPace();
    this.state.hourlyRemainingKWh = resolved.remainingKWh;
    this.state.hourlyBudgetExhausted = resolved.hourlyBudgetExhausted;
    return resolved.paceKw;
  }

  private resolveCapacityPace(): {
    paceKw: number;
    remainingKWh: number;
    hourlyBudgetExhausted: boolean;
  } {
    // Computed unconditionally: the hour's remaining budget is a fact about the
    // hour, not about which pace is in force, so an override replaces the pace
    // and leaves the budget untouched. Resolving it on both paths keeps
    // `hourlyRemainingKWh` a plain number for every consumer.
    const result = computeDynamicSoftLimit({
      capacitySettings: this.capacitySettings,
      powerTracker: this.powerTracker,
    });
    const override = this.deps.getDynamicSoftLimitOverride?.();
    if (typeof override === 'number' && Number.isFinite(override)) {
      return { paceKw: override, remainingKWh: result.remainingKWh, hourlyBudgetExhausted: false };
    }
    return {
      paceKw: result.allowedKw,
      remainingKWh: result.remainingKWh,
      hourlyBudgetExhausted: result.hourlyBudgetExhausted,
    };
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
      power,
      sheddingPlan,
      overshootDecision,
    } = await this.buildContextAndShedding(
      admittedDevices,
      nowTs,
      dailyBudgetSnapshot,
    );
    // Surplus allocator + the "Run on solar surplus" dump-load hold + the
    // post-shedding hold merges, all in `runSurplusPass` (hoisted so eligibility
    // exists as the shed set is assembled); returns the dump-load reason map for
    // reason normalization.
    const surplusHoldReasonById = trackPlanStage('plan_surplus_eligibility_ms', () => runSurplusPass({
      context,
      state: this.state,
      admittedDevices,
      shedSet: sheddingPlan.shedSet,
      shedStepTargets: sheddingPlan.shedStepTargets,
      decoration: { forceShedSet, deferredAvoidDeviceIds, deferredReleaseIntentByDeviceId, admittedDeviceIds },
      getConfig: (deviceId) => this.priceOptimizationSettings[deviceId],
      getInferredSurplusKw: this.deps.getInferredSurplusKw,
      debugStructured: this.deps.debugStructured,
      nowTs,
    }));
    const deviceNameById = new Map(admittedDevices.map((d) => [d.id, d.name]));

    let planDevices = this.stages.buildPlanDevices(context, sheddingPlan);
    // One capability-normalized configured floor per device per build — the
    // single source the restore/swap pass, the hold lane, reason
    // normalization, and restore classification all read, so no stage
    // can disagree about what "at the floor" means within a build
    // (semantics on `resolveNormalizedShedFloors`).
    const normalizedShedFloorCByDevice = resolveNormalizedShedFloors(
      context.devices,
      (deviceId) => this.deps.getShedBehavior(deviceId),
    );
    const restoreResult = this.stages.applyRestorePlan(
      planDevices, context, sheddingPlan, deviceNameById, normalizedShedFloorCByDevice,
    );
    planDevices = restoreResult.planDevices;

    const holdResult = this.stages.applyHoldPlan(
      planDevices,
      restoreResult,
      sheddingPlan,
      normalizedShedFloorCByDevice,
    );
    planDevices = holdResult.planDevices;

    planDevices = this.stages.normalizeReasons({
      planDevices,
      context,
      restoreResult,
      sheddingPlan,
      normalizedShedFloorCByDevice,
      holds: {
        deferredObjectiveAvoidDeviceIds: deferredAvoidDeviceIds,
        surplusHoldReasonById,
      },
      holdResult,
    });
    planDevices = attachDeferredReleaseIntents(planDevices, deferredReleaseIntentByDeviceId, context);
    this.stages.syncHeadroomCardState(planDevices);
    const finalized = this.stages.finalizePlan(planDevices, normalizedShedFloorCByDevice);
    // Decision-time shed clock (edge-set) + the plan-less-safe surplus-posture
    // stamp — semantics on `PlanEngineState.recordPlannedShedDecisions`.
    this.state.recordPlannedShedDecisions({
      shedIds: finalized.lastPlannedShedIds,
      surplusOnlyIds: new Set(admittedDevices.filter((dev) => dev.surplusOnly === true).map((dev) => dev.id)),
      nowTs,
    });
    trackPlanStage('plan_overshoot_ms', () => this.overshootTracker.updateOvershootState({
      context,
      power,
      capacityLimitKw: this.capacitySettings.limitKw,
      shortfallBudgetThresholdKw: this.computeShortfallThreshold(),
      powerTracker: this.powerTracker,
      deviceNameById,
      planDevices: finalized.planDevices,
      overshootDecision,
      nowTs,
    }));

    const meta = trackPlanStage('plan_meta_ms', () => buildPlanMeta({
      context,
      power,
      planDevices: finalized.planDevices,
      dailyBudgetSnapshot,
      powerTracker: this.powerTracker,
      capacityGuard: this.capacityGuard,
      capacityLimitKw: this.capacitySettings.limitKw,
      shortfallBudgetThresholdKw: this.computeShortfallThreshold(),
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

  /**
   * The one place this build asks the price service what kind of hour it is.
   * See `CurrentHourPriceLevel` for why it is resolved here rather than in the
   * per-device loops that read it.
   *
   * Resolves ONLY when some admitted device could actually spend the answer —
   * both consumer guards are `priceOptimizationEnabled && config?.enabled`, so
   * this reproduces their combined zero-call case rather than just the master
   * switch. The per-device half is load-bearing, not belt-and-braces: the global
   * switch reads `homey.settings.get(PRICE_OPTIMIZATION_ENABLED) !== false`, so
   * an unset key defaults it ON while the device map is still empty — a fresh
   * install would otherwise pay two full price-series rebuilds (~50 ms) on every
   * power-triggered rebuild for a delta no device is configured to receive.
   *
   * The device scan is a superset of what the loops need (it ignores modality and
   * the mode seed), which is the safe direction: never fewer resolutions than a
   * consumer will read.
   */
  private resolveCurrentHourPriceLevel(devices: PlanInputDevice[]): CurrentHourPriceLevel {
    if (!this.deps.getPriceOptimizationEnabled()) return NO_CURRENT_HOUR_PRICE_LEVEL;
    const settings = this.priceOptimizationSettings;
    if (!devices.some((dev) => settings[dev.id]?.enabled === true)) return NO_CURRENT_HOUR_PRICE_LEVEL;
    // One combined-series build for both flags — see
    // `PriceService.getCurrentHourPriceLevel`. Asking the two predicates
    // separately rebuilt the whole series twice for one question.
    return this.deps.getCurrentHourPriceLevel();
  }

  private async buildContextAndShedding(
    devices: PlanInputDevice[],
    nowTs: number,
    dailyBudgetSnapshot: DailyBudgetUiPayload | null,
  ): Promise<{
    context: PlanContext;
    // Display-only facts, carried BESIDE the context rather than on it so no
    // planner stage can reach a freshness label (2026-08-16 ruling).
    power: PowerCycleDisplay;
    sheddingPlan: SheddingPlan;
    overshootDecision: SoftOvershootDecision;
  }> {
    // Resolved ONCE, here, into a total function. `persistFilledModeTargets`
    // keeps the stored catalog complete — it writes an entry for every planned
    // temperature device on the settings refresh, before the first plan of that
    // cycle — so the fallback covers only the boot window before its first write
    // lands, where holding the device at its own setpoint commands nothing new.
    // Downstream there is no map and no absent case, so no stage can ask whether
    // this mode has a target for a device.
    const stored = this.modeDeviceTargets[this.operatingMode] ?? {};
    const modeTargetCFor = (device: PlanInputDevice & TemperaturePlanInputKind): number => (
      stored[device.id] ?? device.currentTarget
    );
    const capacitySoftLimit = this.stampCapacityPace();
    const dailySoftLimitResolution = this.computeDailySoftLimit(dailyBudgetSnapshot, devices);
    const dailySoftLimit = dailySoftLimitResolution?.dailySoftLimitKw ?? null;
    const softLimit = dailySoftLimit !== null ? Math.min(capacitySoftLimit, dailySoftLimit) : capacitySoftLimit;
    const softLimitSource = this.resolveSoftLimitSource(capacitySoftLimit, dailySoftLimit);

    // One reading per build, resolved by `lib/power`. It also owns the freshness
    // state machine, so the transition logs fire here as a side effect of asking
    // — the planner no longer holds a `lastPowerFreshnessState` to compare.
    const power = this.powerFreshnessMonitor.observe({
      powerTracker: this.powerTracker,
      totalKw: resolveLastTotalPowerKw(this.powerTracker),
      nowMs: Date.now(),
    });
    const context = trackPlanStage('plan_context_ms', () => buildPlanContext({
      devices,
      power,
      capacitySettings: this.capacitySettings,
      powerTracker: this.powerTracker,
      softLimit,
      capacitySoftLimit,
      dailySoftLimit,
      budgetPaceKw: dailySoftLimitResolution?.budgetPaceKw ?? null,
      projectedExemptKw: dailySoftLimitResolution?.projectedExemptKw ?? null,
      softLimitSource,
      modeTargetCFor,
      hourlyBudgetExhausted: this.state.hourlyBudgetExhausted,
      currentHourPriceLevel: this.resolveCurrentHourPriceLevel(devices),
      dailyBudget: buildPlanDailyBudgetContext(dailyBudgetSnapshot),
    }));
    const overshootDecision = resolveSoftOvershootDecision({
      headroomKw: context.headroom,
      // Stamped by `stampCapacityPace` a few lines above, from the same
      // hourly budget the soft limit itself is paced against.
      hourRemainingKWh: this.state.hourlyRemainingKWh,
      // Only price a wait when a restore PELS issued is still settling, and only
      // while power is actually observable — a synthesized headroom is a
      // blind-mode shed and must never be delayed.
      restoreTransientPossible: context.powerIsMeasured
        && this.hasOpenActivationAttempt(nowTs),
      state: this.state,
      nowTs,
    });
    this.state.softOvershootPendingSinceMs = overshootDecision.pendingSinceMs;
    this.syncConfirmedRestoreAttributionAttempts(
      devices,
      this.powerTracker.lastTimestamp ?? null,
      context.powerIsMeasured && context.headroom >= 0,
    );

    // `buildSheddingPlan` takes the WHOLE decision, not just the shed half: the
    // shedding-active latch must stay engaged through a grace window, or every
    // restore lane that defers to it releases the devices already limited
    // (`lib/plan/shedding/AGENTS.md`).
    const sheddingPlan = await trackPlanStageAsync(
      'plan_shedding_ms',
      () => buildSheddingPlan(context, this.state, {
        capacityGuard: this.capacityGuard,
        shortfallThresholdKw: this.computeShortfallThreshold(),
        powerTracker: this.powerTracker,
        getShedBehavior: (deviceId) => this.deps.getShedBehavior(deviceId),
        pendingBinaryCommandStore: this.deps.pendingBinaryCommandStore,
        log: (...args: unknown[]) => this.deps.log(...args),
        debugStructured: this.deps.debugStructured,
        structuredLog: this.deps.structuredLog,
      }, overshootDecision),
    );
    this.applySheddingUpdates(sheddingPlan);

    return { context, power: power.display, sheddingPlan, overshootDecision };
  }

  /**
   * Is any activation attempt still open — i.e. did PELS restore a device
   * recently enough that its draw may still be ramping? This is the signal that
   * a capacity deficit right now might be a transient of PELS's own making
   * rather than a settled rate. Bounded by the attribution window, which
   * `syncActivationPenaltyState` also uses to close a stalled attempt.
   */
  private hasOpenActivationAttempt(nowTs: number): boolean {
    return Object.values(this.state.activationAttemptByDevice).some((attempt) => {
      const startedMs = attempt.startedMs;
      if (typeof startedMs !== 'number' || !Number.isFinite(startedMs)) return false;
      const elapsed = nowTs - startedMs;
      return elapsed >= 0 && elapsed < ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS;
    });
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
    // No `?? 0` here any more. The sum used to return `null` when exempt devices
    // existed but none reported power, and defaulting that to 0 shortened the
    // daily threshold by the exempt draw — non-exempt devices were shed for a
    // missing reading rather than for real budget pressure. Every plan device now
    // carries a resolved draw, so the unresolved state is gone.
    const projectedExemptKw = Math.max(0, sumBudgetExemptProjectedUsageKw(devices));
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

}
