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
import type { DevicePlanDevice, ShedAction } from './planTypes';
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
import { isCapacityBreached } from './planRemainingSheddableLoad';
import { buildRestoreHeadroomLedger } from './restore/headroomLedger';
import { trackPlanStage } from './planStageTiming';

/**
 * The slice of `PlanBuilderDeps` the materialization stages read. Declared
 * structurally (like `OvershootTrackerDeps`) so this module never imports
 * `planBuilder.ts` back — the builder passes its own `deps` object through.
 * Read live off that shared object every cycle, never snapshotted.
 */
export type PlanMaterializationDeps = {
  getPriorityForDevice: (deviceId: string) => number;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
  isCurrentHourCheap: () => boolean;
  isCurrentHourExpensive: () => boolean;
  getPriceOptimizationEnabled: () => boolean;
  getPriceOptimizationSettings: () => Record<string, PriceOptDeviceConfig>;
  getInferredSurplusKw?: () => number | null;
  // Per-home mode-target raise hold while power is unknown; absent = no hold.
  holdsModeTargetRaisesWhilePowerUnknown?: () => boolean;
  getOperatingMode: () => string;
  getPowerTracker: () => PowerTrackerState;
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
  getObservationStale?: (deviceId: string) => boolean;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
  logDebug: (...args: unknown[]) => void;
};

type HoldPlanResult = {
  planDevices: DevicePlanDevice[];
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
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

  buildPlanDevices(context: PlanContext, sheddingPlan: SheddingPlan): DevicePlanDevice[] {
    return trackPlanStage('plan_devices_ms', () => buildInitialPlanDevices({
      context,
      state: this.state,
      shedSet: sheddingPlan.shedSet,
      shedReasons: sheddingPlan.shedReasons,
      guardInShortfall: sheddingPlan.guardInShortfall,
      deps: {
        getPriorityForDevice: (deviceId) => this.deps.getPriorityForDevice(deviceId),
        getShedBehavior: (deviceId) => this.deps.getShedBehavior(deviceId),
        isCurrentHourCheap: () => this.deps.isCurrentHourCheap(),
        isCurrentHourExpensive: () => this.deps.isCurrentHourExpensive(),
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
  ): RestorePlanResult {
    return trackPlanStage('plan_restore_ms', () => this.applyRestorePlanAndUpdateState({
      planDevices,
      context,
      sheddingActive: sheddingPlan.sheddingActive,
      guardInShortfall: sheddingPlan.guardInShortfall,
      deviceNameById,
    }));
  }

  applyHoldPlan(
    planDevices: DevicePlanDevice[],
    restoreResult: RestorePlanResult,
    sheddingPlan: SheddingPlan,
  ): HoldPlanResult {
    return trackPlanStage('plan_hold_ms', () => applyShedTemperatureHold({
      ledger: buildRestoreHeadroomLedger({
        capacityAvailableKw: restoreResult.capacityAvailableKw,
        budgetAvailableKw: restoreResult.budgetAvailableKw,
      }),
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
      guardInShortfall: sheddingPlan.guardInShortfall,
      debugStructured: this.deps.debugStructured,
      getShedBehavior: (deviceId) => this.deps.getShedBehavior(deviceId),
    }));
  }

  normalizeReasons(
    planDevices: DevicePlanDevice[],
    context: PlanContext,
    restoreResult: RestorePlanResult,
    sheddingPlan: SheddingPlan,
    holds: ShedReasonHoldInputs,
  ): DevicePlanDevice[] {
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
      capacityBreached: isCapacityBreached(context.total, context.capacitySoftLimit),
      budgetReleasableHeadroomHold: context.budgetReleasableHeadroomHold,
    }));
  }

  finalizePlan(planDevices: DevicePlanDevice[]): FinalizedPlanResult {
    return trackPlanStage('plan_finalize_ms', () => finalizePlanDevices(planDevices, {
      onInvalidReasonPair: (issue) => {
        this.deps.structuredLog?.warn({
          event: 'plan_reason_pair_invalid',
          deviceId: issue.deviceId,
          deviceName: issue.deviceName,
          plannedState: issue.plannedState,
          reason: issue.reason,
          allowedReasonKinds: issue.allowedReasonKinds,
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
        isCurrentHourCheap: () => this.deps.isCurrentHourCheap(),
        isCurrentHourExpensive: () => this.deps.isCurrentHourExpensive(),
        // No staleness dep wired (e.g. tests) ⇒ treat every device as fresh, so the
        // freshness gate is a no-op and starvation counts as before.
        getObservationStale: this.deps.getObservationStale ?? (() => false),
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
  }): RestorePlanResult {
    const { planDevices, context, sheddingActive, guardInShortfall, deviceNameById } = params;
    const restoreResult = applyRestorePlan({
      planDevices,
      context,
      state: this.state,
      sheddingActive,
      guardInShortfall,
      deps: {
        powerTracker: this.deps.getPowerTracker(),
        getShedBehavior: (deviceId) => this.deps.getShedBehavior(deviceId),
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
