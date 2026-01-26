import type Homey from 'homey';
import type { PlanEngine } from './planEngine';
import type { DevicePlan, PlanInputDevice } from './planTypes';
import { buildPlanChangeLines, buildPlanSignature } from './planLogging';
import { buildPelsStatus } from '../core/pelsStatus';
import { PriceLevel } from '../price/priceLevels';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';

export type PelsStatusUpdateParams = {
  homey: Homey.App['homey'];
  plan: DevicePlan;
  isCheap: boolean;
  isExpensive: boolean;
  combinedPrices: unknown;
  lastPowerUpdate: number | null;
  lastNotifiedPriceLevel: PriceLevel;
  error: (...args: unknown[]) => void;
};

export const updatePelsStatusDirect = (params: PelsStatusUpdateParams): PriceLevel => {
  const {
    homey,
    plan,
    isCheap,
    isExpensive,
    combinedPrices,
    lastPowerUpdate,
    lastNotifiedPriceLevel,
    error,
  } = params;
  const result = buildPelsStatus({
    plan,
    isCheap,
    isExpensive,
    combinedPrices,
    lastPowerUpdate,
  });

  homey.settings.set('pels_status', result.status);
  incPerfCounter('settings_set.pels_status');

  if (result.priceLevel !== lastNotifiedPriceLevel) {
    const card = homey.flow?.getTriggerCard?.('price_level_changed');
    if (card) {
      card
        .trigger({ level: result.priceLevel }, { priceLevel: result.priceLevel })
        .catch((err: Error) => error('Failed to trigger price_level_changed', err));
    }
  }

  return result.priceLevel;
};

export type PlanServiceDeps = {
  homey: Homey.App['homey'];
  planEngine: PlanEngine;
  getPlanDevices: () => PlanInputDevice[];
  getCapacityDryRun: () => boolean;
  isCurrentHourCheap: () => boolean;
  isCurrentHourExpensive: () => boolean;
  getCombinedPrices: () => unknown;
  getLastPowerUpdate: () => number | null;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

const PLAN_META_KW_STEP = 0.1;
const PLAN_META_KWH_STEP = 0.01;
const STATUS_POWER_BUCKET_MS = 30 * 1000;

export class PlanService {
  private lastPlanSignature = '';
  private lastPlanSnapshotSignature = '';
  private lastPelsStatusJson = '';
  private rebuildPlanQueue: Promise<void> = Promise.resolve();
  private lastNotifiedPriceLevel: PriceLevel = PriceLevel.UNKNOWN;

  constructor(private deps: PlanServiceDeps) {}

  buildDevicePlanSnapshot(devices: PlanInputDevice[]): Promise<DevicePlan> {
    return this.deps.planEngine.buildDevicePlanSnapshot(devices);
  }

  computeDynamicSoftLimit(): number {
    return this.deps.planEngine.computeDynamicSoftLimit();
  }

  computeShortfallThreshold(): number {
    return this.deps.planEngine.computeShortfallThreshold();
  }

  handleShortfall(deficitKw: number): Promise<void> {
    return this.deps.planEngine.handleShortfall(deficitKw);
  }

  handleShortfallCleared(): Promise<void> {
    return this.deps.planEngine.handleShortfallCleared();
  }

  getLastNotifiedPriceLevel(): PriceLevel {
    return this.lastNotifiedPriceLevel;
  }

  applyPlanActions(plan: DevicePlan): Promise<void> {
    return this.deps.planEngine.applyPlanActions(plan);
  }

  applySheddingToDevice(deviceId: string, deviceName?: string, reason?: string): Promise<void> {
    return this.deps.planEngine.applySheddingToDevice(deviceId, deviceName, reason);
  }

  async rebuildPlanFromCache(): Promise<void> {
    this.rebuildPlanQueue = this.rebuildPlanQueue.then(() => this.performPlanRebuild()).catch((error) => {
      this.deps.error('Failed to rebuild plan', error as Error);
    });
    await this.rebuildPlanQueue;
  }

  private trackPlanChanges(plan: DevicePlan): string {
    const deviceSignature = buildPlanSignature(plan);
    if (deviceSignature !== this.lastPlanSignature) {
      try {
        const lines = buildPlanChangeLines(plan);
        if (lines.length) {
          this.deps.logDebug(`Plan updated (${lines.length} devices):\n- ${lines.join('\n- ')}`);
        }
      } catch (err) {
        this.deps.logDebug('Plan updated (logging failed)', err);
      }
      this.lastPlanSignature = deviceSignature;
    } else {
      incPerfCounter('plan_rebuild_no_change_total');
    }
    return deviceSignature;
  }

  private updatePlanSnapshot(plan: DevicePlan, deviceSignature: string): void {
    const planSnapshotSignature = `${deviceSignature}|${JSON.stringify(normalizePlanMeta(plan.meta))}`;
    if (planSnapshotSignature === this.lastPlanSnapshotSignature) return;
    this.lastPlanSnapshotSignature = planSnapshotSignature;
    this.deps.homey.settings.set('device_plan_snapshot', plan);
    incPerfCounter('settings_set.device_plan_snapshot');

    const api = this.deps.homey.api as { realtime?: (event: string, data: unknown) => Promise<unknown> } | undefined;
    const realtime = api?.realtime;
    if (typeof realtime === 'function') {
      realtime.call(api, 'plan_updated', plan)
        .catch((err: unknown) => this.deps.error('Failed to emit plan_updated event', err as Error));
    }
  }

  private async performPlanRebuild(): Promise<void> {
    const rebuildStart = Date.now();
    try {
      const plan = await this.buildDevicePlanSnapshot(this.deps.getPlanDevices() ?? []);
      const deviceSignature = this.trackPlanChanges(plan);
      this.updatePlanSnapshot(plan, deviceSignature);
      this.updatePelsStatus(plan);
      const hasShedding = plan.devices.some((d) => d.plannedState === 'shed');
      if (this.deps.getCapacityDryRun() && hasShedding) {
        this.deps.log('Dry run: shedding planned but not executed');
      }
      if (!this.deps.getCapacityDryRun()) {
        try {
          await this.applyPlanActions(plan);
        } catch (error) {
          this.deps.error('Failed to apply plan actions', error as Error);
        }
      }
    } finally {
      addPerfDuration('plan_rebuild_ms', Date.now() - rebuildStart);
      incPerfCounter('plan_rebuild_total');
    }
  }

  updatePelsStatus(plan: DevicePlan): void {
    const result = buildPelsStatus({
      plan,
      isCheap: this.deps.isCurrentHourCheap(),
      isExpensive: this.deps.isCurrentHourExpensive(),
      combinedPrices: this.deps.getCombinedPrices(),
      lastPowerUpdate: this.deps.getLastPowerUpdate(),
    });
    const statusJson = JSON.stringify(normalizePelsStatus(result.status, STATUS_POWER_BUCKET_MS));
    if (statusJson !== this.lastPelsStatusJson) {
      this.lastPelsStatusJson = statusJson;
      this.deps.homey.settings.set('pels_status', result.status);
      incPerfCounter('settings_set.pels_status');
    }
    if (result.priceLevel !== this.lastNotifiedPriceLevel) {
      const card = this.deps.homey.flow?.getTriggerCard?.('price_level_changed');
      if (card) {
        card
          .trigger({ level: result.priceLevel }, { priceLevel: result.priceLevel })
          .catch((err: Error) => this.deps.error('Failed to trigger price_level_changed', err));
      }
    }
    this.lastNotifiedPriceLevel = result.priceLevel;
  }
}

const roundNullable = (value: number | null, step: number): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  return Math.round(value / step) * step;
};

const roundOptional = (value: number | undefined, step: number): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  return Math.round(value / step) * step;
};

const roundOptionalNullable = (value: number | null | undefined, step: number): number | null | undefined => {
  if (value === null || value === undefined) return value;
  return roundNullable(value, step);
};

const normalizeMinutesRemaining = (value: number | undefined): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  return Math.max(0, Math.round(value));
};

const normalizePlanMeta = (meta: DevicePlan['meta']): DevicePlan['meta'] => ({
  ...meta,
  totalKw: roundNullable(meta.totalKw, PLAN_META_KW_STEP),
  softLimitKw: roundOptional(meta.softLimitKw, PLAN_META_KW_STEP) ?? meta.softLimitKw,
  capacitySoftLimitKw: roundOptional(meta.capacitySoftLimitKw, PLAN_META_KW_STEP),
  dailySoftLimitKw: roundOptionalNullable(meta.dailySoftLimitKw, PLAN_META_KW_STEP),
  headroomKw: roundNullable(meta.headroomKw, PLAN_META_KW_STEP),
  usedKWh: roundOptional(meta.usedKWh, PLAN_META_KWH_STEP),
  budgetKWh: roundOptional(meta.budgetKWh, PLAN_META_KWH_STEP),
  minutesRemaining: normalizeMinutesRemaining(meta.minutesRemaining),
  controlledKw: roundOptional(meta.controlledKw, PLAN_META_KW_STEP),
  uncontrolledKw: roundOptional(meta.uncontrolledKw, PLAN_META_KW_STEP),
  hourControlledKWh: roundOptional(meta.hourControlledKWh, PLAN_META_KWH_STEP),
  hourUncontrolledKWh: roundOptional(meta.hourUncontrolledKWh, PLAN_META_KWH_STEP),
  dailyBudgetRemainingKWh: roundOptional(meta.dailyBudgetRemainingKWh, PLAN_META_KWH_STEP),
  dailyBudgetHourKWh: roundOptional(meta.dailyBudgetHourKWh, PLAN_META_KWH_STEP),
});

const normalizePelsStatus = (
  status: ReturnType<typeof buildPelsStatus>['status'],
  powerBucketMs: number,
): ReturnType<typeof buildPelsStatus>['status'] => {
  const safeBucketMs = Math.max(1, powerBucketMs);
  const lastPowerUpdate = typeof status.lastPowerUpdate === 'number' && Number.isFinite(status.lastPowerUpdate)
    ? Math.floor(status.lastPowerUpdate / safeBucketMs) * safeBucketMs
    : status.lastPowerUpdate;
  return {
    ...status,
    headroomKw: roundNullable(status.headroomKw, PLAN_META_KW_STEP),
    hourlyLimitKw: roundOptional(status.hourlyLimitKw, PLAN_META_KW_STEP),
    hourlyUsageKwh: roundOptional(status.hourlyUsageKwh, PLAN_META_KWH_STEP) ?? status.hourlyUsageKwh,
    dailyBudgetRemainingKwh: roundOptional(status.dailyBudgetRemainingKwh, PLAN_META_KWH_STEP),
    controlledKw: roundOptional(status.controlledKw, PLAN_META_KW_STEP),
    uncontrolledKw: roundOptional(status.uncontrolledKw, PLAN_META_KW_STEP),
    lastPowerUpdate,
  };
};
