import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../lib/logging/logger';
import type { RebuildIntent } from '../../lib/plan/rebuildScheduler/scheduler';
import { SchedulerTelemetryObserver } from '../../lib/plan/rebuildScheduler/telemetryObserver';
import { partialDouble } from '../helpers/partialDouble';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import { testLogger } from '../utils/testLogger';

/**
 * The observer's own emit path: the per-key debug rate limiter, its pruning,
 * and the payload each scheduler callback produces. These used to run through
 * `PelsApp`, reaching a private `schedulerTelemetry` field and stubbing the
 * app's root logger — an app built to reach one component. The observer takes
 * every collaborator it uses, so it is exercised directly.
 */
const buildRig = (overrides: { getNowMs?: () => number } = {}) => {
  const childLogger = { debug: vi.fn(), error: vi.fn() };
  const child = vi.fn().mockReturnValue(childLogger);
  const observer = new SchedulerTelemetryObserver({
    homeId: 'main',
    getStructuredLogger: () => partialDouble<Logger>({ child: child as unknown as Logger['child'] }),
    isDebugTopicEnabled: (topic) => topic === 'plan',
    getNowMs: overrides.getNowMs ?? (() => 0),
    cancelQueuedPowerRebuild: vi.fn(),
  });
  return { observer, child, childLogger };
};

const SIGNAL: RebuildIntent = { kind: 'signal', reason: 'power_delta' };
const HARD_CAP: RebuildIntent = { kind: 'hardCap', reason: 'shortfall' };

let capture: LoggerCapture;
beforeEach(() => { capture = captureLogger('info', ['plan']); });
afterEach(() => { capture.restore(); });
const schedulerEvents = () => capture.events
  .filter((line) => String(line.event).startsWith('plan_rebuild_scheduler_'))
  .map(({ level: _level, time: _time, ...rest }) => rest);

describe('SchedulerTelemetryObserver', () => {
  it('emits rate-limited structured plan rebuild scheduler replacement events', () => {
    const { observer } = buildRig();

    observer.onPendingIntentReplaced(SIGNAL, HARD_CAP);
    observer.onPendingIntentReplaced(SIGNAL, HARD_CAP);

    expect(schedulerEvents()).toHaveLength(1);
    expect(schedulerEvents()).toContainEqual({
      event: 'plan_rebuild_scheduler_intent_replaced',
      homeId: 'main',
      previousKind: 'signal',
      previousReason: 'power_delta',
      nextKind: 'hardCap',
      nextReason: 'shortfall',
      component: 'plan',
      debugTopic: 'plan',
    });
  });

  it('does not rate-limit distinct plan rebuild scheduler replacement keys', () => {
    const { observer } = buildRig();

    observer.onPendingIntentReplaced(SIGNAL, HARD_CAP);
    observer.onPendingIntentReplaced({ kind: 'signal', reason: 'headroom_tight' }, HARD_CAP);

    expect(schedulerEvents()).toHaveLength(2);
    expect(schedulerEvents().at(-1)).toEqual(expect.objectContaining({
      event: 'plan_rebuild_scheduler_intent_replaced',
      previousKind: 'signal',
      previousReason: 'headroom_tight',
      nextKind: 'hardCap',
      nextReason: 'shortfall',
      debugTopic: 'plan',
    }));
  });

  it('emits rate-limited structured plan rebuild scheduler dropped events', () => {
    const { observer } = buildRig();

    observer.onIntentDropped(SIGNAL, HARD_CAP);
    observer.onIntentDropped(SIGNAL, HARD_CAP);

    expect(schedulerEvents()).toHaveLength(1);
    expect(schedulerEvents()).toContainEqual({
      event: 'plan_rebuild_scheduler_intent_dropped',
      homeId: 'main',
      droppedKind: 'signal',
      droppedReason: 'power_delta',
      keptKind: 'hardCap',
      keptReason: 'shortfall',
      component: 'plan',
      debugTopic: 'plan',
    });
  });

  it('prunes stale plan rebuild scheduler rate-limit keys', () => {
    const getNowMs = vi.fn<() => number>().mockReturnValueOnce(0).mockReturnValueOnce(60_000);
    const { observer } = buildRig({ getNowMs });
    const map = observer['lastEmittedAtMsByKey'];

    observer.onIntentDropped(SIGNAL, HARD_CAP);
    expect(map.size).toBe(1);

    observer.onIntentDropped(SIGNAL, HARD_CAP);

    expect(schedulerEvents()).toHaveLength(2);
    expect(map.size).toBe(1);
    expect(map.get('dropped:signal:power_delta:hardCap:shortfall')).toBe(60_000);
  });

  it('releases the rebuild the throttle queued for a cancelled intent', () => {
    const cancelQueuedPowerRebuild = vi.fn();
    const observer = new SchedulerTelemetryObserver({
      homeId: 'main',
      getStructuredLogger: () => testLogger,
      isDebugTopicEnabled: () => false,
      getNowMs: () => 0,
      cancelQueuedPowerRebuild,
    });

    observer.onIntentCancelled(SIGNAL, 'app_uninit');

    expect(cancelQueuedPowerRebuild).toHaveBeenCalledExactlyOnceWith('app_uninit');
  });

  it('names the home on a failed rebuild, so two homes are tellable apart', () => {
    const { observer, childLogger } = buildRig();

    observer.onIntentError(HARD_CAP, new Error('boom'));

    expect(childLogger.error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'plan_rebuild_power_sample_failed',
      homeId: 'main',
      intentKind: 'hardCap',
    }));
  });
});
