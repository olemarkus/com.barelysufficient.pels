/**
 * The silent-meter pass: the ONE plan build that runs without a measurement.
 *
 * When a home's meter has been silent past `POWER_SAMPLE_STALE_SHED_TIMEOUT_MS`
 * the escalation clock (`setup/powerSampleFreshnessEscalation.ts`) runs one
 * rebuild so the house sheds rather than holding an "under cap" decision taken
 * before the meter died, and the composed plan-build gate then blocks every
 * further rebuild until an admitted sample returns (`lib/power/meterSilence.ts`).
 *
 * That build used to run the ordinary pipeline on a sentinel `-1` headroom —
 * so it shed "about 1 kW" of devices, a policy nobody chose, and every
 * consumer of the meta did arithmetic on the sentinel. Owner ruling
 * 2026-09-02: the pass takes an explicit DIRECTIVE instead — shed every
 * candidate to its floor (the shape an exhausted hour already uses) — and the
 * ordinary pipeline is entered only with a measurement, so nothing inside it
 * asks whether power was measured. This module is the whole unmeasured path:
 * it never constructs a `MeasuredPower`, and its meta is the unmeasured
 * variant, with no headroom to publish.
 *
 * Reconciling two rulings: 2026-08-16 said a home whose meter NEVER reports is
 * better left as is than "turning off the entire house" — that home builds no
 * plan at all (`lib/power/powerMeasurementGate.ts`). This pass is the other
 * case, a meter that died mid-run, ruled on 2026-08-31: shed, don't hold. And
 * a shed is to the FLOOR, not to off — a stepped device lands on its lowest
 * step, a thermostat on its shed setpoint (`feedback_step_only_stepper_valid`).
 */
import type { SilentMeterReading } from '../power/powerCycleReading';
import { computeShortfallThreshold } from './planBudget';
import type { PlanBuilderDeps } from './planBuilderDeps';
import { attachDeferredReleaseIntents } from './planBuilderDecoration';
import type { PlanMaterializationStages } from './planBuilderMaterialization';
import { buildUnmeasuredPlanMeta } from './planBuilderMeta';
import type { PlanContext } from './planContext';
import type { PlanEngineState } from './planState';
import type { DevicePlan } from './planTypes';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { resolveNormalizedShedFloors } from './normalizedShedFloor';
import { runSilentMeterSurplusHold } from './planBuilderSurplus';
import {
  buildSheddingCandidates,
  resolveShedReason,
  selectShedDevices,
  type SheddingDeps,
  type SheddingPlan,
} from './shedding';
import type { DeferredDecorationBundle } from '../../packages/planner-types/src/deferredDecoration';

/**
 * The shedding module's dependencies, from the builder's. Shared with the
 * ordinary pipeline so the two passes price candidates identically.
 */
export function buildSheddingDeps(deps: PlanBuilderDeps, shortfallThresholdKw: number): SheddingDeps {
  return {
    capacityGuard: deps.capacityGuard,
    shortfallThresholdKw,
    powerTracker: deps.getPowerTracker(),
    getShedBehavior: (deviceId) => deps.getShedBehavior(deviceId),
    pendingBinaryCommandStore: deps.pendingBinaryCommandStore,
    log: (...args: unknown[]) => deps.log(...args),
    debugStructured: deps.debugStructured,
    structuredLog: deps.structuredLog,
  };
}

export class SilentMeterPlanBuilder {
  constructor(
    private readonly deps: PlanBuilderDeps,
    private readonly state: PlanEngineState,
    private readonly stages: PlanMaterializationStages,
  ) { }

  build(
    context: PlanContext,
    reading: SilentMeterReading,
    decoration: DeferredDecorationBundle,
    nowTs: number,
  ): DevicePlan {
    const capacitySettings = this.deps.getCapacitySettings();
    const powerTracker = this.deps.getPowerTracker();
    const shortfallBudgetThresholdKw = computeShortfallThreshold({ capacitySettings, powerTracker });
    const sheddingPlan = this.shedEverything(context, shortfallBudgetThresholdKw, nowTs);
    // No measurement means no surplus: every surplus-only load is held, with
    // its own reason, exactly as a collapsed surplus would hold it.
    const surplusHoldReasonById = runSilentMeterSurplusHold(
      context, this.state, decoration.admittedDevices, sheddingPlan.shedSet, sheddingPlan.shedStepTargets, decoration,
      { getConfig: (deviceId) => this.deps.getPriceOptimizationSettings()[deviceId], nowTs },
    );
    for (const [id, reason] of surplusHoldReasonById) sheddingPlan.shedReasons.set(id, reason);
    // A smart task's forced shed rides in through the hold merge with no reason
    // of its own (the measured pipeline's reason normalization, which the pass
    // does not run, would name it); the directive names it here.
    for (const id of sheddingPlan.shedSet) {
      if (!sheddingPlan.shedReasons.has(id)) sheddingPlan.shedReasons.set(id, this.directiveReason());
    }

    let planDevices = this.stages.buildPlanDevices(context, sheddingPlan, { inShortfall: false });
    // Smart-task release intents still ride the plan (a release is a negative
    // command, safe without a measurement); a `binary_restore` is the one
    // positive intent and needs a measured cycle, which this is not.
    planDevices = attachDeferredReleaseIntents(planDevices, decoration.deferredReleaseIntentByDeviceId, false);
    this.stages.syncHeadroomCardState(planDevices);
    const finalized = this.stages.finalizePlan(
      planDevices,
      resolveNormalizedShedFloors(context.devices, (deviceId) => this.deps.getShedBehavior(deviceId)),
    );
    // Decision-time shed clock: the cooldowns that follow a shed apply to this
    // one like any other, so the first measured cycle after the meter returns
    // does not restore everything at once.
    this.state.recordPlannedShedDecisions({
      shedIds: finalized.lastPlannedShedIds,
      surplusOnlyIds: new Set(context.devices.filter((dev) => dev.surplusOnly === true).map((dev) => dev.id)),
      nowTs,
    });
    this.deps.structuredLog?.info({
      event: 'plan_silent_meter_pass',
      shedDeviceCount: sheddingPlan.shedSet.size,
      candidateDeviceCount: context.devices.filter((dev) => dev.controllable).length,
      lastPowerUpdateMs: reading.lastPowerUpdateMs,
    });

    return {
      meta: buildUnmeasuredPlanMeta({
        context,
        reading,
        planDevices: finalized.planDevices,
        dailyBudgetSnapshot: this.deps.getDailyBudgetSnapshot?.() ?? null,
        powerTracker,
        capacityGuard: this.deps.capacityGuard,
        capacityLimitKw: capacitySettings.limitKw,
        shortfallBudgetThresholdKw,
        hourlyBudgetExhausted: this.state.hourlyBudgetExhausted,
      }),
      devices: finalized.planDevices,
    };
  }

  /**
   * The directive: every candidate, to its floor. Infinity is the shedding
   * module's own spelling of "maximum severity" (the exhausted hour passes it
   * too): selection never stops early, the recent-restore grace is bypassed,
   * and a stepped device takes its deepest rung.
   *
   * State: the shedding latch engages (so the first measured cycle re-decides
   * before any restore lane runs) and the instability clock stamps, exactly as
   * a measured shed would. The same-measurement withholding stamps
   * (`lastShedPlan*`) are NOT written — they hold a shed against a reading, and
   * there is none.
   */
  /**
   * The pass is a CAPACITY fail-closed: with no measurement the house may be
   * over its cap, so the reason and the candidate policy are capacity's — a
   * daily-pace home's budget-exempt devices are not spared (under a daily
   * source they would be), because the exemption is from the budget, not
   * from a meter that has gone silent.
   */
  private directiveReason(): DeviceReason {
    return resolveShedReason('capacity', false, this.state.hourlyBudgetExhausted);
  }

  private shedEverything(context: PlanContext, shortfallThresholdKw: number, nowTs: number): SheddingPlan {
    const deps = buildSheddingDeps(this.deps, shortfallThresholdKw);
    const { candidates } = buildSheddingCandidates({
      devices: context.devices,
      needed: Number.POSITIVE_INFINITY,
      deficitKw: Number.POSITIVE_INFINITY,
      limitSource: 'capacity',
      capacityBreached: false,
      state: this.state,
      deps,
    });
    const selection = selectShedDevices({
      candidates,
      needed: Number.POSITIVE_INFINITY,
      reason: this.directiveReason(),
      debugStructured: this.deps.debugStructured,
      shedAllCandidates: true,
    });
    // Every controllable device the candidate walk did not pick is shed too:
    // a device already off, a thermostat already at its shed setpoint, a
    // stepper at its floor — none of them is a candidate (there is nothing
    // left to shed), and a `keep` on any of them is exactly the load-adding
    // write the executor would issue (a turn-on, the mode setpoint back up).
    // Without a measurement nothing admits that, so the directive names them.
    for (const dev of context.devices) {
      if (!dev.controllable || selection.shedSet.has(dev.id)) continue;
      selection.shedSet.add(dev.id);
      selection.shedReasons.set(dev.id, this.directiveReason());
    }
    if (selection.shedSet.size > 0) {
      this.state.sheddingActive = true;
      this.state.lastInstabilityMs = nowTs;
      this.state.lastOvershootMitigationMs = nowTs;
    }
    return {
      ...selection,
      sheddingActive: this.state.sheddingActive,
      guardInShortfall: false,
      updates: {},
      overshootStats: null,
    };
  }
}
