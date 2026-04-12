/* eslint-disable max-lines -- Plan building keeps context, overshoot tracking, and meta construction together. */
import Homey from 'homey';
import CapacityGuard from '../core/capacityGuard';
import type { PowerTrackerState } from '../core/powerTracker';
import type { DevicePlan, DevicePlanDevice, PlanInputDevice, ShedAction } from './planTypes';
import type { PlanEngineState } from './planState';
import { computeDailyUsageSoftLimit, computeDynamicSoftLimit, computeShortfallThreshold } from './planBudget';
import { buildPlanContext, type PlanContext, type SoftLimitSource } from './planContext';
import { buildSheddingPlan, type SheddingPlan } from './planShedding';
import { buildPlanCapacityStateSummary } from './planLogging';
import { buildInitialPlanDevices } from './planDevices';
import { applyRestorePlan, type RestorePlanResult } from './planRestore';
import { sumBudgetExemptLiveUsageKw, sumControlledUsageKw } from './planUsage';
import {
  formatHeadroomCooldownReason,
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

type ShortfallMeta = Pick<
  DevicePlan['meta'],
  'capacityShortfall' | 'shortfallThresholdKw' | 'hardCapHeadroomKw'
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
      logDebug: (...args: unknown[]) => this.deps.logDebug(...args),
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
    const { context, dailyBudgetSnapshot, sheddingPlan } = await this.buildContextAndShedding(devices);
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
    this.updateOvershootState(context, deviceNameById, finalized.planDevices);

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

  private async buildContextAndShedding(devices: PlanInputDevice[]): Promise<{
    context: PlanContext;
    dailyBudgetSnapshot: DailyBudgetUiPayload | null;
    sheddingPlan: SheddingPlan;
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
      }),
    );
    this.applySheddingUpdates(sheddingPlan);

    return { context, dailyBudgetSnapshot, sheddingPlan };
  }

  private updateOvershootState(
    context: PlanContext,
    deviceNameById: ReadonlyMap<string, string>,
    planDevices: DevicePlanDevice[],
  ): void {
    const overshootActive = context.headroom !== null && context.headroom < 0;
    const prevOvershoot = this.state.wasOvershoot;
    if (overshootActive && !prevOvershoot) {
      this.state.overshootLogged = true;
      this.state.overshootStartedMs = Date.now();
      this.state.lastOvershootEscalationMs = null;
      this.state.lastOvershootMitigationMs = null;
      this.deps.structuredLog?.info({
        event: 'overshoot_entered',
        headroomKw: context.headroom,
        ...buildPlanContextHeadroomLogFields(context, this.capacityGuard),
        ...buildPlanCapacityStateSummary({
          meta: {
            totalKw: context.total,
            softLimitKw: context.softLimit,
            headroomKw: context.headroom,
          },
          devices: planDevices,
        }),
      });
      this.attributeOvershootToRecentRestores(deviceNameById);
    } else if (!overshootActive && prevOvershoot && this.state.overshootLogged) {
      this.state.overshootLogged = false;
      const durationMs = this.state.overshootStartedMs !== null ? Date.now() - this.state.overshootStartedMs : 0;
      this.state.overshootStartedMs = null;
      this.state.lastOvershootEscalationMs = null;
      this.state.lastOvershootMitigationMs = null;
      this.deps.structuredLog?.info({
        event: 'overshoot_cleared',
        durationMs,
        ...buildPlanContextHeadroomLogFields(context, this.capacityGuard),
      });
    } else if (overshootActive && this.state.overshootStartedMs === null) {
      this.state.overshootStartedMs = Date.now();
    }
    this.state.wasOvershoot = overshootActive;
  }

  private attributeOvershootToRecentRestores(deviceNameById: ReadonlyMap<string, string>): void {
    const nowTs = Date.now();
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
    const deviceName = deviceNameById.get(latestDeviceId) ?? latestDeviceId;
    const result = recordActivationSetback({ state: this.state, deviceId: latestDeviceId, nowTs });
    if (result.bumped) {
      this.deps.structuredLog?.info({
        event: 'overshoot_attributed',
        deviceId: latestDeviceId,
        deviceName,
        restoreAgeMs: nowTs - latestRestoreMs,
        penaltyLevel: result.penaltyLevel,
      });
      if (result.transition && this.deps.deviceDiagnostics) {
        this.deps.deviceDiagnostics.recordActivationTransition(result.transition, { name: deviceName });
      }
    }
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
      inRestoreCooldown: restoreResult.inRestoreCooldown,
      shedCooldownRemainingSec: restoreResult.shedCooldownRemainingSec,
      restoreCooldownRemainingSec: restoreResult.restoreCooldownRemainingSec,
    }));
  }

  private finalizePlanWithTiming(planDevices: DevicePlanDevice[]): {
    planDevices: DevicePlanDevice[];
    lastPlannedShedIds: Set<string>;
  } {
    return this.trackDuration('plan_finalize_ms', () => finalizePlanDevices(planDevices));
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

        if (!this.shouldOverrideReasonWithHeadroomCooldown(device)) {
          return nextDevice;
        }

        return {
          ...nextDevice,
          reason: formatHeadroomCooldownReason({
            source: cooldown.source,
            remainingSec: cooldown.remainingSec,
            dropFromKw: cooldown.dropFromKw,
            dropToKw: cooldown.dropToKw,
          }),
        };
      });
    });
  }

  private shouldOverrideReasonWithHeadroomCooldown(device: DevicePlanDevice): boolean {
    if (device.controllable === false) return false;
    if (device.plannedState !== 'keep') return false;
    if (device.currentState === 'off' || device.currentState === 'unknown') return false;
    if (!device.reason) return true;
    return device.reason === 'keep' || device.reason.startsWith('keep (');
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
      logDebug: (...args: unknown[]) => this.deps.logDebug(...args),
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
    const controlledKw = sumControlledUsageKw(planDevices);
    const uncontrolledKw = typeof context.total === 'number' && controlledKw !== null
      ? Math.max(0, context.total - controlledKw)
      : undefined;
    const today = dailyBudgetSnapshot?.days[dailyBudgetSnapshot.todayKey] ?? null;
    const shortfallMeta = buildShortfallMeta(this.capacityGuard, context.total);
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
      uncontrolledKw,
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

function buildShortfallMeta(capacityGuard: CapacityGuard | undefined, totalKw: number | null): ShortfallMeta {
  const shortfallThresholdKw = capacityGuard?.getShortfallThreshold();
  const hardCapHeadroomKw = typeof totalKw === 'number' && typeof shortfallThresholdKw === 'number'
    ? shortfallThresholdKw - totalKw
    : null;
  return {
    capacityShortfall: capacityGuard?.isInShortfall() ?? false,
    shortfallThresholdKw,
    hardCapHeadroomKw,
  };
}

function buildPlanContextHeadroomLogFields(
  context: PlanContext,
  capacityGuard: CapacityGuard | undefined,
): Record<string, number | boolean | null> {
  const shortfallThresholdKw = capacityGuard?.getShortfallThreshold();
  const hardCapHeadroomKw = typeof context.total === 'number' && typeof shortfallThresholdKw === 'number'
    ? shortfallThresholdKw - context.total
    : null;
  return {
    totalKw: context.total,
    softLimitKw: context.softLimit,
    softHeadroomKw: context.headroom,
    shortfallThresholdKw: shortfallThresholdKw ?? null,
    hardCapHeadroomKw,
    hardCapBreached: hardCapHeadroomKw !== null ? hardCapHeadroomKw < 0 : false,
  };
}
