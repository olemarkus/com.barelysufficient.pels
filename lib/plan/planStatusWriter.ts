import type Homey from 'homey';
import { buildPelsStatus } from '../core/pelsStatus';
import { PriceLevel } from '../price/priceLevels';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import { VOLATILE_WRITE_THROTTLE_MS } from '../utils/timingConstants';
import {
  buildPelsStatusInputKey,
  normalizeLastPowerUpdate,
  normalizePelsStatus,
  type PlanStatusInputChanges,
} from './planStatusHelpers';
import {
  STATUS_POWER_BUCKET_MS,
  type PelsStatusComputation,
  type PelsStatusWriteReason,
  type StatusPlanChanges,
} from './planServiceInternals';
import type { DevicePlan } from './planTypes';

type PlanStatusWriterDeps = {
  homey: Homey.App['homey'];
  getCombinedPrices: () => unknown;
  isCurrentHourCheap: () => boolean;
  isCurrentHourExpensive: () => boolean;
  getLastPowerUpdate: () => number | null;
  error: (...args: unknown[]) => void;
};

export class PlanStatusWriter {
  private lastPelsStatusWrittenJson = '';
  private lastPelsStatusInputKey = '';
  private lastPelsStatusResult: ReturnType<typeof buildPelsStatus> | null = null;
  private lastPelsStatusWriteMs = 0;
  private lastNotifiedPriceLevel: PriceLevel = PriceLevel.UNKNOWN;

  constructor(private deps: PlanStatusWriterDeps) {}

  getLastNotifiedPriceLevel(): PriceLevel {
    return this.lastNotifiedPriceLevel;
  }

  update(plan: DevicePlan, changes?: StatusPlanChanges): number {
    const now = Date.now();
    const computation = this.compute(plan, changes);

    const writeMs = this.maybeWriteStatus(
      computation.result.status,
      computation.statusJson,
      changes?.actionChanged === true,
      now,
    );

    this.notifyPriceLevelChanged(computation.result.priceLevel);
    this.lastNotifiedPriceLevel = computation.result.priceLevel;
    return writeMs;
  }

  private compute(plan: DevicePlan, changes?: StatusPlanChanges): PelsStatusComputation {
    const combinedPrices = this.deps.getCombinedPrices();
    const isCheap = this.deps.isCurrentHourCheap();
    const isExpensive = this.deps.isCurrentHourExpensive();
    const lastPowerUpdate = normalizeLastPowerUpdate(this.deps.getLastPowerUpdate(), STATUS_POWER_BUCKET_MS);
    const inputKey = buildPelsStatusInputKey({
      changes: changes as PlanStatusInputChanges | undefined,
      isCheap,
      isExpensive,
      combinedPrices,
      lastPowerUpdate,
    });
    const result = this.resolveStatusResult({
      inputKey,
      plan,
      isCheap,
      isExpensive,
      combinedPrices,
      lastPowerUpdate,
    });

    return {
      result,
      statusJson: JSON.stringify(normalizePelsStatus(result.status, STATUS_POWER_BUCKET_MS)),
    };
  }

  private resolveStatusResult(params: {
    inputKey: string;
    plan: DevicePlan;
    isCheap: boolean;
    isExpensive: boolean;
    combinedPrices: unknown;
    lastPowerUpdate: number | null;
  }): ReturnType<typeof buildPelsStatus> {
    const { inputKey, plan, isCheap, isExpensive, combinedPrices, lastPowerUpdate } = params;
    if (this.lastPelsStatusInputKey === inputKey && this.lastPelsStatusResult) {
      return this.lastPelsStatusResult;
    }

    const result = buildPelsStatus({
      plan,
      isCheap,
      isExpensive,
      combinedPrices,
      lastPowerUpdate,
    });
    this.lastPelsStatusInputKey = inputKey;
    this.lastPelsStatusResult = result;
    return result;
  }

  private maybeWriteStatus(
    status: ReturnType<typeof buildPelsStatus>['status'],
    statusJson: string,
    actionChanged: boolean,
    now: number,
  ): number {
    const reason = this.resolveWriteReason(statusJson, actionChanged, now);
    if (!reason) return 0;
    return this.writeStatus(status, statusJson, reason, now);
  }

  private resolveWriteReason(
    statusJson: string,
    actionChanged: boolean,
    now: number,
  ): PelsStatusWriteReason | null {
    if (statusJson === this.lastPelsStatusWrittenJson) return null;
    if (this.lastPelsStatusWriteMs === 0) return 'initial';
    if (actionChanged) return 'action_changed';
    if (now - this.lastPelsStatusWriteMs > VOLATILE_WRITE_THROTTLE_MS) return 'throttle';

    incPerfCounter('settings_set.pels_status_skipped_throttle_total');
    return null;
  }

  private writeStatus(
    status: ReturnType<typeof buildPelsStatus>['status'],
    statusJson: string,
    reason: PelsStatusWriteReason,
    now: number,
  ): number {
    const writeStart = Date.now();
    this.deps.homey.settings.set('pels_status', status);
    this.lastPelsStatusWrittenJson = statusJson;
    this.lastPelsStatusWriteMs = now;
    const writeMs = Date.now() - writeStart;
    addPerfDuration('settings_write_ms', writeMs);
    incPerfCounter('settings_set.pels_status');
    incPerfCounter(`settings_set.pels_status_reason.${reason}_total`);
    return writeMs;
  }

  private notifyPriceLevelChanged(priceLevel: PriceLevel): void {
    if (priceLevel === this.lastNotifiedPriceLevel) return;

    const card = this.deps.homey.flow?.getTriggerCard?.('price_level_changed');
    if (card) {
      card
        .trigger({ level: priceLevel }, { priceLevel })
        .catch((err: Error) => this.deps.error('Failed to trigger price_level_changed', err));
    }
  }
}
