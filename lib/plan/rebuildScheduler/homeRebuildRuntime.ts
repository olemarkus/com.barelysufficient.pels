/**
 * One home's plan-rebuild loop: the throttle that paces power-driven rebuilds,
 * the scheduler that queues every rebuild intent, the policy that decides when
 * a queued intent is due, and the telemetry that reports what the scheduler did
 * with it. Four components that only ever appear together.
 *
 * The main home and every meter area assembled them separately, and the area's
 * assembly was a partial copy of the main home's rather than a different
 * design. It inlined `resolveDueAtMs` as `throttle.dueAtMs(intent, nowMs)` for
 * EVERY intent kind — but the throttle answers `+Infinity` to anything that is
 * not `signal` or `hardCap`, so an area's `flow` intent was queued, deferred by
 * its own `shouldExecuteImmediately`, and then never due. Nothing reaches that
 * today (`requestFlowPlanRebuild` is the one producer and it targets the main
 * scheduler), so this was a trap rather than a live defect: the day flow
 * rebuilds fan out per home, an area would have gone quiet with no error to
 * show for it. It also ran on a different clock and emitted no scheduler
 * telemetry at all.
 *
 * This lives in `lib/plan` and not in the wiring layer because it decides: due
 * times, coalesce windows, and which intent kind the throttle owns are plan
 * policy. `setup/` hands it the home's collaborators and nothing else.
 */
import type CapacityGuard from '../../power/capacityGuard';
import type { DebugLoggingTopic } from '../../../packages/shared-domain/src/utils/debugLogging';
import type { Logger as PinoLogger } from 'pino';
import type { HomeId } from '../../utils/settingsKeys';
import type { TimerRegistry } from '../../utils/timerRegistry';
import type { PlanService } from '../planService';
import {
  getAppPlanRebuildNowMs,
  PlanRebuildIntentPolicy,
} from './intentPolicy';
import { PlanRebuildScheduler } from './scheduler';
import { SchedulerTelemetryObserver } from './telemetryObserver';
import { PlanRebuildThrottle } from './throttle';

export type HomeRebuildRuntime = {
  scheduler: PlanRebuildScheduler;
  throttle: PlanRebuildThrottle;
};

/**
 * `timers` + `timerKey` are this home's slot in the shared registry — identity
 * for the main home, `home:<id>:planRebuild` for a meter area — so a home's
 * teardown clears the scheduler's one timer the same way it clears every other
 * timer it armed. The main home used to leave this timer on a bare `setTimeout`,
 * outside the registry: `cancelAll` still cancelled it, but it was the one plan
 * timer `timers` could not see.
 *
 * `getStructuredLogger` is this home's `plan` logger; the telemetry observer
 * childs `component: 'plan'` on again for its own emit, so a root logger works
 * too, but both homes pass the component logger.
 *
 * `getCapacityGuard` and `getPlanService` are late-bound: this home's guard and
 * service are built around this runtime, not before it.
 */
export const createHomeRebuildRuntime = (
  homeId: HomeId,
  timers: TimerRegistry,
  timerKey: (suffix: string) => string,
  getCapacityGuard: () => CapacityGuard,
  getPlanService: () => PlanService,
  getStructuredLogger: () => PinoLogger | undefined,
  isDebugTopicEnabled: (topic: DebugLoggingTopic) => boolean,
): HomeRebuildRuntime => {
  // One clock for the scheduler, the throttle and the telemetry rate-limiter.
  // They compare their stamps against each other, so a home that read wall time
  // in one and the monotonic clock in another would be comparing two different
  // origins. A meter area used to do exactly that.
  const nowMs = getAppPlanRebuildNowMs;
  const throttle: PlanRebuildThrottle = new PlanRebuildThrottle({
    getScheduler: () => scheduler,
    getCapacityGuard,
    getNowMs: nowMs,
    rebuildPlanFromCache: (trigger) => getPlanService().rebuildPlanFromCache(trigger),
  });
  const intentPolicy = new PlanRebuildIntentPolicy({
    getPlanRebuildThrottle: () => throttle,
    getPlanService,
  });
  const telemetry = new SchedulerTelemetryObserver({
    homeId,
    getStructuredLogger,
    isDebugTopicEnabled,
    getNowMs: nowMs,
    // The observer's `onIntentCancelled` IS the throttle release: a cancelled
    // power intent must let go of the rebuild queued for it, or a sample waits
    // on a promise nothing will settle.
    cancelQueuedPowerRebuild: (reason) => throttle.cancel(reason),
  });
  const scheduler = new PlanRebuildScheduler({
    getNowMs: nowMs,
    resolveDueAtMs: (intent, state) => intentPolicy.resolveDueAtMs(intent, state),
    executeIntent: (intent) => intentPolicy.executeIntent(intent),
    shouldExecuteImmediately: (intent) => intent.kind !== 'flow',
    onIntentDropped: telemetry.onIntentDropped,
    onPendingIntentReplaced: telemetry.onPendingIntentReplaced,
    onIntentCancelled: telemetry.onIntentCancelled,
    onIntentError: telemetry.onIntentError,
    setTimeoutFn: (callback, delayMs) => (
      timers.registerTimeout(timerKey('planRebuild'), setTimeout(callback, delayMs))
    ),
    clearTimeoutFn: () => { timers.clear(timerKey('planRebuild')); },
  });
  return { scheduler, throttle };
};
