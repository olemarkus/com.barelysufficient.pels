import type { RestoreHeadroomAxes } from './restore/headroomLedger';
/**
 * Post-shedding materialization stages of the plan pipeline, sliced out of
 * `planBuilder.ts` to keep that entry point under the line budget (and under
 * the `import-x/max-dependencies` cap — this module absorbs the stage modules'
 * imports rather than adding one).
 *
 * `PlanMaterializationStages` runs the fixed sequence the builder documents:
 * initial device materialization → restore → shed-temperature hold → reason
 * normalization → finalization, plus the headroom-card sync and the diagnostics
 * observation. It holds the shared `PlanEngineState` and the builder's dep bag
 * as fields, so the state mutations stay on `this.state` exactly as they did
 * when these were `PlanBuilder` methods. Behaviour is byte-for-byte unchanged.
 *
 * Shed-selection invariant (`lib/plan/shedding/AGENTS.md`): none of these
 * stages may add a device to the shed set — they only copy `shedSet`
 * membership into per-device `plannedState`/shed actions, or decline to lift an
 * existing shed.
 */
import type { DevicePlanDevice, MeteredDevicePlanDevice } from './planTypes';
import { isMeteredPlanDevice } from './planMeteredDevice';
import type { TemperatureSetpointsByDevice } from '../../packages/planner-types/src/temperatureSetpoints';
import type { PlanEngineState, StorageLeverState } from './planState';
import type { MeasuredPower, PlanContext } from './planContext';
import type { SheddingPlan } from './shedding';
import type { PlanBuilderDeps } from './planBuilderDeps';
import { buildInitialPlanDevices } from './planDevices';
import type { ShortfallOffState } from './planOffStateReason';
import { applyRestorePlan, type RestorePlanResult } from './restore';
import {
  applyShedTemperatureHold,
  finalizePlanDevices,
  normalizeShedReasons,
  type ShedReasonHoldInputs,
} from './planReasons';
import { rankRestoreCooldownCohort } from './planRestoreCooldownCohort';
import { syncHeadroomCardState } from './planHeadroomDevice';
import { buildDeviceDiagnosticsObservations } from './planDiagnostics';
import { buildCeilingShortfallInputs } from './planReasonShortfall';
import { getOnDevices } from './restore/devices';
import { trackPlanStage } from './planStageTiming';

type HoldPlanResult = {
  planDevices: DevicePlanDevice[];
  availableHeadroom: number | null;
  restoredOneThisCycle: boolean;
  ledgerAxes: RestoreHeadroomAxes;
};

type FinalizedPlanResult = {
  planDevices: DevicePlanDevice[];
};

export class PlanMaterializationStages {
  /** The builder's own deps, read live every cycle, never snapshotted. */
  constructor(
    private readonly deps: PlanBuilderDeps,
    private readonly state: PlanEngineState,
  ) { }

  buildPlanDevices(
    context: PlanContext,
    sheddingPlan: SheddingPlan,
    shortfall: ShortfallOffState,
  ): DevicePlanDevice[] {
    return trackPlanStage('plan_devices_ms', () => buildInitialPlanDevices({
      context,
      state: this.state,
      sheddingPlan,
      shortfall,
      deps: this.deps,
    }));
  }

  applyRestorePlan(
    planDevices: DevicePlanDevice[],
    context: PlanContext,
    power: MeasuredPower,
    sheddingPlan: SheddingPlan,
    /** The holds PELS keeps on home batteries after this build's limit step (`StorageRelief.levers`). */
    storageLevers: Readonly<Record<string, StorageLeverState>>,
  ): RestorePlanResult {
    return trackPlanStage('plan_restore_ms', () => {
      const restoreResult = applyRestorePlan({
        planDevices,
        context,
        power,
        state: this.state,
        storageLevers,
        sheddingActive: sheddingPlan.sheddingActive,
        guardInShortfall: sheddingPlan.guardInShortfall,
        deps: {
          powerTracker: this.deps.getPowerTracker(),
          getShedBehavior: (deviceId) => this.deps.getShedBehavior(deviceId),
          temperatureSetpoints: context.temperatureSetpoints,
          deviceDiagnostics: this.deps.deviceDiagnostics,
          structuredLog: this.deps.structuredLog,
        },
      });
      this.state.restoreBackoff.commitCooldown(restoreResult.timing);
      return restoreResult;
    });
  }

  applyHoldPlan(
    // The restore pass's result carries the devices it decided and this
    // cycle's effective timing — the same object the binary stay-off lane was
    // fed (startup fields zeroed unless capacity is the binding source) — so
    // both lanes name the same cause for the same cycle.
    restoreResult: RestorePlanResult,
    sheddingPlan: SheddingPlan,
    // Resolved ONCE per build before the planner and shared with restore
    // classification, so no stage can disagree about this build's limit.
    // Semantics on `applyShedTemperatureHold`'s `temperatureSetpoints`.
    temperatureSetpoints: TemperatureSetpointsByDevice,
  ): HoldPlanResult {
    return trackPlanStage('plan_hold_ms', () => applyShedTemperatureHold(
      this.state, restoreResult, sheddingPlan, temperatureSetpoints,
    ));
  }

  normalizeReasons(
    context: PlanContext,
    power: MeasuredPower,
    restoreResult: RestorePlanResult,
    sheddingPlan: SheddingPlan,
    holds: ShedReasonHoldInputs,
    /** The hold lane's result: the devices it settled and the availability it left. */
    holdResult: HoldPlanResult,
  ): DevicePlanDevice[] {
    const { planDevices } = holdResult;
    // The cohort rank runs on the FULL list — every lane has written its
    // countdown by now — and before any carrier reads the plan. Only while a
    // restore cooldown is actually running: the countdown code has other
    // producers (the one-restore-per-cycle gate, the shedding latch's stay-off
    // ladder) whose cohort is not queued behind a timer.
    const rank = restoreResult.timing.inRestoreCooldown
      ? rankRestoreCooldownCohort
      : (devices: DevicePlanDevice[]): DevicePlanDevice[] => devices;
    return trackPlanStage('plan_reasons_ms', () => rank(normalizeShedReasons(planDevices, {
      shedReasons: sheddingPlan.shedReasons,
      guardInShortfall: sheddingPlan.guardInShortfall,
      headroomRaw: power.headroomKw,
      timing: restoreResult.timing,
      ...holds,
      softLimitSource: context.softLimitSource,
      // The one resolved breach answer: this used to read the RAW total, which
      // survives a meter dropout, so a stale cached figure could claim a breach
      // PELS could not observe.
      physicalLimitBreached: power.physicalLimitBreached,
      budgetReleasableHeadroomHold: power.budgetReleasableHeadroomHold,
      // Use the availability left after temperature restores in this cycle.
      admissionInputs: buildCeilingShortfallInputs({
        ledgerAxes: holdResult.ledgerAxes,
        headroomReserves: restoreResult.headroomReserves,
        // The SAME victim filter the swap lane uses (`getOnDevices`), not
        // raw plan devices — the raw list would fold "relief" from devices
        // a swap can never actually shed (stepped `set_step` behavior,
        // thermostats already at their shed floor, uncommandable devices),
        // understating the displayed gap.
        onDevices: getOnDevices(
          planDevices,
          (deviceId) => this.deps.getShedBehavior(deviceId),
          context.temperatureSetpoints,
        ),
        // The same ledger instance the restore pass just reconciled — the
        // swap surface the shortfall folds in is the one the next swap
        // decision reads, now by identity rather than by a refresh step.
        swapLedger: this.state.swapLedger,
        restoredThisCycle: restoreResult.restoredThisCycle,
        // Same need the restore gate rejects on: it inflates a recently shed
        // device's requirement, and a card computed against the deflated
        // figure would claim the device is admissible on the very cycle the
        // gate turned it down. Same `timing.nowTs` the restore gate rejected
        // on, so card and gate agree by construction.
        lastDeviceShedMsById: this.state.actuation.lastDeviceShedMs,
        nowMs: restoreResult.timing.nowTs,
      }),
      hourlyBudgetExhausted: this.state.capacityPeriodSpentFor(context),
    })));
  }

  finalizePlan(
    planDevices: DevicePlanDevice[],
    temperatureSetpoints: TemperatureSetpointsByDevice,
    nowTs: number,
  ): FinalizedPlanResult {
    this.syncHeadroomCardState(planDevices, nowTs);
    return trackPlanStage('plan_finalize_ms', () => finalizePlanDevices(
      planDevices, temperatureSetpoints, this.state.shedDecisions.lastPlannedShedIds, {
      onInvalidReasonPair: (issue) => {
        this.deps.structuredLog?.warn({
          event: 'plan_reason_pair_invalid',
          deviceId: issue.deviceId,
          deviceName: issue.deviceName,
          plannedState: issue.plannedState,
          reasonCode: issue.reasonCode,
          allowedReasonCodes: issue.allowedReasonCodes,
          ...(issue.requiredFlags ? { requiredFlags: issue.requiredFlags } : {}),
        });
      },
    }));
  }

  private syncHeadroomCardState(planDevices: DevicePlanDevice[], nowTs: number): void {
    return trackPlanStage('plan_headroom_cooldown_ms', () => {
      // The card tracks drops in measured usage, which only a device with a power
      // reading has.
      syncHeadroomCardState(
        this.state,
        planDevices.filter((device): device is MeteredDevicePlanDevice => isMeteredPlanDevice(device)),
        nowTs,
        this.deps.deviceDiagnostics,
      );
    });
  }

  /**
   * Diagnostics observation runs synchronously on the plan-build path so the
   * immediately-following `plan_updated` emit reads fresh starvation state
   * from `DeviceDiagnosticsService.getOverviewStarvation`. Earlier attempts to
   * defer this via `setImmediate` caused the UI snapshot to serialize the
   * previous batch's starvation, since the deferred callback hadn't run yet
   * when `serializePlanForUi` queried `live.starvation`.
   */
  observeDiagnostics(
    context: PlanContext,
    power: MeasuredPower,
    planDevices: DevicePlanDevice[],
    restoreResult: RestorePlanResult,
    budgetPressureEligible: boolean,
    smartTaskDrivingDeviceIds: ReadonlySet<string>,
    nowTs: number,
  ): void {
    trackPlanStage('plan_observe_diag_ms', () => {
      if (!this.deps.deviceDiagnostics) return;
      const observations = buildDeviceDiagnosticsObservations(
        context, power, planDevices, restoreResult, budgetPressureEligible, smartTaskDrivingDeviceIds,
      );
      this.deps.deviceDiagnostics.observePlanSample({ observations, nowTs });
    });
  }
}
