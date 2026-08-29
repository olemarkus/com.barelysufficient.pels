import type { FlowPort } from '../ports/homeyRuntime';
import type { Logger as PinoLogger } from '../logging/logger';
import { buildPelsStatus } from './pelsStatus';
import { PriceLevel } from '../price/priceLevels';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import { VOLATILE_WRITE_THROTTLE_MS } from '../utils/timingConstants';
import {
  buildPelsStatusInputKey,
  normalizeLastPowerUpdate,
  normalizePelsStatus,
} from './planStatusHelpers';
import {
  STATUS_POWER_BUCKET_MS,
} from './planServiceInternals';
import type {
  DevicePlan,
  PelsStatusWriteReason,
  StatusPlanChanges,
} from './planTypes';

type PelsStatusComputation = {
  result: ReturnType<typeof buildPelsStatus>;
  statusJson: string;
  /** The effective (membership-gated) dry-run this write reflects; undefined for the main home. */
  dryRunEffective: boolean | undefined;
};

type PlanStatusWriterDeps = {
  homey: { flow: FlowPort };
  writePelsStatus: (status: ReturnType<typeof buildPelsStatus>['status']) => void;
  getCombinedPrices: () => unknown;
  // Both current-hour flags from ONE combined-series build; asking the two
  // predicates separately rebuilt the uncached series twice per status compute.
  getCurrentHourPriceLevel: () => { cheap: boolean; expensive: boolean };
  getLastPowerUpdate: () => number | null;
  /**
   * When set, the effective (membership-gated) dry-run this bundle actuates on,
   * written into `pels_status` as `dryRunEffective` for the per-home Limits
   * card's honest posture. Sub-homes only — the main home omits it so its
   * persisted blob stays byte-identical.
   */
  getEffectiveDryRun?: () => boolean;
  structuredLog?: PinoLogger;
};

export class PlanStatusWriter {
  private lastPelsStatusWrittenJson = '';
  private lastPelsStatusInputKey = '';
  private lastPelsStatusResult: ReturnType<typeof buildPelsStatus> | null = null;
  private lastPelsStatusWriteMs = 0;
  /**
   * The effective dry-run captured at the last persist. A change vs the current
   * value is a material posture flip (control activated from an already-planned
   * dry-run shed, or the membership gate opening) that must force a status write
   * even inside the volatile throttle window — otherwise the per-home Limits card
   * lags (still "Simulating" after control is live, or vice versa). Undefined for
   * the main home, so its cadence is untouched (undefined never differs).
   */
  private lastPelsStatusWrittenDryRunEffective: boolean | undefined = undefined;
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
      computation.dryRunEffective,
      now,
    );

    this.notifyPriceLevelChanged(computation.result.priceLevel);
    this.lastNotifiedPriceLevel = computation.result.priceLevel;
    return writeMs;
  }

  private compute(plan: DevicePlan, changes?: StatusPlanChanges): PelsStatusComputation {
    const combinedPrices = this.deps.getCombinedPrices();
    const { cheap: isCheap, expensive: isExpensive } = this.deps.getCurrentHourPriceLevel();
    const lastPowerUpdate = normalizeLastPowerUpdate(this.deps.getLastPowerUpdate(), STATUS_POWER_BUCKET_MS);
    const dryRunEffective = this.deps.getEffectiveDryRun?.();
    const inputKey = buildPelsStatusInputKey({
      changes: changes,
      isCheap,
      isExpensive,
      combinedPrices,
      lastPowerUpdate,
      powerFreshnessState: plan.meta.powerFreshnessState,
      powerNowKw: plan.meta.powerNowKw,
      dryRunEffective,
    });
    const result = this.resolveStatusResult({
      inputKey,
      plan,
      isCheap,
      isExpensive,
      combinedPrices,
      lastPowerUpdate,
      dryRunEffective,
    });

    return {
      result,
      statusJson: JSON.stringify(normalizePelsStatus(result.status, STATUS_POWER_BUCKET_MS)),
      dryRunEffective,
    };
  }

  private resolveStatusResult(params: {
    inputKey: string;
    plan: DevicePlan;
    isCheap: boolean;
    isExpensive: boolean;
    combinedPrices: unknown;
    lastPowerUpdate: number | null;
    dryRunEffective?: boolean;
  }): ReturnType<typeof buildPelsStatus> {
    const { inputKey, plan, isCheap, isExpensive, combinedPrices, lastPowerUpdate, dryRunEffective } = params;
    if (this.lastPelsStatusInputKey === inputKey && this.lastPelsStatusResult) {
      return this.lastPelsStatusResult;
    }

    const result = buildPelsStatus({
      plan,
      isCheap,
      isExpensive,
      combinedPrices,
      lastPowerUpdate,
      dryRunEffective,
    });
    this.lastPelsStatusInputKey = inputKey;
    this.lastPelsStatusResult = result;
    return result;
  }

  private maybeWriteStatus(
    status: ReturnType<typeof buildPelsStatus>['status'],
    statusJson: string,
    actionChanged: boolean,
    dryRunEffective: boolean | undefined,
    now: number,
  ): number {
    const reason = this.resolveWriteReason(statusJson, actionChanged, dryRunEffective, now);
    if (!reason) return 0;
    return this.writeStatus(status, statusJson, dryRunEffective, reason, now);
  }

  private resolveWriteReason(
    statusJson: string,
    actionChanged: boolean,
    dryRunEffective: boolean | undefined,
    now: number,
  ): PelsStatusWriteReason | null {
    if (statusJson === this.lastPelsStatusWrittenJson) return null;
    if (this.lastPelsStatusWriteMs === 0) return 'initial';
    if (actionChanged) return 'action_changed';
    // A posture flip (effective dry-run changed since the last persist) is
    // material even without an action-signature change — force the write so the
    // per-home Limits card reflects live/simulating promptly, busting the
    // volatile throttle. No-op for the main home (undefined === undefined).
    if (dryRunEffective !== this.lastPelsStatusWrittenDryRunEffective) return 'posture_flip';
    if (now - this.lastPelsStatusWriteMs > VOLATILE_WRITE_THROTTLE_MS) return 'throttle';

    incPerfCounter('settings_set.pels_status_skipped_throttle_total');
    return null;
  }

  private writeStatus(
    status: ReturnType<typeof buildPelsStatus>['status'],
    statusJson: string,
    dryRunEffective: boolean | undefined,
    reason: PelsStatusWriteReason,
    now: number,
  ): number {
    const writeStart = Date.now();
    this.deps.writePelsStatus(status);
    this.lastPelsStatusWrittenJson = statusJson;
    this.lastPelsStatusWrittenDryRunEffective = dryRunEffective;
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
        .catch((err: Error) => this.deps.structuredLog?.error({
          event: 'price_level_trigger_failed',
          error: err.message,
          stack: err.stack,
        }));
    }
  }
}
