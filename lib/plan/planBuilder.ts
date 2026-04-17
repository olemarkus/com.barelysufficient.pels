/* eslint-disable max-lines -- Plan building keeps context, overshoot tracking, and meta construction together. */
import Homey from 'homey';
import CapacityGuard from '../core/capacityGuard';
import type { PowerTrackerState } from '../core/powerTracker';
import type { DevicePlan, DevicePlanDevice, PlanInputDevice, ShedAction } from './planTypes';
import type { OvershootTrackedPlanDevice, PlanEngineState } from './planState';
import { computeDailyUsageSoftLimit, computeDynamicSoftLimit, computeShortfallThreshold } from './planBudget';
import { buildPlanContext, type PlanContext, type SoftLimitSource } from './planContext';
import { buildSheddingPlan, type SheddingPlan } from './planShedding';
import { buildPlanCapacityStateSummary, normalizePlanReason } from './planLogging';
import { buildInitialPlanDevices } from './planDevices';
import { applyRestorePlan, type RestorePlanResult } from './planRestore';
import { splitControlledUsageKw, sumBudgetExemptLiveUsageKw } from './planUsage';
import {
  resolveHeadroomCardCooldown,
  syncHeadroomCardState,
} from './planHeadroomDevice';
import {
  applyShedTemperatureHold,
  finalizePlanDevices,
  normalizeShedReasons,
} from './planReasons';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import { buildDeviceDiagnosticsObservations } from './planDiagnostics';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import {
  buildDailyBudgetContext as buildPlanDailyBudgetContext,
  extractDailyBudgetHourKWh as extractPlanDailyBudgetHourKWh,
  getCurrentHourKWh,
  resolveDailySoftLimitBucket,
} from './planDailyBudgetWindow';
import { recordActivationSetback } from './planActivationBackoff';
import { OVERSHOOT_RESTORE_ATTRIBUTION_WINDOW_MS } from './planConstants';
import { resolveEffectiveCurrentOn } from './planCurrentState';
import { isPendingBinaryCommandActive } from './planObservationPolicy';
import { resolveSoftOvershootDecision, type SoftOvershootDecision } from './planOvershoot';

type ShortfallMeta = Pick<
  DevicePlan['meta'],
  'capacityShortfall' | 'shortfallBudgetThresholdKw' | 'shortfallBudgetHeadroomKw' | 'hardCapHeadroomKw'
>;

export type PlanBuilderDeps = {
  homey: Homey.App['homey'];
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
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
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
    try {
      return fn();
    } finally {
      addPerfDuration(key, Date.now() - start);
    }
  }

  private async trackDurationAsync<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      addPerfDuration(key, Date.now() - start);
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
    try {
      return await this.buildPlanSnapshotWithTimings(devices);
    } finally {
      addPerfDuration('plan_build_ms', Date.now() - planStart);
    }
  }

  private async buildPlanSnapshotWithTimings(devices: PlanInputDevice[]): Promise<DevicePlan> {
    const nowTs = Date.now();
    const {
      context,
      dailyBudgetSnapshot,
      sheddingPlan,
      overshootDecision,
    } = await this.buildContextAndShedding(devices, nowTs);
    const deviceNameById = new Map(devices.map((d) => [d.id, d.name]));

    let planDevices = this.buildPlanDevices(context, sheddingPlan);
    const restoreResult = this.applyRestorePlanWithTiming(planDevices, context, sheddingPlan, deviceNameById);
    planDevices = restoreResult.planDevices;

    const holdResult = this.applyHoldPlanWithTiming(planDevices, restoreResult, sheddingPlan);
    planDevices = holdResult.planDevices;

    planDevices = this.normalizeReasonsWithTiming(planDevices, context, restoreResult, sheddingPlan);
    planDevices = this.applyHeadroomCooldownOverlayWithTiming(planDevices);
    const finalized = this.finalizePlanWithTiming(planDevices);
    this.state.lastPlannedShedIds = finalized.lastPlannedShedIds;
    this.updateOvershootState({
      context,
      deviceNameById,
      planDevices: finalized.planDevices,
      overshootDecision,
      nowTs,
    });

    const meta = this.trackDuration('plan_meta_ms', () => (
      this.buildPlanMeta(context, finalized.planDevices, dailyBudgetSnapshot)
    ));
    this.observeDiagnostics({
      context,
      planDevices: finalized.planDevices,
      restoreResult,
    });
    return {
      meta,
      devices: finalized.planDevices,
    };
  }

  private async buildContextAndShedding(devices: PlanInputDevice[], nowTs: number): Promise<{
    context: PlanContext;
    dailyBudgetSnapshot: DailyBudgetUiPayload | null;
    sheddingPlan: SheddingPlan;
    overshootDecision: SoftOvershootDecision;
  }> {
    const desiredForMode = this.modeDeviceTargets[this.operatingMode] || {};
    const dailyBudgetSnapshot = this.dailyBudgetSnapshot;
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
    const overshootDecision = resolveSoftOvershootDecision({
      headroomKw: context.headroom,
      state: this.state,
      nowTs,
    });
    this.state.softOvershootPendingSinceMs = overshootDecision.pendingSinceMs;

    const sheddingPlan = await this.trackDurationAsync(
      'plan_shedding_ms',
      () => buildSheddingPlan(context, this.state, {
        capacityGuard: this.capacityGuard,
        powerTracker: this.powerTracker,
        getShedBehavior: (deviceId) => this.deps.getShedBehavior(deviceId),
        getPriorityForDevice: (deviceId) => this.deps.getPriorityForDevice(deviceId),
        log: (...args: unknown[]) => this.deps.log(...args),
        logDebug: (...args: unknown[]) => this.deps.logDebug(...args),
        structuredLog: this.deps.structuredLog,
      }, overshootDecision.actionable),
    );
    this.applySheddingUpdates(sheddingPlan);

    return { context, dailyBudgetSnapshot, sheddingPlan, overshootDecision };
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
    const trackedPlanDevicesById = trackPlanDevicesForOvershoot(planDevices, this.state);
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
        ...overshootDiagnostics,
      });
      this.attributeOvershootToRecentRestores(deviceNameById, nowTs);
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
  ): void {
    // Only attribute to the single most recently restored device — it was the marginal addition
    // that tipped headroom negative. Devices restored earlier were already absorbed without
    // triggering overshoot, so penalizing them would be a false attribution.
    let latestDeviceId: string | null = null;
    let latestRestoreMs = 0;
    for (const [deviceId, restoreMs] of Object.entries(this.state.lastDeviceRestoreMs)) {
      if (nowTs - restoreMs > OVERSHOOT_RESTORE_ATTRIBUTION_WINDOW_MS) continue;
      if (restoreMs > latestRestoreMs) {
        latestRestoreMs = restoreMs;
        latestDeviceId = deviceId;
      }
    }
    if (latestDeviceId === null) return;
    const deviceName = deviceNameById.get(latestDeviceId);
    const result = recordActivationSetback({ state: this.state, deviceId: latestDeviceId, nowTs });
    if (result.bumped) {
      this.deps.structuredLog?.info({
        event: 'overshoot_attributed',
        deviceId: latestDeviceId,
        ...(typeof deviceName === 'string' && deviceName.length > 0 ? { deviceName } : {}),
        restoreAgeMs: nowTs - latestRestoreMs,
        penaltyLevel: result.penaltyLevel,
      });
      if (result.transition && this.deps.deviceDiagnostics) {
        this.deps.deviceDiagnostics.recordActivationTransition(result.transition, { name: deviceName });
      }
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

  private buildPlanDevices(context: PlanContext, sheddingPlan: SheddingPlan): DevicePlanDevice[] {
    return this.trackDuration('plan_devices_ms', () => buildInitialPlanDevices({
      context,
      state: this.state,
      shedSet: sheddingPlan.shedSet,
      shedReasons: sheddingPlan.shedReasons,
      steppedDesiredStepByDeviceId: sheddingPlan.steppedDesiredStepByDeviceId,
      temperatureShedTargets: sheddingPlan.temperatureShedTargets,
      guardInShortfall: sheddingPlan.guardInShortfall,
      deps: {
        getPriorityForDevice: (deviceId) => this.deps.getPriorityForDevice(deviceId),
        getShedBehavior: (deviceId) => this.deps.getShedBehavior(deviceId),
        isCurrentHourCheap: () => this.deps.isCurrentHourCheap(),
        isCurrentHourExpensive: () => this.deps.isCurrentHourExpensive(),
        getPriceOptimizationEnabled: () => this.priceOptimizationEnabled,
        getPriceOptimizationSettings: () => this.priceOptimizationSettings,
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
      holdDuringRestoreCooldown: restoreResult.inRestoreCooldown,
      restoreCooldownSeconds: restoreResult.restoreCooldownSeconds,
      restoreCooldownRemainingSec: restoreResult.restoreCooldownRemainingSec,
      debugStructured: this.deps.debugStructured,
      getShedBehavior: (deviceId) => this.deps.getShedBehavior(deviceId),
    }));
  }

  private normalizeReasonsWithTiming(
    planDevices: DevicePlanDevice[],
    context: PlanContext,
    restoreResult: RestorePlanResult,
    sheddingPlan: SheddingPlan,
  ): DevicePlanDevice[] {
    return this.trackDuration('plan_reasons_ms', () => normalizeShedReasons({
      planDevices,
      shedReasons: sheddingPlan.shedReasons,
      guardInShortfall: sheddingPlan.guardInShortfall,
      headroomRaw: context.headroomRaw,
      inCooldown: restoreResult.inCooldown,
      activeOvershoot: restoreResult.activeOvershoot,
      shedCooldownRemainingSec: restoreResult.shedCooldownRemainingSec,
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

  private applyHeadroomCooldownOverlayWithTiming(planDevices: DevicePlanDevice[]): DevicePlanDevice[] {
    return this.trackDuration('plan_headroom_cooldown_ms', () => {
      const nowTs = Date.now();
      syncHeadroomCardState({
        state: this.state,
        devices: planDevices,
        nowTs,
        cleanupMissingDevices: false,
        diagnostics: this.deps.deviceDiagnostics,
      });

      return planDevices.map((device) => {
        const cooldown = resolveHeadroomCardCooldown({
          state: this.state,
          deviceId: device.id,
          nowTs,
        });
        if (!cooldown) return device;

        const nextDevice: DevicePlanDevice = {
          ...device,
          headroomCardBlocked: true,
          headroomCardCooldownSec: cooldown.remainingSec,
          headroomCardCooldownSource: cooldown.source,
          headroomCardCooldownFromKw: cooldown.dropFromKw,
          headroomCardCooldownToKw: cooldown.dropToKw,
        };

        return nextDevice;
      });
    });
  }

  private observeDiagnostics(params: {
    context: PlanContext;
    planDevices: DevicePlanDevice[];
    restoreResult: RestorePlanResult;
  }): void {
    if (!this.deps.deviceDiagnostics) return;
    const nowTs = Date.now();
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
    deviceNameById: ReadonlyMap<string, string>;
  }): RestorePlanResult {
    const { planDevices, context, sheddingActive, deviceNameById } = params;
    const restoreResult = applyRestorePlan({
      planDevices,
      context,
      state: this.state,
      sheddingActive,
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
    const today = dailyBudgetSnapshot?.days[dailyBudgetSnapshot.todayKey] ?? null;
    const shortfallMeta = buildShortfallMeta(this.capacityGuard, context.total, this.capacitySettings.limitKw);
    return {
      totalKw: context.total,
      softLimitKw: context.softLimit,
      capacitySoftLimitKw: context.capacitySoftLimit,
      dailySoftLimitKw: context.dailySoftLimit,
      softLimitSource: context.softLimitSource,
      headroomKw: context.headroom,
      ...shortfallMeta,
      hourlyBudgetExhausted: this.state.hourlyBudgetExhausted,
      usedKWh: context.usedKWh,
      budgetKWh: context.budgetKWh,
      minutesRemaining: context.minutesRemaining,
      controlledKw: controlledKw ?? undefined,
      uncontrolledKw: uncontrolledKw ?? undefined,
      hourControlledKWh: getCurrentHourKWh(this.powerTracker.controlledBuckets),
      hourUncontrolledKWh: getCurrentHourKWh(this.powerTracker.uncontrolledBuckets),
      dailyBudgetRemainingKWh: today?.state.remainingKWh ?? 0,
      dailyBudgetExceeded: today?.state.exceeded ?? false,
      dailyBudgetHourKWh: extractPlanDailyBudgetHourKWh(dailyBudgetSnapshot),
      lastPowerUpdateMs: typeof this.powerTracker.lastTimestamp === 'number'
        ? this.powerTracker.lastTimestamp : undefined,
    };
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
    hardCapHeadroomKw,
  };
}

function buildPlanContextHeadroomLogFields(
  context: PlanContext,
  capacityGuard: CapacityGuard | undefined,
  hardCapLimitKw: number,
): Record<string, number | boolean | null> {
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

function buildOvershootEntryDiagnostics(params: {
  context: PlanContext;
  nowTs: number;
  lastPowerUpdateMs: number | null;
  previousTotalKw: number | null;
  previousBuiltAtMs: number | null;
  previousDevicesById: Record<string, OvershootTrackedPlanDevice>;
  currentDevicesById: Record<string, OvershootTrackedPlanDevice>;
}): Record<string, unknown> {
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

  return {
    overshootPlanAgeMs: (
      typeof previousBuiltAtMs === 'number' ? Math.max(0, nowTs - previousBuiltAtMs) : null
    ),
    overshootPowerSampleAgeMs: lastPowerUpdateMs !== null ? Math.max(0, nowTs - lastPowerUpdateMs) : null,
    overshootTotalDeltaKw: totalDeltaKw,
    overshootAttributionDeltaKw: attributedDeltaKw,
    overshootUnattributedDeltaKw: unattributedDeltaKw,
    overshootTopControlledContributors: controlled,
    overshootTopUncontrolledContributors: uncontrolled,
  };
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
): OvershootTrackedPlanDevice {
  const pendingBinaryCommand = state.pendingBinaryCommands[device.id];
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
    currentOn: device.currentOn,
    measuredPowerKw: device.measuredPowerKw,
    expectedPowerKw: device.expectedPowerKw,
    planningPowerKw: device.planningPowerKw,
    observationStale: device.observationStale,
    binaryCommandPending: pendingBinaryCommandActive && pendingBinaryCommand?.desired === true,
    pendingBinaryOnCommand: pendingBinaryCommandActive && pendingBinaryCommand?.desired === true,
    pendingBinaryOffCommand: pendingBinaryCommandActive && pendingBinaryCommand?.desired === false,
    stepCommandPending: device.stepCommandPending,
    headroomCardBlocked: device.headroomCardBlocked,
    reason: device.reason,
    pendingTargetCommand: shouldExposePendingTargetCommand(device, state),
  };
}

function trackPlanDevicesForOvershoot(
  planDevices: DevicePlanDevice[],
  state: PlanEngineState,
): Record<string, OvershootTrackedPlanDevice> {
  return Object.fromEntries(
    planDevices.map((device) => [device.id, trackPlanDeviceForOvershoot(device, state)]),
  );
}

function shouldExposePendingTargetCommand(
  device: Pick<DevicePlanDevice, 'id' | 'plannedTarget' | 'currentTarget'>,
  state: PlanEngineState,
): boolean {
  const pending = state.pendingTargetCommands[device.id];
  return Boolean(
    pending
    && typeof device.plannedTarget === 'number'
    && device.plannedTarget !== device.currentTarget
    && device.plannedTarget === pending.desired,
  );
}

function resolveOvershootDevicePower(
  device: Pick<
    OvershootTrackedPlanDevice,
    'currentState' | 'currentOn' | 'measuredPowerKw' | 'expectedPowerKw' | 'planningPowerKw'
  > | undefined,
): { kw: number | null; source: ResolvedPowerSource } {
  if (!device) return { kw: null, source: 'unknown' };
  const measuredPowerKw = resolveFiniteNumber(device.measuredPowerKw);
  if (measuredPowerKw !== null) return { kw: measuredPowerKw, source: 'measured' };
  if (resolveEffectiveCurrentOn(device) === false) return { kw: 0, source: 'off' };
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
  device: Pick<OvershootTrackedPlanDevice, 'headroomCardBlocked' | 'reason'> | undefined,
): boolean {
  if (!device) return false;
  return device.headroomCardBlocked === true || isCooldownReason(device.reason);
}

function isCooldownReason(reason: string | undefined): boolean {
  if (!reason) return false;
  const normalizedReason = normalizePlanReason(reason);
  return normalizedReason === 'cooldown (shedding)'
    || normalizedReason === 'cooldown (restore)'
    || normalizedReason === 'meter settling'
    || normalizedReason === 'headroom cooldown'
    || normalizedReason === 'restore pending';
}

function resolveFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? roundOvershootKw(value)
    : null;
}

function roundOvershootKw(value: number): number {
  return Math.round(value * 100) / 100;
}
