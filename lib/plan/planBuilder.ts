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
 * fixed once `buildSheddingPlan` returns, plus the decoration seam's
 * `forceShedSet` merged here before materialization. Every later stage —
 * materialization, restore, hold, reason normalization — only copies
 * `shedSet` membership into per-device `plannedState`/shed actions, or
 * declines to lift an existing shed; none of them may add a device to the
 * shed set.
 *
 * Boundary (`lib/plan/AGENTS.md`): smart-task-agnostic — objectives reach
 * the builder only through the injected `decorateDeferredObjectives` seam.
 * Capacity-model internals: `docs/technical.md`.
 */
import CapacityGuard from '../power/capacityGuard';
import type { PowerTrackerState } from '../power/tracker';
import type { DevicePlan, DevicePlanDevice, PlanInputDevice, ShedAction } from './planTypes';
import type { PlanEngineState } from './planState';
import { computeDailyUsageSoftLimit, computeDynamicSoftLimit, computeShortfallThreshold } from './planBudget';
import { buildPlanContext, type PlanContext, type SoftLimitSource } from './planContext';
import { buildSheddingPlan, type SheddingPlan } from './shedding';
import { buildInitialPlanDevices } from './planDevices';
import { applyRestorePlan, type RestorePlanResult } from './restore';
import { sumBudgetExemptLiveUsageKw } from './planUsage';
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

export class PlanBuilder {
  private readonly overshootTracker: OvershootTracker;

  constructor(private deps: PlanBuilderDeps, private state: PlanEngineState) {
    this.overshootTracker = new OvershootTracker(state, deps);
  }

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
    this.trackDuration('plan_overshoot_ms', () => this.overshootTracker.updateOvershootState({
      context,
      capacityGuard: this.capacityGuard,
      capacityLimitKw: this.capacitySettings.limitKw,
      powerTracker: this.powerTracker,
      deviceNameById,
      planDevices: finalized.planDevices,
      overshootDecision,
      nowTs,
    }));

    const meta = this.trackDuration('plan_meta_ms', () => buildPlanMeta({
      context,
      planDevices: finalized.planDevices,
      dailyBudgetSnapshot,
      powerTracker: this.powerTracker,
      capacityGuard: this.capacityGuard,
      capacityLimitKw: this.capacitySettings.limitKw,
      hourlyBudgetExhausted: this.state.hourlyBudgetExhausted,
    }));
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
      // No staleness dep wired (e.g. tests) ⇒ treat every device as fresh, so the
      // freshness gate is a no-op and starvation counts as before.
      getObservationStale: this.deps.getObservationStale ?? (() => false),
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
      this.deps.setCapacityInShortfall(sheddingPlan.guardInShortfall);
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

  private logPowerFreshness(context: PlanContext): void {
    const previousState = this.state.lastPowerFreshnessState;
    const currentState = context.powerFreshnessState;
    const structuredLog = this.deps.structuredLog;

    emitPowerFreshnessTransitionLogs(structuredLog, previousState, currentState, context);

    this.state.lastPowerFreshnessState = currentState;
  }
}
