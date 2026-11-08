import type { FlowPort } from '../ports/homeyRuntime';
import type { Logger as PinoLogger } from '../logging/logger';
import { buildPelsStatus, type PelsStatus } from './pelsStatus';
import { PriceLevel } from '../price/priceLevels';
import { incPerfCounter } from '../utils/perfCounters';
import { VOLATILE_WRITE_THROTTLE_MS } from '../utils/timingConstants';
import {
  buildPelsStatusInputKey,
  normalizeLastPowerUpdate,
  normalizePelsStatus,
  type StatusPublishFacts,
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
};

const publishFactsChanged = (current: StatusPublishFacts, written: StatusPublishFacts): boolean => (
  current.dryRunEffective !== written.dryRunEffective
  || current.powerIsMeasured !== written.powerIsMeasured
  || current.capacityShortfall !== written.capacityShortfall
);

type PlanStatusWriterDeps = {
  homey: { flow: FlowPort };
  /** Publish this home's status into the app's in-memory registry (`lib/plan/planStatusRegistry.ts`). */
  publishPelsStatus: (status: PelsStatus) => void;
  /**
   * The current hour's RESOLVED level, `UNKNOWN` included — one combined-series
   * build, and the ONLY price read this writer makes. It used to also read the
   * combined-price store just to shape-check whether a level existed; the price
   * service already knew, so the store read is gone.
   */
  getCurrentHourPriceLevel: () => PriceLevel;
  /** The tracker's stamp; a status is computed only behind the measurement gate, so it exists. */
  getLastPowerUpdate: () => number;
  /**
   * The effective (membership-gated) dry-run this home actuates on, written into
   * `pels_status` as `dryRunEffective` for its Limits card's honest posture. The
   * same read the planner and the service gate on — there is no second notion of
   * "the dry-run, for status purposes".
   */
  getCapacityDryRun: () => boolean;
  structuredLog: PinoLogger;
};

export class PlanStatusWriter {
  private lastPelsStatusWrittenJson = '';
  private lastPelsStatusInputKey = '';
  private lastPelsStatusResult: PelsStatus | null = null;
  private lastPelsStatusWriteMs = 0;
  /** The publish facts of the last write; `null` until the first one. */
  private lastWrittenPublishFacts: StatusPublishFacts | null = null;
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

    const facts: StatusPublishFacts = {
      dryRunEffective: this.deps.getCapacityDryRun(),
      powerIsMeasured: plan.meta.powerIsMeasured,
      capacityShortfall: plan.meta.capacityShortfall,
    };
    if (this.computationIsDeadWork(changes?.actionChanged === true, facts, now)) {
      incPerfCounter('plan_status_skipped_throttle_total');
      incPerfCounter('plan_status_compute_skipped_total');
      return 0;
    }
    const computation = this.compute(plan, priceLevel, facts, changes);

    return this.maybeWriteStatus(computation, changes?.actionChanged === true, facts, now);
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
   * The reasons that can force a write inside the throttle window are all
   * knowable without the status: the first-ever write, an action-signature
   * change, and a change in the publish facts. Mirror exactly those, so this stays a
   * fast path in front of `resolveWriteReason` rather than a second policy —
   * every case it lets through is still decided there.
   *
   * No behaviour changes on this path. In particular `price_level_changed` is
   * NOT gated by it: `update` resolves the level and fires the trigger before
   * asking this question, because the level is a fact about the hour rather than
   * a property of the status blob, and nothing guarantees another rebuild inside
   * the hour that could carry a deferred one.
   */
  private computationIsDeadWork(actionChanged: boolean, facts: StatusPublishFacts, now: number): boolean {
    const written = this.lastWrittenPublishFacts;
    if (written === null) return false;
    if (actionChanged) return false;
    if (publishFactsChanged(facts, written)) return false;
    return now - this.lastPelsStatusWriteMs <= VOLATILE_WRITE_THROTTLE_MS;
  }

  private compute(
    plan: DevicePlan,
    priceLevel: PriceLevel,
    facts: StatusPublishFacts,
    changes?: StatusPlanChanges,
  ): PelsStatusComputation {
    const lastPowerUpdate = normalizeLastPowerUpdate(this.deps.getLastPowerUpdate(), STATUS_POWER_BUCKET_MS);
    const inputKey = buildPelsStatusInputKey(changes, priceLevel, lastPowerUpdate, facts);
    const status = this.resolveStatusResult(inputKey, plan, priceLevel, lastPowerUpdate, facts.dryRunEffective);

    return {
      status,
      statusJson: JSON.stringify(normalizePelsStatus(status)),
    };
  }

  private resolveStatusResult(
    inputKey: string,
    plan: DevicePlan,
    priceLevel: PriceLevel,
    lastPowerUpdate: number,
    dryRunEffective: boolean,
  ): PelsStatus {
    if (this.lastPelsStatusInputKey === inputKey && this.lastPelsStatusResult) {
      return this.lastPelsStatusResult;
    }

    const result = buildPelsStatus(plan, priceLevel, lastPowerUpdate, dryRunEffective);
    this.lastPelsStatusInputKey = inputKey;
    this.lastPelsStatusResult = result;
    return result;
  }

  private maybeWriteStatus(
    computation: PelsStatusComputation,
    actionChanged: boolean,
    facts: StatusPublishFacts,
    now: number,
  ): number {
    const reason = this.resolveWriteReason(computation.statusJson, actionChanged, facts, now);
    if (!reason) return 0;
    return this.writeStatus(computation, facts, reason, now);
  }

  private resolveWriteReason(
    statusJson: string,
    actionChanged: boolean,
    facts: StatusPublishFacts,
    now: number,
  ): PelsStatusWriteReason | null {
    if (statusJson === this.lastPelsStatusWrittenJson) return null;
    const written = this.lastWrittenPublishFacts;
    if (written === null) return 'initial';
    if (actionChanged) return 'action_changed';
    if (facts.capacityShortfall !== written.capacityShortfall) return 'shortfall_changed';
    if (publishFactsChanged(facts, written)) return 'posture_flip';
    if (now - this.lastPelsStatusWriteMs > VOLATILE_WRITE_THROTTLE_MS) return 'throttle';

    incPerfCounter('plan_status_skipped_throttle_total');
    return null;
  }

  private writeStatus(
    computation: PelsStatusComputation,
    facts: StatusPublishFacts,
    reason: PelsStatusWriteReason,
    now: number,
  ): number {
    // The publish runs every listener inline — the realtime push to the
    // WebView, the Insights driver's capability writes — so its time is still
    // worth a metric, as `plan_rebuild_status_write_ms`.
    const publishStart = Date.now();
    this.deps.publishPelsStatus(computation.status);
    this.lastPelsStatusWrittenJson = computation.statusJson;
    this.lastWrittenPublishFacts = facts;
    this.lastPelsStatusWriteMs = now;
    incPerfCounter('plan_status_published');
    incPerfCounter(`plan_status_published_reason.${reason}_total`);
    return Date.now() - publishStart;
  }

  private notifyPriceLevelChanged(priceLevel: PriceLevel): void {
    if (priceLevel === this.lastNotifiedPriceLevel) return;

    const card = this.deps.homey.flow?.getTriggerCard?.('price_level_changed');
    if (card) {
      card
        .trigger({ level: priceLevel }, { priceLevel })
        .catch((err: Error) => this.deps.structuredLog.error({
          event: 'price_level_trigger_failed',
          error: err.message,
          stack: err.stack,
        }));
    }
  }
}
