import type { Logger as PinoLogger } from 'pino';
import {
  cancelPendingPowerRebuild,
  type PowerSampleRebuildState,
} from '../lib/plan/rebuildScheduler/powerDriven';
import type { RebuildIntent } from '../lib/plan/rebuildScheduler/scheduler';
import { incPerfCounter } from '../lib/utils/perfCounters';
import { normalizeError } from '../lib/utils/errorUtils';
import type { DebugLoggingTopic } from '../packages/shared-domain/src/utils/debugLogging';

const PLAN_REBUILD_SCHEDULER_DEBUG_RATE_LIMIT_MS = 60 * 1000;

export type SchedulerTelemetryObserverDeps = {
  getStructuredLogger: () => PinoLogger | undefined;
  isDebugTopicEnabled: (topic: DebugLoggingTopic) => boolean;
  getNowMs: () => number;
  getPowerSampleRebuildState: () => PowerSampleRebuildState;
  setPowerSampleRebuildState: (state: PowerSampleRebuildState) => void;
};

/**
 * Telemetry observer for `PlanRebuildScheduler` lifecycle callbacks.
 * Owns the per-key debug rate-limiter and the cross-cutting perf counters.
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
        previousKind: previous.kind,
        previousReason: previous.reason,
        nextKind: next.kind,
        nextReason: next.reason,
      },
    );
  };

  readonly onIntentCancelled = (intent: RebuildIntent, reason: string): void => {
    if (intent.kind === 'signal' || intent.kind === 'hardCap') {
      cancelPendingPowerRebuild({
        getState: () => this.deps.getPowerSampleRebuildState(),
        setState: (state) => this.deps.setPowerSampleRebuildState(state),
        reason,
      });
    }
  };

  readonly onIntentError = (intent: RebuildIntent, error: Error): void => {
    const logger = this.deps.getStructuredLogger()?.child({ component: 'plan' });
    if (intent.kind === 'flow') {
      logger?.error({
        event: 'plan_rebuild_flow_failed',
        intentReason: intent.reason,
        err: normalizeError(error),
      });
      return;
    }
    if (intent.kind === 'signal' || intent.kind === 'hardCap') {
      logger?.error({
        event: 'plan_rebuild_power_sample_failed',
        intentKind: intent.kind,
        err: normalizeError(error),
      });
    }
  };

  private emit(key: string, payload: Record<string, unknown>): void {
    const logger = this.deps.getStructuredLogger();
    if (!logger || !this.deps.isDebugTopicEnabled('plan')) return;
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
