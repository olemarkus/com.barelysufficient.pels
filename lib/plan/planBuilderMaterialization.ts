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
import type { DevicePlanDevice, ShedBehavior } from './planTypes';
import type { PlanEngineState } from './planState';
import type { PlanContext } from './planContext';
import type { SheddingPlan } from './shedding';
import type { PriceOptDeviceConfig } from './planBuilderSurplus';
import type { PowerTrackerState } from '../power/tracker';
import type { PendingBinaryCommandStore } from '../observer/pendingBinaryCommands';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import { buildInitialPlanDevices } from './planDevices';
import { applyRestorePlan, type RestorePlanResult } from './restore';
import {
  applyShedTemperatureHold,
  finalizePlanDevices,
  normalizeShedReasons,
  type ShedReasonHoldInputs,
} from './planReasons';
import { syncHeadroomCardState } from './planHeadroomDevice';
import { buildDeviceDiagnosticsObservations } from './planDiagnostics';
import { buildRestoreHeadroomLedger } from './restore/headroomLedger';
import { buildCeilingShortfallInputs } from './planReasonShortfall';
import { buildSwapState } from './swap/state';
import { getOnDevices } from './restore/devices';
import { trackPlanStage } from './planStageTiming';

/**
 * The slice of `PlanBuilderDeps` the materialization stages read. Declared
 * structurally (like `OvershootTrackerDeps`) so this module never imports
 * `planBuilder.ts` back — the builder passes its own `deps` object through.
 * Read live off that shared object every cycle, never snapshotted.
 */
export type PlanMaterializationDeps = {
  getShedBehavior: (deviceId: string) => ShedBehavior;
  getPriceOptimizationEnabled: () => boolean;
  getPriceOptimizationSettings: () => Record<string, PriceOptDeviceConfig>;
  getInferredSurplusKw: () => number;
  // Per-home mode-target raise hold while power is unknown; absent = no hold.
  holdsModeTargetRaisesWhilePowerUnknown?: () => boolean;
  getOperatingMode: () => string;
  getPowerTracker: () => PowerTrackerState;
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
  logDebug: (...args: unknown[]) => void;
};

type HoldPlanResult = {
  planDevices: DevicePlanDevice[];
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
  ledgerAxes: { capacityAvailableKw: number; budgetAvailableKw: number | null } | null;
};

type FinalizedPlanResult = {
  planDevices: DevicePlanDevice[];
  lastPlannedShedIds: Set<string>;
};

export class PlanMaterializationStages {
  constructor(
    private readonly deps: PlanMaterializationDeps,
    private readonly state: PlanEngineState,
  ) { }

  private get priceOptimizationSettings(): Record<string, PriceOptDeviceConfig> {
    return this.deps.getPriceOptimizationSettings();
  }

  buildPlanDevices(
    context: PlanContext,
    sheddingPlan: SheddingPlan,
  ): DevicePlanDevice[] {
    return trackPlanStage('plan_devices_ms', () => buildInitialPlanDevices({
      context,
      state: this.state,
      shedSet: sheddingPlan.shedSet,
      shedReasons: sheddingPlan.shedReasons,
      shedStepTargets: sheddingPlan.shedStepTargets,
      guardInShortfall: sheddingPlan.guardInShortfall,
      deps: {
        getShedBehavior: (deviceId) => this.deps.getShedBehavior(deviceId),
        getPriceOptimizationEnabled: () => this.deps.getPriceOptimizationEnabled(),
        getPriceOptimizationSettings: () => this.priceOptimizationSettings,
        getInferredSurplusKw: this.deps.getInferredSurplusKw,
        getOperatingMode: () => this.deps.getOperatingMode(),
        holdsModeTargetRaisesWhilePowerUnknown: this.deps.holdsModeTargetRaisesWhilePowerUnknown,
        pendingBinaryCommandStore: this.deps.pendingBinaryCommandStore,
        debugStructured: this.deps.debugStructured,
      },
    }));
  }

  applyRestorePlan(
    planDevices: DevicePlanDevice[],
    context: PlanContext,
    sheddingPlan: SheddingPlan,
    deviceNameById: ReadonlyMap<string, string>,
    normalizedShedFloorCByDevice: ReadonlyMap<string, number>,
  ): RestorePlanResult {
    return trackPlanStage('plan_restore_ms', () => this.applyRestorePlanAndUpdateState({
      planDevices,
      context,
      sheddingActive: sheddingPlan.sheddingActive,
      guardInShortfall: sheddingPlan.guardInShortfall,
      deviceNameById,
      normalizedShedFloorCByDevice,
    }));
  }

  applyHoldPlan(
    planDevices: DevicePlanDevice[],
    restoreResult: RestorePlanResult,
    sheddingPlan: SheddingPlan,
    // Resolved ONCE per build by the builder and shared with restore
    // classification, so no stage can disagree about this build's floor.
    // Semantics on `ShedHoldParams.normalizedShedFloorCByDevice`.
    normalizedShedFloorCByDevice: ReadonlyMap<string, number>,
  ): HoldPlanResult {
    return trackPlanStage('plan_hold_ms', () => applyShedTemperatureHold({
      normalizedShedFloorCByDevice,
      ledger: buildRestoreHeadroomLedger({
        capacityAvailableKw: restoreResult.capacityAvailableKw,
        budgetAvailableKw: restoreResult.budgetAvailableKw,
      }),
      headroomReserves: restoreResult.headroomReserves,
      restoreCooldownPreview: restoreResult.restoreCooldownPreview,
      planDevices,
      state: this.state,
      shedReasons: sheddingPlan.shedReasons,
      inShedWindow: restoreResult.inShedWindow,
      inCooldown: restoreResult.inCooldown,
      activeOvershoot: restoreResult.activeOvershoot,
      availableHeadroom: restoreResult.availableHeadroom,
      restoredOneThisCycle: restoreResult.restoredOneThisCycle,
      restoredThisCycle: restoreResult.restoredThisCycle,
      shedCooldownRemainingSec: restoreResult.shedCooldownRemainingSec,
      shedCooldownStartedAtMs: restoreResult.shedCooldownStartedAtMs,
      shedCooldownTotalSec: restoreResult.shedCooldownTotalSec,
      holdDuringRestoreCooldown: restoreResult.inRestoreCooldown,
      restoreCooldownSeconds: restoreResult.restoreCooldownSeconds,
      restoreCooldownRemainingSec: restoreResult.restoreCooldownRemainingSec,
      // From `effectiveTiming`, the same object the binary stay-off lane is fed
      // (`restore/index.ts` zeroes the startup fields unless capacity is the
      // binding source) — so both lanes name the same cause for the same cycle.
      inStartupStabilization: restoreResult.inStartupStabilization,
      restoreCooldownStartedAtMs: restoreResult.restoreCooldownStartedAtMs,
      restoreCooldownTotalSec: restoreResult.restoreCooldownTotalSec,
      guardInShortfall: sheddingPlan.guardInShortfall,
      debugStructured: this.deps.debugStructured,
      getShedBehavior: (deviceId) => this.deps.getShedBehavior(deviceId),
    }));
  }

  normalizeReasons(params: {
    planDevices: DevicePlanDevice[];
    context: PlanContext;
    restoreResult: RestorePlanResult;
    sheddingPlan: SheddingPlan;
    holds: ShedReasonHoldInputs;
    holdResult: HoldPlanResult;
    normalizedShedFloorCByDevice: ReadonlyMap<string, number>;
  }): DevicePlanDevice[] {
    const {
      planDevices, context, restoreResult, sheddingPlan, holds, holdResult, normalizedShedFloorCByDevice,
    } = params;
    return trackPlanStage('plan_reasons_ms', () => normalizeShedReasons({
      planDevices,
      shedReasons: sheddingPlan.shedReasons,
      guardInShortfall: sheddingPlan.guardInShortfall,
      headroomRaw: context.headroomRaw,
      inCooldown: restoreResult.inCooldown,
      activeOvershoot: restoreResult.activeOvershoot,
      shedCooldownRemainingSec: restoreResult.shedCooldownRemainingSec,
      shedCooldownStartedAtMs: restoreResult.shedCooldownStartedAtMs,
      shedCooldownTotalSec: restoreResult.shedCooldownTotalSec,
      ...holds,
      softLimitSource: context.softLimitSource,
      // Measured-only: a synthesized headroom must not produce a user-visible
      // breach reason. This used to read the RAW total, which survives a meter
      // dropout, so a stale cached figure could claim a breach PELS could not
      // observe. Shedding is unaffected — a fail-closed meter still forces -1.
      capacityBreached: context.powerMeasuredAboveKw(context.capacitySoftLimit),
      budgetReleasableHeadroomHold: context.budgetReleasableHeadroomHold,
      // The hold lane's post-pass axes — `applyHoldPlan` always supplies a
      // ledger on this path, so `ledgerAxes` is only null for scalar-only
      // direct callers (tests), which simply get no per-cycle shortfall rather
      // than a silently different availability basis.
      //
      // Gated on a measurement (`powerIsMeasured`, resolved once by the
      // producer): whenever there is none the context synthesizes the headroom
      // (stale_hold → 0, stale_fail_closed → −1, and a fresh tracker with a null
      // total — e.g. right after an in-place meter swap — also synthesizes 0),
      // so a gap computed from those axes would be fabricated —
      // the real recourse is a fresh meter reading, not freed power. No new
      // numbers while unknown; holds keep whatever the last known cycle
      // attached.
      admissionInputs: holdResult.ledgerAxes && context.powerIsMeasured
        ? buildCeilingShortfallInputs({
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
            normalizedShedFloorCByDevice,
          ),
          // `state.swapByDevice` was refreshed from this cycle's restore pass
          // in `applyRestorePlanAndUpdateState`, so the swap surface the
          // shortfall folds in is the same one the next swap decision reads.
          swappedOutFor: buildSwapState(this.state).swappedOutFor,
          restoredThisCycle: restoreResult.restoredThisCycle,
          // Same need the restore gate rejects on: it inflates a recently shed
          // device's requirement, and a card computed against the deflated
          // figure would claim the device is admissible on the very cycle the
          // gate turned it down. `getRestoreNeed` reads its own `Date.now()`, so
          // the two dates differ by the width of one plan cycle against a
          // five-minute window — same answer, no shared clock needed.
          lastDeviceShedMsById: this.state.lastDeviceShedMs,
          nowMs: restoreResult.nowTs,
        })
        : undefined,
      hourlyBudgetExhausted: this.state.hourlyBudgetExhausted,
    }));
  }

  finalizePlan(
    planDevices: DevicePlanDevice[],
    normalizedShedFloorCByDevice: ReadonlyMap<string, number>,
  ): FinalizedPlanResult {
    return trackPlanStage('plan_finalize_ms', () => finalizePlanDevices(
      planDevices, normalizedShedFloorCByDevice, this.state.lastPlannedShedIds, {
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

  syncHeadroomCardState(planDevices: DevicePlanDevice[]): void {
    return trackPlanStage('plan_headroom_cooldown_ms', () => {
      syncHeadroomCardState({
        state: this.state,
        devices: planDevices,
        nowTs: Date.now(),
        cleanupMissingDevices: false,
        diagnostics: this.deps.deviceDiagnostics,
      });
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
  observeDiagnostics(params: {
    context: PlanContext;
    planDevices: DevicePlanDevice[];
    restoreResult: RestorePlanResult;
    nowTs: number;
  }): void {
    trackPlanStage('plan_observe_diag_ms', () => {
      if (!this.deps.deviceDiagnostics) return;
      const { nowTs } = params;
      const observations = buildDeviceDiagnosticsObservations({
        context: params.context,
        planDevices: params.planDevices,
        restoreResult: params.restoreResult,
        priceOptimizationEnabled: this.deps.getPriceOptimizationEnabled(),
        priceOptimizationSettings: this.priceOptimizationSettings,
        // No staleness dep wired (e.g. tests) ⇒ treat every device as fresh, so the
        // freshness gate is a no-op and starvation counts as before.
      });
      this.deps.deviceDiagnostics.observePlanSample({ observations, nowTs });
    });
  }

  private applyRestorePlanAndUpdateState(params: {
    planDevices: DevicePlanDevice[];
    context: PlanContext;
    sheddingActive: boolean;
    guardInShortfall: boolean;
    deviceNameById: ReadonlyMap<string, string>;
    normalizedShedFloorCByDevice: ReadonlyMap<string, number>;
  }): RestorePlanResult {
    const {
      planDevices, context, sheddingActive, guardInShortfall, deviceNameById, normalizedShedFloorCByDevice,
    } = params;
    const restoreResult = applyRestorePlan({
      planDevices,
      context,
      state: this.state,
      sheddingActive,
      guardInShortfall,
      deps: {
        powerTracker: this.deps.getPowerTracker(),
        getShedBehavior: (deviceId) => this.deps.getShedBehavior(deviceId),
        normalizedShedFloorCByDevice,
        deviceDiagnostics: this.deps.deviceDiagnostics,
        structuredLog: this.deps.structuredLog,
        debugStructured: this.deps.debugStructured,
        deviceNameById,
        logDebug: (...args: unknown[]) => this.deps.logDebug(...args),
      },
    });
    this.state.swapByDevice = restoreResult.stateUpdates.swapByDevice;
    this.state.restoreCooldownMs = restoreResult.restoreCooldownMs;
    this.state.lastRestoreCooldownBumpMs = restoreResult.lastRestoreCooldownBumpMs;
    return restoreResult;
  }
}
