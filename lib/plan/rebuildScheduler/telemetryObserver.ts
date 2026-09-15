import type { Logger as PinoLogger } from 'pino';
import type { RebuildIntent } from './scheduler';
import { incPerfCounter } from '../../utils/perfCounters';
import { normalizeError } from '../../utils/errorUtils';
import type { DebugLoggingTopic } from '../../../packages/shared-domain/src/utils/debugLogging';
import type { HomeId } from '../../utils/settingsKeys';

const PLAN_REBUILD_SCHEDULER_DEBUG_RATE_LIMIT_MS = 60 * 1000;

export type SchedulerTelemetryObserverDeps = {
  /**
   * The home this scheduler paces. On every payload because both the main home
   * and every meter area run one: without it two homes' dropped/replaced lines
   * are indistinguishable, and the rate-limiter below is per observer, so each
   * home keeps its own window.
   */
  homeId: HomeId;
  getStructuredLogger: () => PinoLogger | undefined;
  isDebugTopicEnabled: (topic: DebugLoggingTopic) => boolean;
  getNowMs: () => number;
  /** The throttle's `cancel`: a cancelled power intent releases the rebuild queued for it. */
  cancelQueuedPowerRebuild: (reason: string) => void;
};

/**
 * Telemetry observer for `PlanRebuildScheduler` lifecycle callbacks.
 * Owns the per-key debug rate-limiter and the cross-cutting perf counters.
 *
 * Lives with the scheduler it observes. It used to sit in `setup/`, which made
 * its rate-limiter state ownerless — and put a component that names
 * `RebuildIntent` a layer above the module that defines it. `lib/logging` would
 * be the wrong home for the same reason in reverse: logging is a foundation, and
 * this would have it depend on `lib/plan`.
 *
 * Implements all four `onIntent*` / `onPendingIntentReplaced` callbacks the
 * scheduler emits as arrow-function fields, so they can be passed to the
 * scheduler constructor without re-binding.
 */
export class SchedulerTelemetryObserver {
  private readonly lastEmittedAtMsByKey = new Map<string, number>();

  constructor(private readonly deps: SchedulerTelemetryObserverDeps) {}

  readonly onIntentDropped = (dropped: RebuildIntent, kept: RebuildIntent): void => {
    this.emit(
      `dropped:${dropped.kind}:${dropped.reason}:${kept.kind}:${kept.reason}`,
      {
        event: 'plan_rebuild_scheduler_intent_dropped',
        homeId: this.deps.homeId,
        droppedKind: dropped.kind,
        droppedReason: dropped.reason,
        keptKind: kept.kind,
        keptReason: kept.reason,
      },
    );
  };

  readonly onPendingIntentReplaced = (previous: RebuildIntent, next: RebuildIntent): void => {
    if (previous.kind === 'flow' && next.kind === 'flow') {
      incPerfCounter('plan_rebuild_requested.flow_coalesced_total');
      if (previous.reason !== next.reason) {
        incPerfCounter('plan_rebuild_requested.flow_pending_source_replaced_total');
      }
    }
    this.emit(
      `replaced:${previous.kind}:${previous.reason}:${next.kind}:${next.reason}`,
      {
        event: 'plan_rebuild_scheduler_intent_replaced',
        homeId: this.deps.homeId,
        previousKind: previous.kind,
        previousReason: previous.reason,
        nextKind: next.kind,
        nextReason: next.reason,
      },
    );
  };

  readonly onIntentCancelled = (intent: RebuildIntent, reason: string): void => {
    if (intent.kind === 'signal' || intent.kind === 'hardCap') {
      this.deps.cancelQueuedPowerRebuild(reason);
    }
  };

  readonly onIntentError = (intent: RebuildIntent, error: Error): void => {
    const logger = this.deps.getStructuredLogger()?.child({ component: 'plan' });
    if (intent.kind === 'flow') {
      logger?.error({
        event: 'plan_rebuild_flow_failed',
        homeId: this.deps.homeId,
        intentReason: intent.reason,
        err: normalizeError(error),
      });
      return;
    }
    if (intent.kind === 'signal' || intent.kind === 'hardCap') {
      logger?.error({
        event: 'plan_rebuild_power_sample_failed',
        homeId: this.deps.homeId,
        intentKind: intent.kind,
        err: normalizeError(error),
      });
    }
  };

  private emit(key: string, payload: Record<string, unknown>): void {
    // Topic gate first: `getStructuredLogger` allocates a pino child per call
    // for both homes, and the disabled path has no use for one.
    if (!this.deps.isDebugTopicEnabled('plan')) return;
    const logger = this.deps.getStructuredLogger();
    if (!logger) return;
    const nowMs = this.deps.getNowMs();
    for (const [storedKey, lastEmittedAtMs] of this.lastEmittedAtMsByKey) {
      if (nowMs - lastEmittedAtMs >= PLAN_REBUILD_SCHEDULER_DEBUG_RATE_LIMIT_MS) {
        this.lastEmittedAtMsByKey.delete(storedKey);
      }
    }
    const lastEmittedAtMs = this.lastEmittedAtMsByKey.get(key);
    if (
      typeof lastEmittedAtMs === 'number'
      && nowMs - lastEmittedAtMs < PLAN_REBUILD_SCHEDULER_DEBUG_RATE_LIMIT_MS
    ) {
      return;
    }
    this.lastEmittedAtMsByKey.set(key, nowMs);
    logger.child({ component: 'plan' }, { level: 'debug' }).debug({
      ...payload,
      debugTopic: 'plan',
    });
  }
}
