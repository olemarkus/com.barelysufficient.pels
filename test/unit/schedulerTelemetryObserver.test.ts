import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../lib/logging/logger';
import type { RebuildIntent } from '../../lib/plan/rebuildScheduler/scheduler';
import { SchedulerTelemetryObserver } from '../../lib/plan/rebuildScheduler/telemetryObserver';
import { partialDouble } from '../helpers/partialDouble';

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

describe('SchedulerTelemetryObserver', () => {
  it('emits rate-limited structured plan rebuild scheduler replacement events', () => {
    const { observer, child, childLogger } = buildRig();

    observer.onPendingIntentReplaced(SIGNAL, HARD_CAP);
    observer.onPendingIntentReplaced(SIGNAL, HARD_CAP);

    expect(child).toHaveBeenCalledWith({ component: 'plan' }, { level: 'debug' });
    expect(childLogger.debug).toHaveBeenCalledTimes(1);
    expect(childLogger.debug).toHaveBeenCalledWith({
      event: 'plan_rebuild_scheduler_intent_replaced',
      homeId: 'main',
      previousKind: 'signal',
      previousReason: 'power_delta',
      nextKind: 'hardCap',
      nextReason: 'shortfall',
      debugTopic: 'plan',
    });
  });

  it('does not rate-limit distinct plan rebuild scheduler replacement keys', () => {
    const { observer, childLogger } = buildRig();

    observer.onPendingIntentReplaced(SIGNAL, HARD_CAP);
    observer.onPendingIntentReplaced({ kind: 'signal', reason: 'headroom_tight' }, HARD_CAP);

    expect(childLogger.debug).toHaveBeenCalledTimes(2);
    expect(childLogger.debug).toHaveBeenLastCalledWith(expect.objectContaining({
      event: 'plan_rebuild_scheduler_intent_replaced',
      previousKind: 'signal',
      previousReason: 'headroom_tight',
      nextKind: 'hardCap',
      nextReason: 'shortfall',
      debugTopic: 'plan',
    }));
  });

  it('emits rate-limited structured plan rebuild scheduler dropped events', () => {
    const { observer, childLogger } = buildRig();

    observer.onIntentDropped(SIGNAL, HARD_CAP);
    observer.onIntentDropped(SIGNAL, HARD_CAP);

    expect(childLogger.debug).toHaveBeenCalledTimes(1);
    expect(childLogger.debug).toHaveBeenCalledWith({
      event: 'plan_rebuild_scheduler_intent_dropped',
      homeId: 'main',
      droppedKind: 'signal',
      droppedReason: 'power_delta',
      keptKind: 'hardCap',
      keptReason: 'shortfall',
      debugTopic: 'plan',
    });
  });

  it('prunes stale plan rebuild scheduler rate-limit keys', () => {
    const getNowMs = vi.fn<() => number>().mockReturnValueOnce(0).mockReturnValueOnce(60_000);
    const { observer, childLogger } = buildRig({ getNowMs });
    const map = observer['lastEmittedAtMsByKey'];

    observer.onIntentDropped(SIGNAL, HARD_CAP);
    expect(map.size).toBe(1);

    observer.onIntentDropped(SIGNAL, HARD_CAP);

    expect(childLogger.debug).toHaveBeenCalledTimes(2);
    expect(map.size).toBe(1);
    expect(map.get('dropped:signal:power_delta:hardCap:shortfall')).toBe(60_000);
  });

  it('releases the rebuild the throttle queued for a cancelled intent', () => {
    const cancelQueuedPowerRebuild = vi.fn();
    const observer = new SchedulerTelemetryObserver({
      homeId: 'main',
      getStructuredLogger: () => undefined,
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
