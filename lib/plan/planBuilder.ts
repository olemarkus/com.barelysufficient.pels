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
import { PriceLevel } from '../price/priceLevels';
import type { PlanBuilderDeps } from './planBuilderDeps';
import { resolvePowerCycleReading } from '../power/powerCycleReading';
import type { DevicePlan, PlanInputDevice } from './planTypes';
import type { PlanEngineState } from './planState';
import { computeDailyUsageSoftLimit, computeDynamicSoftLimit, computeShortfallThreshold } from './planBudget';
import {
  buildPlanContext,
  resolveMeasuredPower,
  type MeasuredPower,
  type PlanContext,
  type PlanLimits,
  type SoftLimitSource,
} from './planContext';
import { buildSheddingPlan, type SheddingPlan } from './shedding';
import { buildSheddingDeps, SilentMeterPlanBuilder } from './planBuilderSilentMeter';
import { resolveShortfallOffState } from './planOffStateReason';
import { runSurplusPass, type PriceOptDeviceConfig } from './planBuilderSurplus';
import { sumBudgetExemptProjectedUsageKw } from './planUsage';
import { PlanMaterializationStages } from './planBuilderMaterialization';
import { resolveNormalizedShedFloors } from './normalizedShedFloor';
import type { TemperaturePlanInputKind } from '../../packages/planner-types/src/planInputDevice';
import { trackPlanStage, trackPlanStageAsync } from './planStageTiming';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { incPerfCounter } from '../utils/perfCounters';
import { resolveDailySoftLimitBucket } from './planDailyBudgetWindow';
import {
  ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS,
  syncConfirmedRestoreAttributionState as syncConfirmedRestoreAttributionAttempt,
} from './admission';
import { resolveSoftOvershootDecision, type SoftOvershootDecision } from './planOvershoot';
import { OvershootTracker } from './planBuilderOvershoot';
import { buildPlanMeta } from './planBuilderMeta';
import { attachDeferredReleaseIntents, buildIdentityDecorationBundle } from './planBuilderDecoration';

export type { PlanBuilderDeps } from './planBuilderDeps';
const SOFT_LIMIT_EPSILON = 1e-3;

// No price call was made this build — nothing in it can spend a price delta —
// so there is no level to report. `applyPriceOptimizationDelta` adds nothing for
// it, exactly as for a genuinely unpriced hour.
const NO_CURRENT_HOUR_PRICE_LEVEL = PriceLevel.UNKNOWN;

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

  /** The unmeasured path — see `planBuilderSilentMeter.ts`. */
  private readonly silentMeter: SilentMeterPlanBuilder;

  /**
   * Per builder, so a main home and its meter areas keep separate freshness
   * histories. Owned by `lib/power`; the builder only drives it once per cycle.
   */

  constructor(private deps: PlanBuilderDeps, private state: PlanEngineState) {
    this.overshootTracker = new OvershootTracker(state, deps);
    this.stages = new PlanMaterializationStages(deps, state);
    this.silentMeter = new SilentMeterPlanBuilder(deps, state, this.stages);
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
    const decoration = trackPlanStage('plan_deferred_objective_observe_ms', () => (
      this.deps.decorateDeferredObjectives?.({ devices, dailyBudgetSnapshot, nowTs })
      ?? buildIdentityDecorationBundle(devices)
    ));
    const { admittedDevices } = decoration;

    // One reading per build, resolved by `lib/power` — pure: the silence
    // policy (block + one shed pass) lives in the wiring's composed gate and
    // `lib/power/meterSilence.ts`, never in a planner-held state machine.
    const reading = resolvePowerCycleReading({
      powerTracker: this.powerTracker,
      nowMs: Date.now(),
    });
    const context = trackPlanStage('plan_context_ms', () => buildPlanContext({
      devices: admittedDevices,
      capacitySettings: this.capacitySettings,
      powerTracker: this.powerTracker,
      limits: this.resolvePlanLimits(admittedDevices, dailyBudgetSnapshot),
      modeTargetCFor: this.modeTargetCFor(),
      currentHourPriceLevel: this.resolveCurrentHourPriceLevel(admittedDevices),
    }));
    // THE seam. The ordinary pipeline below is entered only with a measurement,
    // so nothing inside it asks whether power was measured; the one unmeasured
    // build — the silent-meter fail-closed pass — takes its directive here and
    // never constructs a `MeasuredPower` (owner ruling 2026-09-02).
    if (!reading.isMeasured) {
      return this.silentMeter.build(context, reading, decoration, nowTs);
    }
    const power = resolveMeasuredPower(reading, context, admittedDevices);
    const { sheddingPlan, overshootDecision } = await this.decideShedding(context, power, nowTs);
    // Surplus allocator + the "Run on solar surplus" dump-load hold + the
    // post-shedding hold merges, all in `runSurplusPass` (hoisted so eligibility
    // exists as the shed set is assembled); returns the dump-load reason map for
    // reason normalization.
    const surplusHoldReasonById = trackPlanStage('plan_surplus_eligibility_ms', () => runSurplusPass({
      context,
      power,
      state: this.state,
      admittedDevices,
      shedSet: sheddingPlan.shedSet,
      shedStepTargets: sheddingPlan.shedStepTargets,
      decoration,
      getConfig: (deviceId) => this.priceOptimizationSettings[deviceId],
      getInferredSurplusKw: this.deps.getInferredSurplusKw,
      debugStructured: this.deps.debugStructured,
      nowTs,
    }));
    const deviceNameById = new Map(admittedDevices.map((d) => [d.id, d.name]));

    let planDevices = this.stages.buildPlanDevices(
      context,
      sheddingPlan,
      resolveShortfallOffState(sheddingPlan.guardInShortfall, power.headroomKw),
    );
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
      planDevices, context, power, sheddingPlan, deviceNameById, normalizedShedFloorCByDevice,
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
      power,
      restoreResult,
      sheddingPlan,
      normalizedShedFloorCByDevice,
      holds: {
        deferredObjectiveAvoidDeviceIds: decoration.deferredAvoidDeviceIds,
        surplusHoldReasonById,
      },
      holdResult,
    });
    planDevices = attachDeferredReleaseIntents(planDevices, decoration.deferredReleaseIntentByDeviceId, true);
    this.stages.syncHeadroomCardState(planDevices);
    const finalized = this.stages.finalizePlan(planDevices, normalizedShedFloorCByDevice);
    // Decision-time shed clock (edge-set) + the plan-less-safe surplus-posture
    // stamp — semantics on `PlanEngineState.recordPlannedShedDecisions`.
    this.state.recordPlannedShedDecisions({
      shedIds: finalized.lastPlannedShedIds,
      surplusOnlyIds: new Set(admittedDevices.filter((dev) => dev.surplusOnly === true).map((dev) => dev.id)),
      nowTs,
    });
    const capacityLimitKw = this.capacitySettings.limitKw;
    const shortfallBudgetThresholdKw = this.computeShortfallThreshold();
    trackPlanStage('plan_overshoot_ms', () => this.overshootTracker.updateOvershootState({
      context,
      power,
      reading,
      capacityLimitKw,
      shortfallBudgetThresholdKw,
      powerTracker: this.powerTracker,
      deviceNameById,
      planDevices: finalized.planDevices,
      overshootDecision,
      nowTs,
    }));

    const meta = trackPlanStage('plan_meta_ms', () => buildPlanMeta({
      context,
      reading,
      planDevices: finalized.planDevices,
      dailyBudgetSnapshot,
      powerTracker: this.powerTracker,
      capacityGuard: this.capacityGuard,
      capacityLimitKw,
      shortfallBudgetThresholdKw,
      hourlyBudgetExhausted: this.state.hourlyBudgetExhausted,
    }, power));
    this.stages.observeDiagnostics({
      context,
      power,
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
   * See `PlanContext.currentHourPriceLevel` for why it is resolved here rather than in the
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
  private resolveCurrentHourPriceLevel(devices: PlanInputDevice[]): PriceLevel {
    if (!this.deps.getPriceOptimizationEnabled()) return NO_CURRENT_HOUR_PRICE_LEVEL;
    const settings = this.priceOptimizationSettings;
    if (!devices.some((dev) => settings[dev.id]?.enabled === true)) return NO_CURRENT_HOUR_PRICE_LEVEL;
    // One combined-series build for the resolved level — see
    // `PriceService.getCurrentHourPriceLevel`. Asking the two predicates
    // separately rebuilt the whole series twice for one question.
    return this.deps.getCurrentHourPriceLevel();
  }

  private modeTargetCFor(): (device: PlanInputDevice & TemperaturePlanInputKind) => number {
    const stored = this.modeDeviceTargets[this.operatingMode] ?? {};
    return (device) => stored[device.id] ?? device.currentTarget;
  }

  /**
   * The limits this cycle is decided against — one resolution, held by the
   * frame both passes build. Stamps the capacity pace into the engine state
   * (`hourlyRemainingKWh`, `hourlyBudgetExhausted`) as a side effect, exactly
   * as before.
   */
  private resolvePlanLimits(devices: PlanInputDevice[], dailyBudgetSnapshot: DailyBudgetUiPayload | null): PlanLimits {
    const capacitySoftLimit = this.stampCapacityPace();
    const dailySoftLimitResolution = this.computeDailySoftLimit(dailyBudgetSnapshot, devices);
    const dailySoftLimit = dailySoftLimitResolution?.dailySoftLimitKw ?? null;
    return {
      softLimit: dailySoftLimit !== null ? Math.min(capacitySoftLimit, dailySoftLimit) : capacitySoftLimit,
      capacitySoftLimit,
      dailySoftLimit,
      budgetPaceKw: dailySoftLimitResolution?.budgetPaceKw ?? null,
      projectedExemptKw: dailySoftLimitResolution?.projectedExemptKw ?? null,
      softLimitSource: this.resolveSoftLimitSource(capacitySoftLimit, dailySoftLimit),
    };
  }

  private async decideShedding(
    context: PlanContext,
    power: MeasuredPower,
    nowTs: number,
  ): Promise<{ sheddingPlan: SheddingPlan; overshootDecision: SoftOvershootDecision }> {
    const overshootDecision = resolveSoftOvershootDecision({
      headroomKw: power.headroomKw,
      // Stamped by `stampCapacityPace` in `resolvePlanLimits`, from the same
      // hourly budget the soft limit itself is paced against.
      hourRemainingKWh: this.state.hourlyRemainingKWh,
      // Only price a wait when a restore PELS issued is still settling.
      restoreTransientPossible: this.hasOpenActivationAttempt(nowTs),
      state: this.state,
      nowTs,
    });
    this.state.softOvershootPendingSinceMs = overshootDecision.pendingSinceMs;
    // A clean whole-home sample: the house is under its pace, and the hour is
    // not spent (an exhausted hour admits nothing, however the draw reads).
    this.syncConfirmedRestoreAttributionAttempts(
      context.devices,
      this.powerTracker.lastTimestamp ?? null,
      power.headroomKw >= 0 && !this.state.hourlyBudgetExhausted,
    );

    // `buildSheddingPlan` takes the WHOLE decision, not just the shed half: the
    // shedding-active latch must stay engaged through a grace window, or every
    // restore lane that defers to it releases the devices already limited
    // (`lib/plan/shedding/AGENTS.md`).
    const sheddingPlan = await trackPlanStageAsync(
      'plan_shedding_ms',
      () => buildSheddingPlan(
        context, power, this.state, buildSheddingDeps(this.deps, this.computeShortfallThreshold()), overshootDecision,
      ),
    );
    this.applySheddingUpdates(sheddingPlan);

    return { sheddingPlan, overshootDecision };
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
