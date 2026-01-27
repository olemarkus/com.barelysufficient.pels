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

  const writeStart = Date.now();
  homey.settings.set('pels_status', result.status);
  addPerfDuration('settings_write_ms', Date.now() - writeStart);
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

const VOLATILE_WRITE_THROTTLE_MS = 60 * 1000;

export class PlanService {
  private lastPlanSignature = '';
  private lastPlanSnapshotSignature = '';
  private lastPelsStatusJson = '';
  private lastPlanSnapshotWriteMs = 0;
  private lastPelsStatusWriteMs = 0;
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

  private trackPlanChanges(plan: DevicePlan): { signature: string; changed: boolean } {
    const deviceSignature = buildPlanSignature(plan);
    const changed = deviceSignature !== this.lastPlanSignature;
    if (changed) {
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
    return { signature: deviceSignature, changed };
  }

  private updatePlanSnapshot(plan: DevicePlan, deviceSignature: string, deviceStateChanged: boolean): void {
    const now = Date.now();
    const planSnapshotSignature = `${deviceSignature}|${JSON.stringify(plan.meta)}`;
    if (planSnapshotSignature === this.lastPlanSnapshotSignature) return;

    const throttleElapsed = now - this.lastPlanSnapshotWriteMs > VOLATILE_WRITE_THROTTLE_MS;

    if (deviceStateChanged || throttleElapsed || this.lastPlanSnapshotWriteMs === 0) {
      const writeStart = Date.now();
      this.deps.homey.settings.set('device_plan_snapshot', plan);
      this.lastPlanSnapshotWriteMs = now;
      this.lastPlanSnapshotSignature = planSnapshotSignature;
      addPerfDuration('settings_write_ms', Date.now() - writeStart);
      incPerfCounter('settings_set.device_plan_snapshot');
    }

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
      const { signature, changed } = this.trackPlanChanges(plan);
      this.updatePlanSnapshot(plan, signature, changed);
      this.updatePelsStatus(plan, changed);
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

  updatePelsStatus(plan: DevicePlan, deviceStateChanged?: boolean): void {
    const now = Date.now();
    const result = buildPelsStatus({
      plan,
      isCheap: this.deps.isCurrentHourCheap(),
      isExpensive: this.deps.isCurrentHourExpensive(),
      combinedPrices: this.deps.getCombinedPrices(),
      lastPowerUpdate: this.deps.getLastPowerUpdate(),
    });
    const statusJson = JSON.stringify(result.status);
    if (statusJson !== this.lastPelsStatusJson) {
      const stateChanged = deviceStateChanged ?? (buildPlanSignature(plan) !== this.lastPlanSignature);
      const throttleElapsed = now - this.lastPelsStatusWriteMs > VOLATILE_WRITE_THROTTLE_MS;

      if (stateChanged || throttleElapsed || this.lastPelsStatusWriteMs === 0) {
        const writeStart = Date.now();
        this.lastPelsStatusJson = statusJson;
        this.deps.homey.settings.set('pels_status', result.status);
        this.lastPelsStatusWriteMs = now;
        addPerfDuration('settings_write_ms', Date.now() - writeStart);
        incPerfCounter('settings_set.pels_status');
      }
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
