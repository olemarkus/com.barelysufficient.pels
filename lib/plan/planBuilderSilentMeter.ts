/**
 * The silent-meter pass: the ONE plan build that runs without a measurement.
 *
 * When a home's meter has been silent past `POWER_SAMPLE_STALE_SHED_TIMEOUT_MS`
 * the escalation clock (`lib/power/meterSilenceEscalation.ts`) runs one
 * rebuild so the house sheds rather than holding an "under the limits" decision taken
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
 *
 * Which directive the pass takes depends on the home's limits (owner ruling
 * 2026-11-28, superseding the 2026-08-31 "shed even with both limits off"
 * clause). With a limit that only the meter can enforce on — Capacity limit,
 * Grid import limit, main fuse protection or a daily budget
 * (`hasMeterDependentLimit`) — the house may be over it unseen, so the pass
 * sheds. With none on there is nothing to breach, and the pass HOLDS: every
 * device stays as it is (`leaveAsIs`), and only what needs a measurement is
 * released — surplus-only loads held, batteries handed back, curtailment
 * lifted. Either pass is the one the silence is owed; a limit turned on during
 * a hold owes the shed (`lib/power/meterSilence.ts`).
 *
 * "Every candidate" means every device with a power reading. A temperature
 * device planned without one takes no power logic at all (owner ruling
 * 2026-09-23), this pass included: it keeps following its mode target. It was
 * not planned at all before that ruling, so it was never shed here either.
 */
import { isMeteredPlanDevice } from './planMeteredDevice';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { deferredHoldReason } from './planReasons';
import { hasMeterDependentLimit } from '../power/meterDependentLimit';
import type { SilentMeterDirective } from '../../packages/contracts/src/meterOutage';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import type { SilentMeterReading } from '../power/powerCycleReading';
import type { HeldPowerLimitSettings } from '../power/heldCapacityLimit';
import type { PlanBuilderDeps } from './planBuilderDeps';
import { attachDeferredReleaseIntents } from './planBuilderDecoration';
import type { PlanMaterializationStages } from './planBuilderMaterialization';
import { buildUnmeasuredPlanMeta } from './planBuilderMeta';
import type { PlanContext } from './planContext';
import { NO_SHEDDING_OUTCOME, type PlanEngineState } from './planState';
import type { DevicePlan, DevicePlanDevice, TemperatureKind } from './planTypes';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import { temperatureSetpointsFor } from './planTemperatureSetpoints';
import type { TemperatureSetpointsByDevice } from '../../packages/planner-types/src/temperatureSetpoints';
import { PLAN_REASON_CODES, type DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { runSilentMeterSurplusHold } from './planBuilderSurplus';
import {
  attachStorageDecisions, collectAbsentStorageReleases, releaseStorageOnSilentMeter,
} from './battery/storageRelief';
import {
  buildSheddingCandidates,
  selectShedDevices,
  type SheddingDeps,
  type SheddingPlan,
} from './shedding';
import type { DeferredDecorationBundle } from '../../packages/planner-types/src/deferredDecoration';

/**
 * The directive names every controllable device, so it names one whose limit
 * sits on the DEMAND side of its target too — a heating floor above the target,
 * a cooling ceiling below it. Commanding that limit would make the device work
 * harder, and commanding the mode target instead may as well; with no
 * measurement neither is admissible. The device is held where it is: limited, at
 * the target it holds now. The measured pipeline never gets here for such a
 * device, because its shed candidate is skipped (`limit_would_add_demand`).
 */
function holdShortOfDemandSideLimit(
  dev: DevicePlanDevice,
  temperatureSetpoints: TemperatureSetpointsByDevice,
): DevicePlanDevice {
  if (dev.plannedState !== 'shed' || dev.shedAction !== 'set_temperature' || !isTemperaturePlanDevice(dev)) return dev;
  const { shed } = temperatureSetpointsFor(temperatureSetpoints, dev.id);
  if (shed.action !== 'set_temperature' || shed.releasesDemand) return dev;
  const held: DevicePlanDevice & TemperatureKind = {
    ...dev,
    shedTemperature: dev.currentTarget,
    plannedTarget: dev.currentTarget,
  };
  return held;
}

/**
 * The hold directive for one device: as it is, neither limited nor resumed
 * (owner ruling 2026-11-28). A device the plan holds for its own reason (a
 * standing posture, a smart task's hour, the surplus hold) keeps it, and so
 * does an off device whose off has a cause of its own (`applyOffStateReason`).
 * A device PELS kept is pinned where it is: an on device keeps its setpoint
 * and step, an off one stays off with no keep intent to turn it on.
 */
function leaveAsIs(dev: DevicePlanDevice): DevicePlanDevice {
  if (!dev.control.commandAuthority || dev.plannedState !== 'keep') return dev;
  const reason: DeviceReason = { code: PLAN_REASON_CODES.meterSilentHold };
  if (dev.currentState === 'off') return { ...dev, plannedState: 'inactive', reason };
  const stepped = isSteppedLoadDevice(dev) ? { desiredStepId: dev.selectedStepId } : {};
  const pinned: DevicePlanDevice = { ...dev, ...stepped, reason };
  if (!isTemperaturePlanDevice(pinned)) return pinned;
  const held: DevicePlanDevice & TemperatureKind = {
    ...pinned,
    plannedTarget: pinned.currentTarget,
    priceTargetShift: { kind: 'none' },
  };
  return held;
}

/**
 * The shedding module's dependencies, from the builder's. Shared with the
 * ordinary pipeline so the two passes price candidates identically.
 */
export function buildSheddingDeps(deps: PlanBuilderDeps): SheddingDeps {
  return {
    capacityGuard: deps.capacityGuard,
    powerTracker: deps.getPowerTracker(),
    getShedBehavior: (deviceId) => deps.getShedBehavior(deviceId),
    pendingBinaryCommandStore: deps.pendingBinaryCommandStore,
    structuredLog: deps.structuredLog,
  };
}

export class SilentMeterPlanBuilder {
  constructor(
    private readonly deps: PlanBuilderDeps,
    private readonly state: PlanEngineState,
    private readonly stages: PlanMaterializationStages,
  ) { }

  /**
   * `settings`, the daily budget snapshot and the context’s capacity axis are
   * the build's own — read and resolved once by `PlanBuilder` for the whole
   * cycle — never a second read here that a settings write could have moved.
   */
  build(
    context: PlanContext,
    reading: SilentMeterReading,
    decoration: DeferredDecorationBundle,
    settings: HeldPowerLimitSettings,
    dailyBudgetSnapshot: DailyBudgetUiPayload | null,
    nowTs: number,
  ): DevicePlan {
    const powerTracker = this.deps.getPowerTracker();
    const directive: SilentMeterDirective = hasMeterDependentLimit(
      settings, this.deps.getMainFuse(), dailyBudgetSnapshot,
    ) ? 'shed' : 'hold';
    const sheddingPlan = directive === 'shed' ? this.shedEverything(context, nowTs) : this.holdNothing();
    // No measurement means no surplus: every surplus-only load is held, with
    // its own reason, exactly as a collapsed surplus would hold it.
    const surplusHoldReasonById = runSilentMeterSurplusHold(
      context, this.state, sheddingPlan, decoration, nowTs, this.deps,
    );
    for (const [id, reason] of surplusHoldReasonById) sheddingPlan.shedReasons.set(id, reason);
    // A smart task's forced shed rides in through the hold merge with no reason
    // of its own (the measured pipeline's reason normalization, which the pass
    // does not run, would name it). The shed directive names it as limited by
    // the outage; the hold limited nothing, so it names the task's own cause.
    for (const id of sheddingPlan.shedSet) {
      if (sheddingPlan.shedReasons.has(id)) continue;
      const holdCause = directive === 'hold' ? decoration.deferredHoldCauseByDeviceId.get(id) : undefined;
      sheddingPlan.shedReasons.set(id, holdCause ? deferredHoldReason(holdCause) : this.directiveReason());
    }

    let planDevices = this.stages.buildPlanDevices(context, sheddingPlan)
      .map((dev) => holdShortOfDemandSideLimit(dev, context.temperatureSetpoints));
    if (directive === 'hold') planDevices = planDevices.map(leaveAsIs);
    // Smart-task release intents still ride the plan (a release is a negative
    // command, safe without a measurement); a `binary_restore` is the one
    // positive intent and needs a measured cycle, which this is not.
    planDevices = attachDeferredReleaseIntents(
      planDevices, decoration.deferredReleaseIntentByDeviceId, false, this.deps.getShedBehavior,
    );
    const finalized = this.stages.finalizePlan(
      planDevices,
      context.temperatureSetpoints,
      nowTs,
    );
    // No measurement, no deficit to relieve: every battery PELS holds is handed
    // back, and the loads are shed to their floor exactly as without one.
    const storageRelief = releaseStorageOnSilentMeter(context.devices, this.state.storageLeverByDevice);
    this.state.storageLeverByDevice = storageRelief.levers;
    const decidedDevices = attachStorageDecisions(finalized.planDevices, storageRelief);
    // Recorded like any other shed: the first measured cycle after the meter
    // returns sees every device in shed posture, so each one resumes through
    // admission rather than everything at once. The hold limited nothing and
    // records nothing: a device limited before the outage keeps its record,
    // so it still resumes through admission once readings return.
    if (directive === 'shed') {
      this.state.shedDecisions.recordPlannedShed(
        decidedDevices, decoration, this.deps.pendingBinaryCommandStore, !this.deps.getCapacityDryRun(),
      );
    }
    this.deps.structuredLog.info({
      event: 'plan_silent_meter_pass',
      directive,
      shedDeviceCount: sheddingPlan.shedSet.size,
      // Counted as the candidate walk counts: commandable AND with a power reading.
      candidateDeviceCount: context.devices
        .filter((dev) => dev.control.commandAuthority && isMeteredPlanDevice(dev)).length,
      lastPowerUpdateMs: reading.lastPowerUpdateMs,
    });

    return {
      meta: buildUnmeasuredPlanMeta({
        context,
        reading,
        planDevices: decidedDevices,
        dailyBudgetSnapshot,
        powerTracker,
        capacityGuard: this.deps.capacityGuard,
        capacityLimitKw: settings.limitKw,
        hardCapSource: settings.hardCapSource,
        configuredHardCapLimitKw: settings.configuredLimitKw,
        hourlyBudgetExhausted: this.state.capacityPeriodSpentFor(context),
        unrelievedPhase: null,
        exportPhase: null,
        simulatedReliefKw: null,
      }, directive),
      // Left as it is, a device is turned on or up by nothing: not a keep
      // intent on a device that switched off after this build, not a step.
      ...(directive === 'hold' ? { ordinaryStartsHeld: true as const } : {}),
      devices: decidedDevices,
      inverterDecisions: this.deps.inverterCurtailment.releaseAll(),
      chargingPhaseDecisions: this.state.chargingPhaseCycle.decisions()
        .filter((decision) => decision.kind === 'release'),
      storageReleases: collectAbsentStorageReleases(decidedDevices, storageRelief),
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
   * The shed directive is a METER fail-closed, whichever limit it protects.
   * With no measurement the house may be over whichever limits are on — the
   * hard cap, the grid import limit, the main fuse, the day's budget — so the
   * honest cause is the same in every mode, Capacity limit on included: the
   * meter stopped reporting, and the device needs a new reading, not freed
   * power, to resume (`meterSilent`). Naming a ceiling here would be a guess:
   * under `capacity` the device detail and the activity log read "Limited by
   * the hard cap" even with Capacity limit off. An exhausted hour no longer
   * renames it `hourlyBudget` either: the pass sheds on the meter, not on the
   * hour's energy.
   *
   * It is also why the candidate policy below names no limit source: no pace
   * binds this pass, so a daily-pace home's budget-exempt devices are not
   * spared (under a daily source they would be) — the exemption is from the
   * budget, not from a meter that has gone silent.
   */
  private directiveReason(): DeviceReason {
    return { code: PLAN_REASON_CODES.meterSilent };
  }

  /**
   * The hold directive's shedding plan: nothing selected. The standing
   * postures and the surplus hold still ride in through
   * `runSilentMeterSurplusHold`, as in the shed directive. Neither the shedding
   * latch nor the instability clock moves: nothing was limited.
   */
  private holdNothing(): SheddingPlan {
    return {
      shedSet: new Set(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      storageSetpoints: new Map(),
      sheddingActive: this.state.sheddingActive,
      guardInShortfall: false,
      outcome: NO_SHEDDING_OUTCOME,
      recoveredAtMs: null,
      unrelievedPhase: null,
      phaseExportExcessKw: 0,
      exportPhase: null,
    };
  }

  private shedEverything(context: PlanContext, nowTs: number): SheddingPlan {
    const deps = buildSheddingDeps(this.deps);
    const { candidates, diagnostics } = buildSheddingCandidates({
      bypassRecentRestore: false,
      devices: context.devices,
      needed: Number.POSITIVE_INFINITY,
      deficitKw: Number.POSITIVE_INFINITY,
      // The directive, not a pace (`directiveReason`): every device is a candidate.
      limitSource: 'none',
      physicalLimitBreached: false,
      temperatureSetpoints: context.temperatureSetpoints,
      // No measurement to bound a battery's discharge by: every battery is handed back instead.
      storageLimit: { kind: 'unmeasured' },
      state: this.state,
      deps,
    }, context.nowTs);
    diagnostics.emit();
    const selection = selectShedDevices(
      candidates,
      Number.POSITIVE_INFINITY,
      this.directiveReason(),
      true,
      { kind: 'directive' },
    );
    // Every controllable device the candidate walk did not pick is shed too:
    // a device already off, a thermostat already at its shed setpoint, a
    // stepper at its floor — none of them is a candidate (there is nothing
    // left to shed), and a `keep` on any of them is exactly the load-adding
    // write the executor would issue (a turn-on, the mode setpoint back up).
    // Without a measurement nothing admits that, so the directive names them.
    for (const dev of context.devices) {
      if (!dev.control.commandAuthority || selection.shedSet.has(dev.id)) continue;
      selection.shedSet.add(dev.id);
      selection.shedReasons.set(dev.id, this.directiveReason());
    }
    if (selection.shedSet.size > 0) {
      this.state.sheddingActive = true;
      this.state.restoreBackoff.noteInstability(nowTs);
      this.state.overshoot.noteMitigation(nowTs);
    }
    return {
      ...selection,
      lastResortCutIds: new Set(context.devices.filter((device) => device.lastResort
        && device.control.commandAuthority && device.commandableNow).map(({ id }) => id)),
      sheddingActive: this.state.sheddingActive,
      guardInShortfall: false,
      outcome: NO_SHEDDING_OUTCOME,
      recoveredAtMs: null,
      unrelievedPhase: null,
      phaseExportExcessKw: 0,
      exportPhase: null,
    };
  }
}
