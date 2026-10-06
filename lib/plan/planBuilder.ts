/**
 * Plan assembly pipeline. One `buildDevicePlanSnapshot` call turns the live
 * device inputs into a `DevicePlan` through fixed stages: deferred-objective
 * decoration → plan context (the cycle's limits) → measurement → surplus
 * allocation (`planSurplusAbsorb.ts`) → the batteries' holds and surplus
 * charge (`battery/storageRelief.ts`) → shedding selection, a battery ranked
 * among the devices → the battery limits it chose (`battery/storageLimit.ts`)
 * → standing-posture holds → initial device materialization → restore, a
 * battery handed back in priority order → shed-temperature hold → reason
 * normalization → finalization, followed by
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
import type { PlanBuilderDeps } from './planBuilderDeps';
import { resolvePowerCycleReading } from '../power/powerCycleReading';
import type { DevicePlan, PlanInputDevice } from './planTypes';
import type { PlanEngineState } from './planState';
import {
  computeDailyUsageSoftLimit,
  computeDynamicSoftLimit,
  computeShortfallThreshold,
  isDailyBudgetBelowSustainableCapacity,
} from './planBudget';
import {
  buildPlanContext,
  resolveMeasuredPower,
  type MeasuredPower,
  type PlanContext,
  type PlanLimits,
  type SoftLimitSource,
} from './planContext';
import { buildSheddingPlan, type SheddingPlan } from './shedding';
import {
  NO_STORAGE_RELIEF,
  attachStorageDecisions,
  collectAbsentStorageReleases,
  decideStorageRelief,
  resolveStorageSurplus,
  withoutStorageWithheld,
  type StorageRelief,
} from './battery/storageRelief';
import { applyStorageHandBacks, applyStorageLimits } from './battery/storageLimit';
import { buildSheddingDeps, SilentMeterPlanBuilder } from './planBuilderSilentMeter';
import { resolveShortfallOffState } from './planOffStateReason';
import {
  resolvePostureExcludeIds,
  runStandingPostureHolds,
  withHeldOffOnRelease,
  type PriceOptDeviceConfig,
} from './planBuilderSurplus';
import { resolveSurplusEligibility, type StorageSurplusOffer } from './planSurplusAbsorb';
import { sumBudgetExemptProjectedUsageKw, toMeteredUsageDevices } from './planUsage';
import { PlanMaterializationStages } from './planBuilderMaterialization';
import type { RestorePlanResult } from './restore';
import { trackPlanStage, trackPlanStageAsync } from './planStageTiming';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { incPerfCounter } from '../utils/perfCounters';
import { resolveDailySoftLimitBucket } from './planDailyBudgetWindow';
import {
  ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS,
  recordCleanWholeHomeSample,
} from './admission';
import type { SoftOvershootDecision } from './planOvershoot';
import { OvershootTracker } from './planBuilderOvershoot';
import { buildPlanMeta } from './planBuilderMeta';
import { attachDeferredReleaseIntents } from './planBuilderDecoration';
import type { CapacitySettings } from '../../packages/contracts/src/capacitySettings';

export type { PlanBuilderDeps } from './planBuilderDeps';
const SOFT_LIMIT_EPSILON = 1e-3;
/** A battery's surplus offer moves the `storage_relief_state` log only by a step this large, W. */
const STORAGE_LOG_OFFER_STEP_W = 500;

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

  /** The batteries' holds as last logged (`storage_relief_state`), so the log speaks on change. */
  private lastStorageStateKey = '';

  constructor(private deps: PlanBuilderDeps, private state: PlanEngineState) {
    this.overshootTracker = new OvershootTracker(state, deps);
    this.stages = new PlanMaterializationStages(deps, state);
    this.silentMeter = new SilentMeterPlanBuilder(deps, state, this.stages);
  }

  private get capacityGuard(): CapacityGuard { return this.deps.capacityGuard; }
  private get capacitySettings(): CapacitySettings { return this.deps.getCapacitySettings(); }

  private get priceOptimizationSettings(): Record<string, PriceOptDeviceConfig> {
    return this.deps.getPriceOptimizationSettings();
  }

  private get powerTracker(): PowerTrackerState {
    return this.deps.getPowerTracker();
  }

  private get dailyBudgetSnapshot(): DailyBudgetUiPayload | null {
    return this.deps.getDailyBudgetSnapshot();
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
   * `hourlyBudgetExhausted` before `reportShortfallToGuard`) and the reason and meta
   * passes that label it (`planBuilderMaterialization`, `buildPlanMeta`, both
   * after). While this method also wrote, a caller firing in that window across
   * a capacity-period boundary re-stamped the flag, and the plan explained itself
   * against a period its own decision never saw.
   */
  public computeDynamicSoftLimit(): number {
    return this.resolveCapacityPace(Date.now()).paceKw;
  }

  /**
   * The build's call: the same resolution, plus the two `PlanEngineState` fields
   * the rest of this cycle reads off it. The one writer of both — keep it that
   * way, so "what capacity period is it" is answered once per plan rather than by whoever
   * last asked for the number.
   */
  private stampCapacityPace(nowTs: number): number {
    const resolved = this.resolveCapacityPace(nowTs);
    this.state.hourlyRemainingKWh = resolved.remainingKWh;
    this.state.hourlyBudgetExhausted = resolved.hourlyBudgetExhausted;
    return resolved.paceKw;
  }

  private resolveCapacityPace(nowTs: number): {
    paceKw: number;
    remainingKWh: number;
    hourlyBudgetExhausted: boolean;
  } {
    // Computed unconditionally: the selected period's remaining budget is a fact
    // about that period, not about which pace is in force, so an override replaces the pace
    // and leaves the budget untouched. Resolving it on both paths keeps
    // `hourlyRemainingKWh` a plain number for every consumer.
    const result = computeDynamicSoftLimit(this.capacitySettings, this.powerTracker, nowTs);
    const override = this.deps.getDynamicSoftLimitOverride();
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
   * Shortfall should only trigger when projected selected-period usage would breach the hard cap
   * and no devices are left to shed.
   */
  public computeShortfallThreshold(): number {
    return computeShortfallThreshold(this.capacitySettings, this.powerTracker, Date.now());
  }

  public async buildDevicePlanSnapshot(devices: PlanInputDevice[]): Promise<DevicePlan> {
    return trackPlanStageAsync('plan_build_ms', () => this.buildPlanSnapshotWithTimings(devices));
  }

  private async buildPlanSnapshotWithTimings(devices: PlanInputDevice[]): Promise<DevicePlan> {
    const nowTs = Date.now();
    // Evaluate deferred objectives at the planner boundary and translate active objectives
    // into a plain managed-device shape: a device PELS has no standing authority over
    // gains `commandAuthority` for the cycle (so it participates in shed/restore) without
    // its owner settings being touched, and idle hours seed the shedding shed-set.
    // Cap on/off only decides whether the planner cares about the device this cycle; once
    // admitted, the shedding and restore lanes act on the device with their normal logic and
    // produce their normal reasons.
    const dailyBudgetSnapshot = this.dailyBudgetSnapshot;
    // Hand the device list to the smart-task controller for decoration. The
    // controller evaluates objectives and applies admission / target-overrides /
    // release-intents, returning a smart-task-agnostic bundle. It only READS the
    // committed plan here; the active-plan RECORD (revisions) is written on the
    // lifecycle clock, not on this plan cycle. A home with no smart tasks binds
    // `decorateWithoutDeferredObjectives`, so the identity case arrives through
    // the seam like any other answer.
    const decoration = trackPlanStage('plan_deferred_objective_observe_ms', () => (
      this.deps.decorateDeferredObjectives({ devices, dailyBudgetSnapshot, nowTs })
    ));
    const { admittedDevices } = decoration;

    // One reading per build, resolved by `lib/power` — pure: the silence
    // policy (block + one shed pass) lives in the wiring's composed gate and
    // `lib/power/meterSilence.ts`, never in a planner-held state machine.
    const reading = resolvePowerCycleReading({
      powerTracker: this.powerTracker,
      nowMs: nowTs,
    });
    const context = trackPlanStage('plan_context_ms', () => buildPlanContext(
      admittedDevices,
      this.capacitySettings,
      this.powerTracker,
      this.resolvePlanLimits(admittedDevices, dailyBudgetSnapshot, nowTs),
      // After the decoration, which is what stamps a smart task's deadline floor.
      this.deps.resolveTemperatureSetpoints(admittedDevices),
      nowTs,
    ));
    // THE seam. The ordinary pipeline below is entered only with a measurement,
    // so nothing inside it asks whether power was measured; the one unmeasured
    // build — the silent-meter fail-closed pass — takes its directive here and
    // never constructs a `MeasuredPower` (owner ruling 2026-09-02).
    if (!reading.isMeasured) {
      return this.silentMeter.build(context, reading, decoration, nowTs);
    }
    const power = resolveMeasuredPower(reading, context, admittedDevices);
    const shortfallBudgetThresholdKw = computeShortfallThreshold(
      this.capacitySettings, this.powerTracker, nowTs,
    );
    // Smart-task precedence for the standing postures, shared by the
    // allocator and the hold so the two can never disagree.
    const postureExcludeIds = resolvePostureExcludeIds(decoration, admittedDevices);
    const surplusOffers = this.allocateSurplus(context, power, postureExcludeIds, nowTs);
    // Restore and admission never spend the discharge PELS holds, nor a charge
    // increase not measured yet (`admissionPower`): the battery protects what
    // is running, it does not make room for more.
    const {
      sheddingPlan, overshootDecision, storageRelief: limitedStorage, admissionPower,
    } = await this.decideShedding(context, power, surplusOffers, shortfallBudgetThresholdKw, nowTs);
    // The "Run on solar surplus" dump-load hold + the post-shedding hold
    // merges; returns the dump-load reason map for reason normalization.
    const postureHolds = trackPlanStage('plan_posture_holds_ms', () => runStandingPostureHolds({
      state: this.state,
      admittedDevices,
      shedSet: sheddingPlan.shedSet,
      shedStepTargets: sheddingPlan.shedStepTargets,
      decoration,
      excludeIds: postureExcludeIds,
      getConfig: (deviceId) => this.priceOptimizationSettings[deviceId],
      leaveOffOnRelease: this.deps.leaveOffOnRelease,
    }));
    // A hold the posture pass just recorded is part of this build's input from
    // here on, exactly as the producer will report it next build: without it
    // the restore lane below would resume the device the hold exists to keep off.
    const heldContext = withHeldOffOnRelease(context, postureHolds.heldOffOnReleaseIds);

    let planDevices = this.stages.buildPlanDevices(
      heldContext,
      sheddingPlan,
      resolveShortfallOffState(sheddingPlan.guardInShortfall, power.headroomKw),
    );
    const restoreResult = this.stages.applyRestorePlan(
      planDevices, heldContext, admissionPower, sheddingPlan, limitedStorage.levers,
    );
    planDevices = restoreResult.planDevices;
    const storageRelief = this.handBackStorage(limitedStorage, restoreResult, power, surplusOffers);

    const holdResult = this.stages.applyHoldPlan(
      planDevices,
      restoreResult,
      sheddingPlan,
      heldContext.temperatureSetpoints,
    );
    planDevices = holdResult.planDevices;

    planDevices = this.stages.normalizeReasons({
      planDevices,
      context: heldContext,
      power: admissionPower,
      restoreResult,
      sheddingPlan,
      holds: {
        deferredObjectiveAvoidDeviceIds: decoration.deferredAvoidDeviceIds,
        postureHoldReasonById: postureHolds.reasonById,
      },
      holdResult,
    });
    planDevices = attachDeferredReleaseIntents(planDevices, decoration.deferredReleaseIntentByDeviceId, true);
    this.stages.syncHeadroomCardState(planDevices, nowTs);
    const decidedDevices = attachStorageDecisions(
      this.stages.finalizePlan(planDevices, heldContext.temperatureSetpoints).planDevices, storageRelief,
    );
    // Which devices this plan holds shed and under which posture — semantics
    // on `ShedDecisions.recordPlannedShed`.
    this.state.shedDecisions.recordPlannedShed(
      decidedDevices, decoration, this.deps.pendingBinaryCommandStore, !this.deps.getCapacityDryRun(),
    );
    trackPlanStage('plan_overshoot_ms', () => this.overshootTracker.updateOvershootState({
      context: heldContext,
      power,
      reading,
      capacityLimitKw: this.capacitySettings.limitKw,
      shortfallBudgetThresholdKw,
      powerTracker: this.powerTracker,
      deviceNameById: new Map(admittedDevices.map((d) => [d.id, d.name])),
      planDevices: decidedDevices,
      overshootDecision,
      nowTs,
    }));

    const meta = trackPlanStage('plan_meta_ms', () => buildPlanMeta({
      context: heldContext,
      reading,
      planDevices: decidedDevices,
      dailyBudgetSnapshot,
      powerTracker: this.powerTracker,
      capacityGuard: this.capacityGuard,
      capacityLimitKw: this.capacitySettings.limitKw,
      shortfallBudgetThresholdKw,
      hourlyBudgetExhausted: this.state.hourlyBudgetExhausted,
    }, power));
    this.stages.observeDiagnostics({
      context: heldContext,
      power,
      planDevices: decidedDevices,
      restoreResult,
      budgetPressureEligible: isDailyBudgetBelowSustainableCapacity(dailyBudgetSnapshot, this.capacitySettings),
      smartTaskDrivingDeviceIds: decoration.drivingDeviceIds,
      nowTs,
    });
    return {
      meta,
      devices: decidedDevices,
      storageReleases: collectAbsentStorageReleases(decidedDevices, storageRelief),
    };
  }

  /**
   * The limits this cycle is decided against — one resolution, held by the
   * frame both passes build. Stamps the capacity pace into the engine state
   * (`hourlyRemainingKWh`, `hourlyBudgetExhausted`) as a side effect, exactly
   * as before.
   */
  private resolvePlanLimits(
    devices: PlanInputDevice[], dailyBudgetSnapshot: DailyBudgetUiPayload | null, nowTs: number,
  ): PlanLimits {
    const capacitySoftLimit = this.stampCapacityPace(nowTs);
    const dailySoftLimitResolution = this.computeDailySoftLimit(dailyBudgetSnapshot, devices, nowTs);
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

  /**
   * The priority-greedy surplus allocator, between measurement and storage
   * relief: eligibility exists as the shed set is assembled, and each home
   * battery is offered what the consumers ranked above it left (surplus by
   * priority; a battery last is devices, then the battery, then export). The
   * batteries are resolved here, so the allocator reads no battery: under
   * capacity simulation no battery is claimable, so they carry only their
   * discharge.
   */
  private allocateSurplus(
    context: PlanContext,
    power: MeasuredPower,
    excludeIds: ReadonlySet<string>,
    nowTs: number,
  ): ReadonlyMap<string, StorageSurplusOffer> {
    const storage = resolveStorageSurplus(context.devices, this.state.storageLeverByDevice, power.drawKw * 1000);
    return trackPlanStage('plan_surplus_eligibility_ms', () => resolveSurplusEligibility({
      devices: context.devices,
      state: this.state,
      // Producer-resolved: the signed net is always a number (the carried reading).
      signedNetKw: power.drawKw,
      inferredSurplusKw: this.deps.getInferredSurplusKw(),
      storage,
      excludeIds,
      getConfig: (deviceId) => this.priceOptimizationSettings[deviceId],
      debugStructured: this.deps.debugStructured,
      nowTs,
    }));
  }

  private async decideShedding(
    context: PlanContext,
    power: MeasuredPower,
    surplusOffers: ReadonlyMap<string, StorageSurplusOffer>,
    shortfallBudgetThresholdKw: number,
    nowTs: number,
  ): Promise<{
    sheddingPlan: SheddingPlan;
    overshootDecision: SoftOvershootDecision;
    storageRelief: StorageRelief;
    admissionPower: MeasuredPower;
  }> {
    // The batteries' holds as this reading leaves them, and the surplus each
    // battery stores from its offer (`lib/plan/battery/storageRelief.ts`). A held discharge
    // still settling is credited as a decision, not a measurement: shedding and
    // the overshoot grace that gates it count it as their own term, and
    // everything else keeps the measured draw. Whether a battery is limited
    // further is shedding's choice, at its place in the priority order.
    const heldStorage = this.deps.getCapacityDryRun()
      ? NO_STORAGE_RELIEF
      : decideStorageRelief(context.devices, power, this.state.storageLeverByDevice, surplusOffers, nowTs);
    const overshootDecision = this.state.overshoot.decideSoft(
      power.headroomKw + heldStorage.shed.netCreditKw,
      // Stamped by `stampCapacityPace` in `resolvePlanLimits`, from the same
      // hourly budget the soft limit itself is paced against.
      this.state.hourlyRemainingKWh,
      // Only price a wait when a restore PELS issued is still settling.
      this.hasOpenActivationAttempt(nowTs),
      nowTs,
    );
    // A clean whole-home sample: the house is under its pace, and the hour is
    // not spent (an exhausted hour admits nothing, however the draw reads).
    if (power.headroomKw >= 0 && !this.state.hourlyBudgetExhausted) {
      this.recordCleanWholeHomeSample(context.devices, this.powerTracker.lastTimestamp);
    }

    // `buildSheddingPlan` takes the WHOLE decision, not just the shed half: the
    // shedding-active latch must stay engaged through a grace window, or every
    // restore lane that defers to it releases the devices already limited
    // (`lib/plan/shedding/AGENTS.md`).
    const sheddingPlan = await trackPlanStageAsync(
      'plan_shedding_ms',
      () => buildSheddingPlan(
        context, power, this.state, buildSheddingDeps(this.deps, shortfallBudgetThresholdKw),
        // Shedding prices a held battery from its hold (`heldStorage.levers`).
        overshootDecision, nowTs, heldStorage,
      ),
    );
    this.applySheddingOutcome(sheddingPlan);
    // The battery limits shedding chose at their place in the priority order.
    // The restore lane reads the holds next (`storageRelief.levers`), to hand
    // back in that order.
    const storageRelief = applyStorageLimits(heldStorage, sheddingPlan.storageSetpoints, nowTs);

    return {
      sheddingPlan, overshootDecision, storageRelief, admissionPower: withoutStorageWithheld(power, storageRelief),
    };
  }

  /**
   * Release the battery limit holds the restore pass handed back, and keep
   * the holds this build leaves for the next one: the one write of
   * `PlanEngineState.storageLeverByDevice` in a measured build. Every stage
   * before it is handed the holds it reads. The restore clocks are stamped by
   * the executor's storage lane once the owner has actually handed the
   * battery back, as a confirmed load restore is.
   */
  private handBackStorage(
    limitedStorage: StorageRelief,
    restoreResult: RestorePlanResult,
    power: MeasuredPower,
    surplusOffers: ReadonlyMap<string, StorageSurplusOffer>,
  ): StorageRelief {
    const storageRelief = applyStorageHandBacks(limitedStorage, restoreResult.storageHandedBack);
    this.state.storageLeverByDevice = storageRelief.levers;
    this.logStorageRelief(storageRelief, power, surplusOffers);
    return storageRelief;
  }

  /**
   * Why a deficit was or was not shed, and why a battery charges, from the
   * logs alone: the credit or hand-back debit shedding counted whenever it
   * moved the measured deficit, and each battery's hold whenever it changes,
   * with the surplus offer a charge came from.
   */
  private logStorageRelief(
    relief: StorageRelief,
    power: MeasuredPower,
    surplusOffers: ReadonlyMap<string, StorageSurplusOffer>,
  ): void {
    const { netCreditKw } = relief.shed;
    if (netCreditKw !== 0 && (power.headroomKw < 0 || netCreditKw < 0)) {
      this.deps.structuredLog?.info({
        event: 'storage_relief_shed_term',
        netCreditKw,
        measuredDeficitKw: Math.max(0, -power.headroomKw),
        neededKw: Math.max(0, -power.headroomKw - netCreditKw),
        relieving: relief.shed.relieving,
      });
    }
    // Speaks on a changed hold or claim reason, a changed demand above a
    // battery, or an offer that moved by a step of `STORAGE_LOG_OFFER_STEP_W`;
    // never in a home without a battery, and once when the last one leaves the plan.
    const surplusOffersLog = [...surplusOffers].map(([deviceId, offer]) => ({
      deviceId, availableW: Math.round(offer.availableW), demandAbove: offer.demandAbove,
    }));
    const stateKey = relief.batteries.length === 0 ? '' : JSON.stringify({
      batteries: relief.batteries.map(({ creditW: _creditW, withheldW: _withheldW, ...battery }) => battery),
      offers: surplusOffersLog.map(({ availableW, ...offer }) => ({
        ...offer, availableStep: Math.round(availableW / STORAGE_LOG_OFFER_STEP_W),
      })),
    });
    if (stateKey === this.lastStorageStateKey) return;
    this.lastStorageStateKey = stateKey;
    this.deps.structuredLog?.info({
      event: 'storage_relief_state',
      batteries: relief.batteries,
      // The holds this cycle decided, not what restore withholds
      // (`StorageStateSummary.withheldW`), which still counts a battery's observed
      // discharge until it follows a step down.
      heldDischargeKw: relief.batteries.reduce((totalW, battery) => totalW + Math.max(0, -battery.setpointW), 0) / 1000,
      heldChargeKw: relief.batteries.reduce((totalW, battery) => totalW + Math.max(0, battery.setpointW), 0) / 1000,
      surplusOffers: surplusOffersLog,
    });
  }

  /**
   * Is any activation attempt still open — i.e. did PELS restore a device
   * recently enough that its draw may still be ramping? This is the signal that
   * a capacity deficit right now might be a transient of PELS's own making
   * rather than a settled rate. Bounded by the attribution window, which
   * `syncActivationPenaltyState` also uses to close a stalled attempt.
   */
  private hasOpenActivationAttempt(nowTs: number): boolean {
    for (const attempt of Object.values(this.state.activationAttemptByDevice)) {
      const elapsed = nowTs - attempt.startedMs;
      if (elapsed >= 0 && elapsed < ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS) return true;
    }
    return false;
  }

  private recordCleanWholeHomeSample(devices: PlanInputDevice[], sampleAtMs: number | undefined): void {
    if (sampleAtMs === undefined) return;
    for (const device of devices) {
      recordCleanWholeHomeSample(this.state, device.id, sampleAtMs);
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
    nowTs: number,
  ): DailySoftLimitResolution | null {
    const bucket = resolveDailySoftLimitBucket(snapshot, this.powerTracker, nowTs);
    if (!bucket) return null;
    // No `?? 0` here any more. The sum used to return `null` when exempt devices
    // existed but none reported power, and defaulting that to 0 shortened the
    // daily threshold by the exempt draw — non-exempt devices were shed for a
    // missing reading rather than for real budget pressure. Every metered plan
    // device carries a resolved draw, and a device without a reading has no
    // power axis to sum, so the unresolved state is gone.
    const projectedExemptKw = Math.max(0, sumBudgetExemptProjectedUsageKw(
      toMeteredUsageDevices(devices),
      (device) => device.control.commandAuthority,
    ));
    const budgetPaceKw = computeDailyUsageSoftLimit(bucket, nowTs);
    // Budget-exempt load should not trigger daily-budget shedding of other devices.
    // Remove exempt energy already metered this hour, then add back the exempt live
    // run rate so the effective daily limit still allows that load to remain on.
    return {
      budgetPaceKw,
      projectedExemptKw,
      dailySoftLimitKw: budgetPaceKw + projectedExemptKw,
    };
  }

  private applySheddingOutcome(sheddingPlan: SheddingPlan): void {
    this.state.applySheddingOutcome(sheddingPlan.outcome, sheddingPlan.recoveredAtMs);
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
