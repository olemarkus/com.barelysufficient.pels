import type { HomeyRuntime } from '../ports/homeyRuntime';
import CapacityGuard from '../power/capacityGuard';
import type { PowerTrackerState } from '../power/tracker';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { isCooldownBlockedReason } from '../planContract/planDecisionSemantics';
import type { DevicePlan, DevicePlanDevice, PlanInputDevice, ShedAction } from './planTypes';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import type { OvershootTrackedPlanDevice, PlanEngineState } from './planState';
import { computeDailyUsageSoftLimit, computeDynamicSoftLimit, computeShortfallThreshold } from './planBudget';
import { buildPlanContext, type PlanContext, type SoftLimitSource } from './planContext';
import { buildSheddingPlan, type SheddingPlan } from './shedding';
import { buildPlanCapacityStateSummary } from './planLogging';
import { buildInitialPlanDevices } from './planDevices';
import { applyRestorePlan, type RestorePlanResult } from './restore';
import { splitControlledUsageKw, sumBudgetExemptLiveUsageKw } from './planUsage';
import { syncHeadroomCardState } from './planHeadroomDevice';
import {
  applyShedTemperatureHold,
  finalizePlanDevices,
  normalizeShedReasons,
} from './planReasons';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import { recordOpRssDelta, safeRss } from '../utils/opRssTracker';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import { buildDeviceDiagnosticsObservations } from './planDiagnostics';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import {
  buildDailyBudgetContext as buildPlanDailyBudgetContext,
  extractDailyBudgetHourKWh as extractPlanDailyBudgetHourKWh,
  getHourUsageSplit,
  resolveDailySoftLimitBucket,
} from './planDailyBudgetWindow';
import {
  recordActivationSetback,
  syncConfirmedRestoreAttributionState as syncConfirmedRestoreAttributionAttempt,
} from './admission';
import {
  OVERSHOOT_RESTORE_ATTRIBUTION_WINDOW_MS,
  SOFT_OVERSHOOT_DEADBAND_KW,
} from './planConstants';
import { isObservedOff } from '../observer/observedState';
import type { PendingBinaryCommandStore } from '../observer/pendingBinaryCommands';
import { isPendingBinaryCommandActive } from './planObservationPolicy';
import { resolveSoftOvershootDecision, type SoftOvershootDecision } from './planOvershoot';
import type {
  DeferredDecorationBundle,
  DeferredDecorationInput,
  DeferredReleaseIntent,
} from '../../packages/planner-types/src/deferredDecoration';

type ShortfallMeta = Pick<
  DevicePlan['meta'],
  | 'capacityShortfall'
  | 'shortfallBudgetThresholdKw'
  | 'shortfallBudgetHeadroomKw'
  | 'hardCapLimitKw'
  | 'hardCapHeadroomKw'
>;

export type PlanBuilderDeps = {
  homey: HomeyRuntime;
  getCapacityGuard: () => CapacityGuard | undefined;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getOperatingMode: () => string;
  getModeDeviceTargets: () => Record<string, Record<string, number>>;
  getPriceOptimizationEnabled: () => boolean;
  getPriceOptimizationSettings: () => Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;
  isCurrentHourCheap: () => boolean;
  isCurrentHourExpensive: () => boolean;
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
const OVERSHOOT_DELTA_EPSILON_KW = 0.05;
const OVERSHOOT_TOP_CONTRIBUTOR_LIMIT = 3;

export class PlanBuilder {
  constructor(private deps: PlanBuilderDeps, private state: PlanEngineState) { }
  private get capacityGuard(): CapacityGuard | undefined { return this.deps.getCapacityGuard(); }
  private get capacitySettings(): { limitKw: number; marginKw: number } { return this.deps.getCapacitySettings(); }
  private get operatingMode(): string { return this.deps.getOperatingMode(); }
  private get modeDeviceTargets(): Record<string, Record<string, number>> { return this.deps.getModeDeviceTargets(); }
  private get priceOptimizationEnabled(): boolean { return this.deps.getPriceOptimizationEnabled(); }

  private get priceOptimizationSettings(): Record<
    string,
    { enabled: boolean; cheapDelta: number; expensiveDelta: number }
  > {
    return this.deps.getPriceOptimizationSettings();
  }

  private get powerTracker(): PowerTrackerState {
    return this.deps.getPowerTracker();
  }

  private get dailyBudgetSnapshot(): DailyBudgetUiPayload | null {
    return this.deps.getDailyBudgetSnapshot?.() ?? null;
  }

  private trackDuration<T>(key: string, fn: () => T): T {
    const start = Date.now();
    const rssBefore = safeRss();
    try {
      return fn();
    } finally {
      addPerfDuration(key, Date.now() - start);
      recordOpRssDelta(key, rssBefore, safeRss());
    }
  }

  private async trackDurationAsync<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    const rssBefore = safeRss();
    try {
      return await fn();
    } finally {
      addPerfDuration(key, Date.now() - start);
      recordOpRssDelta(key, rssBefore, safeRss());
    }
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
    const planStart = Date.now();
    const rssBefore = safeRss();
    try {
      return await this.buildPlanSnapshotWithTimings(devices);
    } finally {
      addPerfDuration('plan_build_ms', Date.now() - planStart);
      recordOpRssDelta('plan_build_ms', rssBefore, safeRss());
    }
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
    } = this.trackDuration('plan_deferred_objective_observe_ms', () => (
      this.deps.decorateDeferredObjectives?.({ devices, dailyBudgetSnapshot, nowTs })
      ?? buildIdentityDecorationBundle(devices)
    ));

    const {
      context,
      sheddingPlan,
      overshootDecision,
    } = await this.buildContextAndShedding(admittedDevices, nowTs, dailyBudgetSnapshot);
    const deviceNameById = new Map(admittedDevices.map((d) => [d.id, d.name]));
    for (const id of forceShedSet) sheddingPlan.shedSet.add(id);

    let planDevices = this.buildPlanDevices(context, sheddingPlan);
    const restoreResult = this.applyRestorePlanWithTiming(planDevices, context, sheddingPlan, deviceNameById);
    planDevices = restoreResult.planDevices;

    const holdResult = this.applyHoldPlanWithTiming(planDevices, restoreResult, sheddingPlan);
    planDevices = holdResult.planDevices;

    planDevices = this.normalizeReasonsWithTiming(
      planDevices,
      context,
      restoreResult,
      sheddingPlan,
      deferredAvoidDeviceIds,
    );
    planDevices = attachDeferredReleaseIntents(planDevices, deferredReleaseIntentByDeviceId, context);
    this.syncHeadroomCardStateWithTiming(planDevices);
    const finalized = this.finalizePlanWithTiming(planDevices);
    // Decision-time shed clock: stamp the moment the planner decides a device
    // enters capacity-shed posture (edge-set on the transition into the shed
    // set), independent of whether the executor actually issues a write this
    // cycle. A device that is already off still gets stamped here, so the
    // restore-eligibility readers no longer under-stamp it. Cleared on restore
    // alongside `lastDeviceShedMs`. Edge-set (not refreshed while held) so a
    // re-shed after a restore re-stamps a fresh decision time.
    for (const id of finalized.lastPlannedShedIds) {
      if (!this.state.lastPlannedShedIds.has(id)) {
        this.state.shedDecidedMs[id] = nowTs;
      }
    }
    this.state.lastPlannedShedIds = finalized.lastPlannedShedIds;
    this.trackDuration('plan_overshoot_ms', () => this.updateOvershootState({
      context,
      deviceNameById,
      planDevices: finalized.planDevices,
      overshootDecision,
      nowTs,
    }));

    const meta = this.trackDuration('plan_meta_ms', () => (
      this.buildPlanMeta(context, finalized.planDevices, dailyBudgetSnapshot)
    ));
    this.trackDuration('plan_observe_diag_ms', () => {
      this.observeDiagnostics({
        context,
        planDevices: finalized.planDevices,
        restoreResult,
        nowTs,
      });
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
    const dailySoftLimit = this.computeDailySoftLimit(dailyBudgetSnapshot, devices);
    const softLimit = dailySoftLimit !== null ? Math.min(capacitySoftLimit, dailySoftLimit) : capacitySoftLimit;
    const softLimitSource = this.resolveSoftLimitSource(capacitySoftLimit, dailySoftLimit);

    const context = this.trackDuration('plan_context_ms', () => buildPlanContext({
      devices,
      capacityGuard: this.capacityGuard,
      capacitySettings: this.capacitySettings,
      powerTracker: this.powerTracker,
      softLimit,
      capacitySoftLimit,
      dailySoftLimit,
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

    const sheddingPlan = await this.trackDurationAsync(
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

  private updateOvershootState(params: {
    context: PlanContext;
    deviceNameById: ReadonlyMap<string, string>;
    planDevices: DevicePlanDevice[];
    overshootDecision: SoftOvershootDecision;
    nowTs: number;
  }): void {
    const {
      context,
      deviceNameById,
      planDevices,
      overshootDecision,
      nowTs,
    } = params;
    const overshootActive = overshootDecision.actionable;
    const prevOvershoot = this.state.wasOvershoot;
    const trackedPlanDevicesById = trackPlanDevicesForOvershoot(
      planDevices,
      this.state,
      this.deps.pendingBinaryCommandStore,
    );
    const lastPowerUpdateMs = this.powerTracker.lastTimestamp ?? null;
    const overshootTimingFields = this.buildOvershootTimingFields(nowTs, lastPowerUpdateMs);
    if (overshootActive && !prevOvershoot) {
      this.state.overshootLogged = true;
      this.state.overshootStartedMs = nowTs;
      this.state.lastOvershootEscalationMs = null;
      this.state.lastOvershootMitigationMs = null;
      const overshootDiagnostics = buildOvershootEntryDiagnostics({
        context,
        nowTs,
        lastPowerUpdateMs,
        previousTotalKw: this.state.lastPlanTotalKw,
        previousBuiltAtMs: this.state.lastPlanBuiltAtMs,
        previousDevicesById: this.state.lastPlanDevicesById,
        currentDevicesById: trackedPlanDevicesById,
      });
      this.deps.structuredLog?.info({
        event: 'overshoot_entered',
        reasonCode: 'active_overshoot',
        headroomKw: context.headroom,
        ...overshootTimingFields,
        ...buildPlanContextHeadroomLogFields(context, this.capacityGuard, this.capacitySettings.limitKw),
        ...buildPlanCapacityStateSummary({
          meta: {
            totalKw: context.total,
            softLimitKw: context.softLimit,
            headroomKw: context.headroom,
          },
          devices: planDevices,
        }),
        ...overshootDiagnostics.logFields,
      });
      this.attributeOvershootToRecentRestores(deviceNameById, nowTs, overshootDiagnostics);
    } else if (!overshootActive && prevOvershoot && this.state.overshootLogged) {
      this.state.overshootLogged = false;
      const durationMs = this.state.overshootStartedMs !== null
        ? Math.max(0, nowTs - this.state.overshootStartedMs)
        : 0;
      this.state.overshootStartedMs = null;
      this.state.lastOvershootEscalationMs = null;
      this.state.lastOvershootMitigationMs = null;
      this.deps.structuredLog?.info({
        event: 'overshoot_cleared',
        reasonCode: 'overshoot_cleared',
        durationMs,
        ...overshootTimingFields,
        ...buildPlanContextHeadroomLogFields(context, this.capacityGuard, this.capacitySettings.limitKw),
      });
    } else if (overshootActive && this.state.overshootStartedMs === null) {
      this.state.overshootStartedMs = nowTs;
    }
    this.rememberPlanSnapshot(context, trackedPlanDevicesById, nowTs);
    this.state.wasOvershoot = overshootActive;
  }

  private rememberPlanSnapshot(
    context: PlanContext,
    trackedPlanDevicesById: Record<string, OvershootTrackedPlanDevice>,
    nowTs: number,
  ): void {
    this.state.lastPlanTotalKw = context.total;
    this.state.lastPlanBuiltAtMs = nowTs;
    this.state.lastPlanDevicesById = trackedPlanDevicesById;
  }

  private attributeOvershootToRecentRestores(
    deviceNameById: ReadonlyMap<string, string>,
    nowTs: number,
    overshootDiagnostics: OvershootEntryDiagnostics,
  ): void {
    // Only attribute to the single most recently restored device — it was the marginal addition
    // that tipped headroom negative. Devices restored earlier were already absorbed without
    // triggering overshoot, so penalizing them would be a false attribution.
    if (
      overshootDiagnostics.totalDeltaKw === null
      || overshootDiagnostics.totalDeltaKw <= SOFT_OVERSHOOT_DEADBAND_KW
    ) {
      return;
    }
    const recentRestores = Object.entries(this.state.lastDeviceRestoreMs)
      .filter(([, restoreMs]) => nowTs - restoreMs <= OVERSHOOT_RESTORE_ATTRIBUTION_WINDOW_MS)
      .sort((left, right) => right[1] - left[1]);
    for (const [deviceId, restoreMs] of recentRestores) {
      const contributingRestore = overshootDiagnostics.contributors.find((contributor) => (
        contributor.deviceId === deviceId
        && contributor.controllable
        && contributor.deltaKw > 0
      ));
      if (!contributingRestore) continue;
      const deviceName = deviceNameById.get(deviceId);
      const result = recordActivationSetback({ state: this.state, deviceId, nowTs });
      if (!result.transition) continue;

      const logEntry: {
        event: string;
        deviceId: string;
        deviceName?: string;
        restoreAgeMs: number;
        penaltyLevel: number;
      } = {
        event: 'overshoot_attributed',
        deviceId,
        restoreAgeMs: nowTs - restoreMs,
        penaltyLevel: result.penaltyLevel,
      };
      if (typeof deviceName === 'string' && deviceName.length > 0) {
        logEntry.deviceName = deviceName;
      }
      this.deps.structuredLog?.info(logEntry);
      if (this.deps.deviceDiagnostics) {
        this.deps.deviceDiagnostics.recordActivationTransition(result.transition, { name: deviceName });
      }
      return;
    }
  }
  private buildOvershootTimingFields(
    nowTs: number,
    lastPowerUpdateMs: number | null,
  ): {
    lastPlanBuildAgeMs: number | null;
    lastPowerUpdateAgeMs: number | null;
  } {
    return {
      lastPlanBuildAgeMs: typeof this.state.lastPlanBuiltAtMs === 'number'
        ? Math.max(0, nowTs - this.state.lastPlanBuiltAtMs)
        : null,
      lastPowerUpdateAgeMs: lastPowerUpdateMs !== null ? Math.max(0, nowTs - lastPowerUpdateMs) : null,
    };
  }

  private buildPlanDevices(
    context: PlanContext,
    sheddingPlan: SheddingPlan,
  ): DevicePlanDevice[] {
    return this.trackDuration('plan_devices_ms', () => buildInitialPlanDevices({
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
        getPriceOptimizationEnabled: () => this.priceOptimizationEnabled,
        getPriceOptimizationSettings: () => this.priceOptimizationSettings,
        getOperatingMode: () => this.operatingMode,
        pendingBinaryCommandStore: this.deps.pendingBinaryCommandStore,
        debugStructured: this.deps.debugStructured,
      },
    }));
  }

  private applyRestorePlanWithTiming(
    planDevices: DevicePlanDevice[],
    context: PlanContext,
    sheddingPlan: SheddingPlan,
    deviceNameById: ReadonlyMap<string, string>,
  ): RestorePlanResult {
    return this.trackDuration('plan_restore_ms', () => this.applyRestorePlanAndUpdateState({
      planDevices,
      context,
      sheddingActive: sheddingPlan.sheddingActive,
      guardInShortfall: sheddingPlan.guardInShortfall,
      deviceNameById,
    }));
  }

  private applyHoldPlanWithTiming(
    planDevices: DevicePlanDevice[],
    restoreResult: RestorePlanResult,
    sheddingPlan: SheddingPlan,
  ): { planDevices: DevicePlanDevice[]; availableHeadroom: number; restoredOneThisCycle: boolean } {
    return this.trackDuration('plan_hold_ms', () => applyShedTemperatureHold({
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

  private normalizeReasonsWithTiming(
    planDevices: DevicePlanDevice[],
    context: PlanContext,
    restoreResult: RestorePlanResult,
    sheddingPlan: SheddingPlan,
    deferredObjectiveAvoidDeviceIds: ReadonlySet<string>,
  ): DevicePlanDevice[] {
    return this.trackDuration('plan_reasons_ms', () => normalizeShedReasons({
      planDevices,
      shedReasons: sheddingPlan.shedReasons,
      guardInShortfall: sheddingPlan.guardInShortfall,
      headroomRaw: context.headroomRaw,
      inCooldown: restoreResult.inCooldown,
      activeOvershoot: restoreResult.activeOvershoot,
      shedCooldownRemainingSec: restoreResult.shedCooldownRemainingSec,
      shedCooldownStartedAtMs: restoreResult.shedCooldownStartedAtMs,
      shedCooldownTotalSec: restoreResult.shedCooldownTotalSec,
      deferredObjectiveAvoidDeviceIds,
      softLimitSource: context.softLimitSource,
    }));
  }

  private finalizePlanWithTiming(planDevices: DevicePlanDevice[]): {
    planDevices: DevicePlanDevice[];
    lastPlannedShedIds: Set<string>;
  } {
    return this.trackDuration('plan_finalize_ms', () => finalizePlanDevices(planDevices, {
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

  private syncHeadroomCardStateWithTiming(planDevices: DevicePlanDevice[]): void {
    return this.trackDuration('plan_headroom_cooldown_ms', () => {
      syncHeadroomCardState({
        state: this.state,
        devices: planDevices,
        nowTs: Date.now(),
        cleanupMissingDevices: false,
        diagnostics: this.deps.deviceDiagnostics,
      });
    });
  }

  // Diagnostics observation runs synchronously on the plan-build path so the
  // immediately-following `plan_updated` emit reads fresh starvation state
  // from `DeviceDiagnosticsService.getOverviewStarvation`. Earlier attempts to
  // defer this via `setImmediate` caused the UI snapshot to serialize the
  // previous batch's starvation, since the deferred callback hadn't run yet
  // when `serializePlanForUi` queried `live.starvation`.
  private observeDiagnostics(params: {
    context: PlanContext;
    planDevices: DevicePlanDevice[];
    restoreResult: RestorePlanResult;
    nowTs: number;
  }): void {
    if (!this.deps.deviceDiagnostics) return;
    const { nowTs } = params;
    const observations = buildDeviceDiagnosticsObservations({
      context: params.context,
      planDevices: params.planDevices,
      restoreResult: params.restoreResult,
      priceOptimizationEnabled: this.priceOptimizationEnabled,
      priceOptimizationSettings: this.priceOptimizationSettings,
      isCurrentHourCheap: () => this.deps.isCurrentHourCheap(),
      isCurrentHourExpensive: () => this.deps.isCurrentHourExpensive(),
    });
    this.deps.deviceDiagnostics.observePlanSample({ observations, nowTs });
  }

  private resolveSoftLimitSource(capacitySoftLimit: number, dailySoftLimit: number | null): SoftLimitSource {
    if (dailySoftLimit === null) return 'capacity';
    if (Math.abs(dailySoftLimit - capacitySoftLimit) <= SOFT_LIMIT_EPSILON) return 'capacity';
    return dailySoftLimit < capacitySoftLimit ? 'daily' : 'capacity';
  }

  private computeDailySoftLimit(
    snapshot: DailyBudgetUiPayload | null,
    devices: PlanInputDevice[],
  ): number | null {
    const bucket = resolveDailySoftLimitBucket(snapshot, this.powerTracker);
    if (!bucket) return null;
    const exemptKw = sumBudgetExemptLiveUsageKw(devices) ?? 0;
    // Budget-exempt load should not trigger daily-budget shedding of other devices.
    // Remove exempt energy already metered this hour, then add back the exempt live
    // run rate so the effective daily limit still allows that load to remain on.
    return computeDailyUsageSoftLimit({
      ...bucket,
    }) + Math.max(0, exemptKw);
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
    if (sheddingPlan.updates.lastOvershootEscalationMs !== undefined) {
      this.state.lastOvershootEscalationMs = sheddingPlan.updates.lastOvershootEscalationMs;
    }
    if (sheddingPlan.updates.lastOvershootMitigationMs !== undefined) {
      this.state.lastOvershootMitigationMs = sheddingPlan.updates.lastOvershootMitigationMs;
    }
    if (sheddingPlan.guardInShortfall !== this.state.inShortfall) {
      this.state.inShortfall = sheddingPlan.guardInShortfall;
      this.deps.homey.settings.set('capacity_in_shortfall', sheddingPlan.guardInShortfall);
      incPerfCounter('settings_set.capacity_in_shortfall');
    }
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
        powerTracker: this.powerTracker,
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

  private buildPlanMeta(
    context: PlanContext,
    planDevices: DevicePlanDevice[],
    dailyBudgetSnapshot: DailyBudgetUiPayload | null,
  ): DevicePlan['meta'] {
    const { controlledKw, uncontrolledKw } = splitControlledUsageKw({
      devices: planDevices,
      totalKw: context.total,
    });
    const currentHourUsageSplit = getHourUsageSplit(this.powerTracker, context.hourBucketKey);
    const today = dailyBudgetSnapshot?.days[dailyBudgetSnapshot.todayKey] ?? null;
    const shortfallMeta = buildShortfallMeta(this.capacityGuard, context.total, this.capacitySettings.limitKw);
    return {
      totalKw: context.total,
      softLimitKw: context.softLimit,
      capacitySoftLimitKw: context.capacitySoftLimit,
      dailySoftLimitKw: context.dailySoftLimit,
      softLimitSource: context.softLimitSource,
      headroomKw: context.headroom,
      powerKnown: context.powerKnown,
      hasLivePowerSample: context.hasLivePowerSample,
      powerSampleAgeMs: context.powerSampleAgeMs,
      powerFreshnessState: context.powerFreshnessState,
      ...shortfallMeta,
      hourlyBudgetExhausted: this.state.hourlyBudgetExhausted,
      usedKWh: context.usedKWh,
      budgetKWh: context.budgetKWh,
      capacityLimitKw: this.capacitySettings.limitKw,
      minutesRemaining: context.minutesRemaining,
      controlledKw: controlledKw ?? undefined,
      uncontrolledKw: uncontrolledKw ?? undefined,
      hourControlledKWh: currentHourUsageSplit.controlledKWh,
      hourUncontrolledKWh: currentHourUsageSplit.uncontrolledKWh,
      dailyBudgetRemainingKWh: today?.state.remainingKWh ?? 0,
      dailyBudgetExceeded: today?.state.exceeded ?? false,
      dailyBudgetHourKWh: extractPlanDailyBudgetHourKWh(dailyBudgetSnapshot),
      lastPowerUpdateMs: typeof this.powerTracker.lastTimestamp === 'number'
        ? this.powerTracker.lastTimestamp
        : undefined,
    };
  }

  private logPowerFreshness(context: PlanContext): void {
    const previousState = this.state.lastPowerFreshnessState;
    const currentState = context.powerFreshnessState;
    const structuredLog = this.deps.structuredLog;

    emitPowerFreshnessTransitionLogs(structuredLog, previousState, currentState, context);

    this.state.lastPowerFreshnessState = currentState;
  }
}

function emitPowerFreshnessTransitionLogs(
  structuredLog: PinoLogger | undefined,
  previousState: PlanContext['powerFreshnessState'] | null,
  currentState: PlanContext['powerFreshnessState'],
  context: PlanContext,
): void {
  emitStaleHoldTransitionLogs(structuredLog, previousState, currentState, context);
  emitFailClosedTransitionLogs(structuredLog, previousState, currentState, context);
}

function emitStaleHoldTransitionLogs(
  structuredLog: PinoLogger | undefined,
  previousState: PlanContext['powerFreshnessState'] | null,
  currentState: PlanContext['powerFreshnessState'],
  context: PlanContext,
): void {
  if (previousState !== 'stale_hold' && currentState === 'stale_hold') {
    structuredLog?.warn?.({
      event: 'power_sample_stale_hold_entered',
      powerSampleAgeMs: context.powerSampleAgeMs,
      syntheticHeadroomKw: context.headroomRaw,
    });
  } else if (previousState === 'stale_hold' && currentState !== 'stale_hold') {
    structuredLog?.info?.({
      event: 'power_sample_stale_hold_cleared',
      powerSampleAgeMs: context.powerSampleAgeMs,
    });
  }
}

function emitFailClosedTransitionLogs(
  structuredLog: PinoLogger | undefined,
  previousState: PlanContext['powerFreshnessState'] | null,
  currentState: PlanContext['powerFreshnessState'],
  context: PlanContext,
): void {
  if (previousState !== 'stale_fail_closed' && currentState === 'stale_fail_closed') {
    structuredLog?.warn?.({
      event: 'power_sample_stale_fail_closed_entered',
      powerSampleAgeMs: context.powerSampleAgeMs,
      syntheticHeadroomKw: -1,
    });
  } else if (previousState === 'stale_fail_closed' && currentState !== 'stale_fail_closed') {
    structuredLog?.info?.({
      event: 'power_sample_stale_fail_closed_cleared',
      powerSampleAgeMs: context.powerSampleAgeMs,
    });
  }
}

function buildShortfallMeta(
  capacityGuard: CapacityGuard | undefined,
  totalKw: number | null,
  hardCapLimitKw: number,
): ShortfallMeta {
  const shortfallBudgetThresholdKw = capacityGuard?.getShortfallThreshold();
  const shortfallBudgetHeadroomKw
    = typeof totalKw === 'number' && typeof shortfallBudgetThresholdKw === 'number'
      ? shortfallBudgetThresholdKw - totalKw
      : null;
  const hardCapHeadroomKw = typeof totalKw === 'number'
    ? hardCapLimitKw - totalKw
    : null;
  return {
    capacityShortfall: capacityGuard?.isInShortfall() ?? false,
    shortfallBudgetThresholdKw,
    shortfallBudgetHeadroomKw,
    hardCapLimitKw,
    hardCapHeadroomKw,
  };
}

function buildPlanContextHeadroomLogFields(
  context: PlanContext,
  capacityGuard: CapacityGuard | undefined,
  hardCapLimitKw: number,
): Record<string, number | boolean | string | null> {
  const shortfallBudgetThresholdKw = capacityGuard?.getShortfallThreshold();
  const shortfallBudgetHeadroomKw
    = typeof context.total === 'number' && typeof shortfallBudgetThresholdKw === 'number'
      ? shortfallBudgetThresholdKw - context.total
      : null;
  const hardCapHeadroomKw = typeof context.total === 'number'
    ? hardCapLimitKw - context.total
    : null;
  return {
    totalKw: context.total,
    softLimitKw: context.softLimit,
    softHeadroomKw: context.headroom,
    powerKnown: context.powerKnown,
    hasLivePowerSample: context.hasLivePowerSample,
    powerSampleAgeMs: context.powerSampleAgeMs,
    powerFreshnessState: context.powerFreshnessState,
    shortfallBudgetThresholdKw: shortfallBudgetThresholdKw ?? null,
    shortfallBudgetHeadroomKw,
    hardCapHeadroomKw,
    hardCapBreached: hardCapHeadroomKw !== null ? hardCapHeadroomKw < 0 : false,
  };
}

type OvershootEntryContributor = {
  deviceId: string;
  deviceName: string;
  deltaKw: number;
  previousPowerSource: ResolvedPowerSource;
  newPowerSource: ResolvedPowerSource;
  controllable: boolean;
  expectedByPreviousPlan: boolean | null;
  changedDuringPendingWindow: boolean;
  changedDuringCooldownWindow: boolean;
  measuredExceedsExpectedKw: number | null;
};

type ResolvedPowerSource = 'measured' | 'expected' | 'planning' | 'off' | 'unknown';

// Explains why no managed device could be named as the cause of the overshoot.
// Only set when the contributor arrays are empty (attribution unavailable). Every
// value here must be PROVABLY true from the diff inputs in scope; the confident
// causes are gated behind a single completeness assessment so no edge can sneak a
// confident-but-wrong verdict through. Operators retain the raw
// `overshootUnattributedDeltaKw` / `overshootAttributionDeltaKw` fields for finer
// detail.
//  - no_previous_snapshot: true cold start — there is no prior plan baseline to
//    diff against (the engine has not built a plan yet this lifetime).
//  - attribution_inputs_incomplete: the attribution inputs were not complete-and-fresh
//    this cycle, so no confident cause can be proven. This single honest reason folds
//    every uncertainty: a missing/stale current whole-home sample (the diff would be
//    computed off a stale cached total), a missing previous total, OR a tracked device
//    (controllable or uncontrolled) that plausibly carried the rise — its current read
//    sits above the attribution epsilon — but could not be diffed (current or previous
//    power unresolvable). Any of these means the rise could be a device PELS merely
//    failed to read, so we never blame background load.
//  - background_load_dominant: the sample was fresh, a prior baseline existed, and every
//    tracked device that could plausibly have contributed was diffable, yet the rise
//    lives in unmanaged/background load that PELS does not track per-device.
//  - all_deltas_below_epsilon: inputs were complete-and-fresh and no managed device rose
//    above the attribution epsilon (the whole-home rise itself stayed below epsilon).
type OvershootAttributionReason =
  | 'no_previous_snapshot'
  | 'attribution_inputs_incomplete'
  | 'background_load_dominant'
  | 'all_deltas_below_epsilon';

type OvershootEntryDiagnostics = {
  totalDeltaKw: number | null;
  contributors: OvershootEntryContributor[];
  logFields: {
    overshootPlanAgeMs: number | null;
    overshootPowerSampleAgeMs: number | null;
    overshootTotalDeltaKw: number | null;
    overshootAttributionDeltaKw: number;
    overshootUnattributedDeltaKw: number | null;
    overshootAttributionReason: OvershootAttributionReason | null;
    overshootTopControlledContributors: OvershootEntryContributor[];
    overshootTopUncontrolledContributors: OvershootEntryContributor[];
  };
};

function buildOvershootEntryDiagnostics(params: {
  context: PlanContext;
  nowTs: number;
  lastPowerUpdateMs: number | null;
  previousTotalKw: number | null;
  previousBuiltAtMs: number | null;
  previousDevicesById: Record<string, OvershootTrackedPlanDevice>;
  currentDevicesById: Record<string, OvershootTrackedPlanDevice>;
}): OvershootEntryDiagnostics {
  const {
    context,
    nowTs,
    lastPowerUpdateMs,
    previousTotalKw,
    previousBuiltAtMs,
    previousDevicesById,
    currentDevicesById,
  } = params;
  const contributors = Object.values(currentDevicesById)
    .map((device) => buildOvershootContributor(device, previousDevicesById[device.id]))
    .filter((contributor): contributor is OvershootEntryContributor => contributor !== null)
    .sort((left, right) => right.deltaKw - left.deltaKw);
  const controlled = contributors
    .filter((contributor) => contributor.controllable)
    .slice(0, OVERSHOOT_TOP_CONTRIBUTOR_LIMIT);
  const uncontrolled = contributors
    .filter((contributor) => !contributor.controllable)
    .slice(0, OVERSHOOT_TOP_CONTRIBUTOR_LIMIT);
  const totalDeltaKw = (
    typeof context.total === 'number'
    && typeof previousTotalKw === 'number'
    && Number.isFinite(context.total)
    && Number.isFinite(previousTotalKw)
  )
    ? roundOvershootKw(context.total - previousTotalKw)
    : null;
  const attributedDeltaKw = roundOvershootKw(contributors.reduce((sum, contributor) => sum + contributor.deltaKw, 0));
  const unattributedDeltaKw = totalDeltaKw === null ? null : roundOvershootKw(totalDeltaKw - attributedDeltaKw);
  const attributionReason = resolveOvershootAttributionReason({
    contributors,
    totalDeltaKw,
    hasPriorPlanBaseline: previousBuiltAtMs !== null || Object.keys(previousDevicesById).length > 0,
    // A confident cause may only be emitted when the attribution inputs were both
    // FRESH and COMPLETE this cycle. Any uncertainty collapses to one honest
    // `attribution_inputs_incomplete` reason rather than a confident-but-wrong cause.
    attributionInputsComplete: areAttributionInputsComplete({
      powerFreshnessState: context.powerFreshnessState,
      totalDeltaKw,
      currentDevicesById,
      previousDevicesById,
    }),
  });

  return {
    totalDeltaKw,
    contributors,
    logFields: {
      overshootPlanAgeMs: (
        typeof previousBuiltAtMs === 'number' ? Math.max(0, nowTs - previousBuiltAtMs) : null
      ),
      overshootPowerSampleAgeMs: lastPowerUpdateMs !== null ? Math.max(0, nowTs - lastPowerUpdateMs) : null,
      overshootTotalDeltaKw: totalDeltaKw,
      overshootAttributionDeltaKw: attributedDeltaKw,
      overshootUnattributedDeltaKw: unattributedDeltaKw,
      overshootAttributionReason: attributionReason,
      overshootTopControlledContributors: controlled,
      overshootTopUncontrolledContributors: uncontrolled,
    },
  };
}

// When at least one managed device crossed the attribution epsilon, the contributor
// arrays already explain the overshoot, so no reason is emitted (null). Otherwise we
// classify why attribution is unavailable. A CONFIDENT cause
// (`background_load_dominant` / `all_deltas_below_epsilon`) is gated on a single
// completeness assessment; any uncertainty collapses to one honest
// `attribution_inputs_incomplete` reason. Every emitted value is provably true from
// the diff inputs in scope.
function resolveOvershootAttributionReason(params: {
  contributors: OvershootEntryContributor[];
  totalDeltaKw: number | null;
  hasPriorPlanBaseline: boolean;
  attributionInputsComplete: boolean;
}): OvershootAttributionReason | null {
  const {
    contributors,
    totalDeltaKw,
    hasPriorPlanBaseline,
    attributionInputsComplete,
  } = params;
  if (contributors.length > 0) return null;
  // Reserve `no_previous_snapshot` for a TRUE cold start (no prior plan baseline at
  // all). It is the only reason emitted when nothing could be diffed for a reason
  // other than incomplete/stale inputs.
  if (!hasPriorPlanBaseline) return 'no_previous_snapshot';
  // A confident cause requires fresh + complete + diffable inputs. Anything short of
  // that is one honest reason rather than a confident-but-wrong cause.
  if (!attributionInputsComplete) return 'attribution_inputs_incomplete';
  // Inputs are complete-and-fresh, so `totalDeltaKw` is a finite, trustworthy number
  // and the unattributed delta equals the total delta. Classify directly off it.
  if (totalDeltaKw !== null && totalDeltaKw > OVERSHOOT_DELTA_EPSILON_KW) {
    return 'background_load_dominant';
  }
  return 'all_deltas_below_epsilon';
}

// The SINGLE completeness gate behind a confident attribution verdict. Returns true
// only when every confident-cause precondition holds:
//  (a) the power sample is FRESH — verified via the freshness state, not merely that
//      totals are finite, so a stale cached total under `stale_fail_closed` (which
//      forces an actionable overshoot off an old `getLastTotalPower()`) never yields a
//      confident delta;
//  (b) a finite, diffable total delta exists (a fresh sample with a missing previous
//      total cannot be diffed); AND
//  (c) every tracked device that could PLAUSIBLY have carried the rise — controllable
//      OR uncontrolled, with a current reading above the attribution epsilon — was
//      diffable (both current and previous power resolvable).
// (a)+(b) guard the stale-total / missing-sample cases; (c) guards the undiffable
// managed-or-uncontrolled device and the zero-current newcomer (whose 0/off current
// read could not have caused the rise, so its undiffability is harmless).
function areAttributionInputsComplete(params: {
  powerFreshnessState: PlanContext['powerFreshnessState'];
  totalDeltaKw: number | null;
  currentDevicesById: Record<string, OvershootTrackedPlanDevice>;
  previousDevicesById: Record<string, OvershootTrackedPlanDevice>;
}): boolean {
  const { powerFreshnessState, totalDeltaKw, currentDevicesById, previousDevicesById } = params;
  if (powerFreshnessState !== 'fresh') return false;
  if (totalDeltaKw === null) return false;
  return !hasUndiffablePlausibleContributor(currentDevicesById, previousDevicesById);
}

// True when at least one tracked device that could PLAUSIBLY have carried the rise was
// DROPPED from the contributor diff because it could not be diffed — its current read
// was unresolvable, or its previous-snapshot power was missing/unknown (e.g. a newly
// discovered device, or a prior stale-hold cycle). A device whose CURRENT reading sits
// at/below the attribution epsilon (off / ~0 W) cannot have caused a positive rise, so
// its undiffability is harmless and does not block a confident verdict — this covers
// the zero-current newcomer. Controllable AND uncontrolled tracked devices count: an
// undiffable uncontrolled device is just as capable of being the real cause.
function hasUndiffablePlausibleContributor(
  currentDevicesById: Record<string, OvershootTrackedPlanDevice>,
  previousDevicesById: Record<string, OvershootTrackedPlanDevice>,
): boolean {
  return Object.values(currentDevicesById).some((device) => {
    const currentKw = resolveOvershootDevicePower(device).kw;
    // A device reading at/below the epsilon (off or ~0 W) could not have caused the
    // rise; its undiffability is harmless. Only an unresolvable OR above-epsilon
    // current reading makes the device a plausible-but-undiffable contributor.
    if (currentKw !== null && currentKw <= OVERSHOOT_DELTA_EPSILON_KW) return false;
    const previousKw = resolveOvershootDevicePower(previousDevicesById[device.id]).kw;
    return currentKw === null || previousKw === null;
  });
}

function buildOvershootContributor(
  device: OvershootTrackedPlanDevice,
  previous: OvershootTrackedPlanDevice | undefined,
): OvershootEntryContributor | null {
  const nextPower = resolveOvershootDevicePower(device);
  const previousPower = resolveOvershootDevicePower(previous);
  if (nextPower.kw === null || previousPower.kw === null) return null;
  const deltaKw = nextPower.kw - previousPower.kw;
  if (deltaKw <= OVERSHOOT_DELTA_EPSILON_KW) return null;
  const expectedPowerKw = resolveFiniteNumber(device.expectedPowerKw);
  const measuredPowerKw = resolveFiniteNumber(device.measuredPowerKw);
  let expectedByPreviousPlan: boolean | null = null;
  if (previous && previous.controllable !== false) {
    expectedByPreviousPlan = previous.plannedState !== 'shed' && previous.plannedState !== 'inactive';
  }

  return {
    deviceId: device.id,
    deviceName: device.name,
    deltaKw: roundOvershootKw(deltaKw),
    previousPowerSource: previousPower.source,
    newPowerSource: nextPower.source,
    controllable: device.controllable !== false,
    expectedByPreviousPlan,
    changedDuringPendingWindow: hasPendingWindow(previous) || hasPendingWindow(device),
    changedDuringCooldownWindow: isCooldownBlocked(previous) || isCooldownBlocked(device),
    measuredExceedsExpectedKw: (
      measuredPowerKw !== null && expectedPowerKw !== null && measuredPowerKw > expectedPowerKw
    )
      ? roundOvershootKw(measuredPowerKw - expectedPowerKw)
      : null,
  };
}

function trackPlanDeviceForOvershoot(
  device: DevicePlanDevice,
  state: PlanEngineState,
  pendingBinaryCommandStore: PendingBinaryCommandStore,
): OvershootTrackedPlanDevice {
  // Raw read: activeness is computed below with the device's
  // communication model, so `peek` (not `get`) preserves the prior
  // field-read semantics without triggering store eviction here.
  const pendingBinaryCommand = pendingBinaryCommandStore.peek(device.id);
  const pendingBinaryCommandActive = isPendingBinaryCommandActive({
    pending: pendingBinaryCommand,
    communicationModel: device.communicationModel,
  });
  return {
    id: device.id,
    name: device.name,
    controllable: device.controllable,
    plannedState: device.plannedState,
    currentState: device.currentState,
    binaryControl: device.binaryControl,
    measuredPowerKw: device.measuredPowerKw,
    expectedPowerKw: device.expectedPowerKw,
    planningPowerKw: device.planningPowerKw,
    observationStale: device.observationStale,
    binaryCommandPending: pendingBinaryCommandActive && pendingBinaryCommand?.desired === true,
    pendingBinaryOnCommand: pendingBinaryCommandActive && pendingBinaryCommand?.desired === true,
    pendingBinaryOffCommand: pendingBinaryCommandActive && pendingBinaryCommand?.desired === false,
    stepCommandPending: device.stepCommandPending,
    reason: device.reason,
    pendingTargetCommand: shouldExposePendingTargetCommand(device, state),
  };
}

function trackPlanDevicesForOvershoot(
  planDevices: DevicePlanDevice[],
  state: PlanEngineState,
  pendingBinaryCommandStore: PendingBinaryCommandStore,
): Record<string, OvershootTrackedPlanDevice> {
  return Object.fromEntries(
    planDevices.map((device) => [
      device.id,
      trackPlanDeviceForOvershoot(device, state, pendingBinaryCommandStore),
    ]),
  );
}

function shouldExposePendingTargetCommand(
  device: DevicePlanDevice,
  state: PlanEngineState,
): boolean {
  const pending = state.pendingTargetCommands[device.id];
  const currentTarget = isTemperaturePlanDevice(device) ? device.currentTarget : null;
  return Boolean(
    pending
    && typeof device.plannedTarget === 'number'
    && device.plannedTarget !== currentTarget
    && device.plannedTarget === pending.desired,
  );
}

// No-smart-task fallback: pass the device list through untouched. Used when no
// decoration controller is wired (e.g. unit tests), keeping the planner free of
// any lib/objectives dependency.
function buildIdentityDecorationBundle(devices: PlanInputDevice[]): DeferredDecorationBundle {
  return {
    admittedDevices: devices,
    forceShedSet: new Set<string>(),
    deferredAvoidDeviceIds: new Set<string>(),
    deferredReleaseIntentByDeviceId: {},
  };
}

function attachDeferredReleaseIntents(
  planDevices: DevicePlanDevice[],
  intentByDeviceId: Record<string, DeferredReleaseIntent>,
  context: PlanContext,
): DevicePlanDevice[] {
  if (Object.keys(intentByDeviceId).length === 0) return planDevices;
  return planDevices.map((device) => {
    const deferredReleaseIntent = intentByDeviceId[device.id];
    if (!deferredReleaseIntent) return device;
    // binary_restore is the only intent that drives a positive (turn-on) command, so it requires
    // a fresh power sample to avoid racing the capacity guard on stale data. binary_release and
    // shed_release are negative commands and remain safe to issue under stale-power.
    if (deferredReleaseIntent === 'binary_restore' && context.powerFreshnessState !== 'fresh') return device;
    return { ...device, deferredReleaseIntent };
  });
}

function resolveOvershootDevicePower(
  device: Pick<
    OvershootTrackedPlanDevice,
    'currentState' | 'binaryControl' | 'measuredPowerKw' | 'expectedPowerKw' | 'planningPowerKw'
  > | undefined,
): { kw: number | null; source: ResolvedPowerSource } {
  if (!device) return { kw: null, source: 'unknown' };
  const measuredPowerKw = resolveFiniteNumber(device.measuredPowerKw);
  if (measuredPowerKw !== null) return { kw: measuredPowerKw, source: 'measured' };
  if (isObservedOff(device)) return { kw: 0, source: 'off' };
  const expectedPowerKw = resolveFiniteNumber(device.expectedPowerKw);
  if (expectedPowerKw !== null) return { kw: expectedPowerKw, source: 'expected' };
  const planningPowerKw = resolveFiniteNumber(device.planningPowerKw);
  if (planningPowerKw !== null) return { kw: planningPowerKw, source: 'planning' };
  return { kw: null, source: 'unknown' };
}

function hasPendingWindow(
  device: {
    pendingBinaryOnCommand?: boolean;
    pendingBinaryOffCommand?: boolean;
    binaryCommandPending?: boolean;
    stepCommandPending?: boolean;
    pendingTargetCommand?: boolean | DevicePlanDevice['pendingTargetCommand'];
  } | undefined,
): boolean {
  if (!device) return false;
  return device.pendingBinaryOnCommand === true
    || device.pendingBinaryOffCommand === true
    || device.stepCommandPending === true
    || Boolean(device.pendingTargetCommand);
}

function isCooldownBlocked(
  device: Pick<OvershootTrackedPlanDevice, 'reason'> | undefined,
): boolean {
  if (!device) return false;
  return isCooldownReason(device.reason);
}

function isCooldownReason(reason: DeviceReason): boolean {
  return isCooldownBlockedReason(reason);
}

function resolveFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? roundOvershootKw(value)
    : null;
}

function roundOvershootKw(value: number): number {
  return Math.round(value * 100) / 100;
}
