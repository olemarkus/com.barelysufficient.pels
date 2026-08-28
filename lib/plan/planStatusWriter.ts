import type { FlowPort } from '../ports/homeyRuntime';
import type { Logger as PinoLogger } from '../logging/logger';
import { buildPelsStatus, type PelsStatus } from './pelsStatus';
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
  status: PelsStatus;
  statusJson: string;
  /** The effective (membership-gated) dry-run this write reflects; undefined for the main home. */
  dryRunEffective: boolean | undefined;
};

type PlanStatusWriterDeps = {
  homey: { flow: FlowPort };
  writePelsStatus: (status: PelsStatus) => void;
  /**
   * The current hour's RESOLVED level, `UNKNOWN` included — one combined-series
   * build, and the ONLY price read this writer makes. It used to also read the
   * combined-price store just to shape-check whether a level existed; the price
   * service already knew, so the store read is gone.
   */
  getCurrentHourPriceLevel: () => PriceLevel;
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
  private lastPelsStatusResult: PelsStatus | null = null;
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
    // Resolved on EVERY call, before the dead-work gate. The `price_level_changed`
    // trigger is a fact about the hour, not about the status blob: a skipped
    // compute must not swallow it. Under `power_source = flow` the next rebuild
    // is not on a clock at all, so "the throttle bounds the latency" would have
    // been false — a whole cheap hour can begin and end between two rebuilds.
    const priceLevel = this.deps.getCurrentHourPriceLevel();
    this.notifyPriceLevelChanged(priceLevel);
    this.lastNotifiedPriceLevel = priceLevel;

    if (this.computationIsDeadWork(changes?.actionChanged === true, now)) {
      incPerfCounter('settings_set.pels_status_skipped_throttle_total');
      incPerfCounter('settings_set.pels_status_compute_skipped_total');
      return 0;
    }
    const computation = this.compute(plan, priceLevel, changes);

    return this.maybeWriteStatus(
      computation.status,
      computation.statusJson,
      changes?.actionChanged === true,
      computation.dryRunEffective,
      now,
    );
  }

  /**
   * Can this call still produce a write? When it cannot, building the status is
   * pure waste — and it is not cheap waste: `compute` summarizes the whole plan,
   * builds the payload and JSON-serializes it, only for `resolveWriteReason` to
   * discard the result.
   *
   * Prod, 13.5 h: 1501 computations produced 736 writes, so 765 — a little over
   * half — paid that cost for nothing. `planRebuildStatus` is 170 ms of a 311 ms
   * rebuild, and the write itself only accounts for 100 ms of it.
   *
   * The three reasons that can force a write inside the throttle window are all
   * knowable without the status: the first-ever write, an action-signature
   * change, and a dry-run posture flip. Mirror exactly those, so this stays a
   * fast path in front of `resolveWriteReason` rather than a second policy —
   * every case it lets through is still decided there.
   *
   * No behaviour changes on this path. In particular `price_level_changed` is
   * NOT gated by it: `update` resolves the level and fires the trigger before
   * asking this question, because the level is a fact about the hour rather than
   * a property of the status blob, and nothing guarantees another rebuild inside
   * the hour that could carry a deferred one.
   */
  private computationIsDeadWork(actionChanged: boolean, now: number): boolean {
    if (this.lastPelsStatusWriteMs === 0) return false;
    if (actionChanged) return false;
    if (this.deps.getEffectiveDryRun?.() !== this.lastPelsStatusWrittenDryRunEffective) return false;
    return now - this.lastPelsStatusWriteMs <= VOLATILE_WRITE_THROTTLE_MS;
  }

  private compute(
    plan: DevicePlan,
    priceLevel: PriceLevel,
    changes?: StatusPlanChanges,
  ): PelsStatusComputation {
    const lastPowerUpdate = normalizeLastPowerUpdate(this.deps.getLastPowerUpdate(), STATUS_POWER_BUCKET_MS);
    const dryRunEffective = this.deps.getEffectiveDryRun?.();
    const inputKey = buildPelsStatusInputKey({
      changes,
      priceLevel,
      lastPowerUpdate,
      powerFreshnessState: plan.meta.powerFreshnessState,
      powerNowKw: plan.meta.powerNowKw,
      dryRunEffective,
    });
    const status = this.resolveStatusResult({
      inputKey,
      plan,
      priceLevel,
      lastPowerUpdate,
      dryRunEffective,
    });

    return {
      status,
      statusJson: JSON.stringify(normalizePelsStatus(status, STATUS_POWER_BUCKET_MS)),
      dryRunEffective,
    };
  }

  private resolveStatusResult(params: {
    inputKey: string;
    plan: DevicePlan;
    priceLevel: PriceLevel;
    lastPowerUpdate: number | null;
    dryRunEffective?: boolean;
  }): PelsStatus {
    const { inputKey, plan, priceLevel, lastPowerUpdate, dryRunEffective } = params;
    if (this.lastPelsStatusInputKey === inputKey && this.lastPelsStatusResult) {
      return this.lastPelsStatusResult;
    }

    const result = buildPelsStatus({
      plan,
      priceLevel,
      lastPowerUpdate,
      dryRunEffective,
    });
    this.lastPelsStatusInputKey = inputKey;
    this.lastPelsStatusResult = result;
    return result;
  }

  private maybeWriteStatus(
    status: PelsStatus,
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
    status: PelsStatus,
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
