import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEvResumeReachability } from '../../lib/executor/evResumeReachability';

const RESUME = {
  deviceId: 'charger-1',
  capabilityId: 'evcharger_charging' as const,
  desired: true,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('EV resume reachability', () => {
  it('backs off a rejected start and retries after 15 minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const requestRebuild = vi.fn();
    const scheduleRebuild = vi.fn();
    const probe = createEvResumeReachability({
      requestRebuild,
      scheduleRebuild,
      clearScheduledRebuild: vi.fn(),
    });
    const project = () => probe.project({
      deviceId: 'charger-1',
      eligibleForStartProbe: true,
      activityObserved: false,
      available: true,
      base: true,
    });

    expect(project()).toBe(true);
    probe.lifecycle.onDispatchFailed?.(RESUME);
    expect(project()).toBe(false);
    expect(requestRebuild).toHaveBeenCalledOnce();
    expect(scheduleRebuild).toHaveBeenCalledWith('charger-1', 1_000 + 15 * 60 * 1000);

    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(project()).toBe(true);
  });

  it('clears accumulated failures on a new plug edge or availability recovery', () => {
    vi.useFakeTimers();
    const probe = createEvResumeReachability({
      requestRebuild: vi.fn(),
      scheduleRebuild: vi.fn(),
      clearScheduledRebuild: vi.fn(),
    });
    const project = (eligibleForStartProbe: boolean, available = true) => probe.project({
      deviceId: 'charger-1',
      eligibleForStartProbe,
      activityObserved: false,
      available,
      base: eligibleForStartProbe && available,
    });

    project(true);
    probe.lifecycle.onTimedOut?.(RESUME);
    expect(project(true)).toBe(false);
    project(false);
    expect(project(true)).toBe(true);

    probe.lifecycle.onDispatchFailed?.(RESUME);
    project(true, false);
    expect(project(true, true)).toBe(true);
  });

  it('ignores declined writes that were never requested', () => {
    const requestRebuild = vi.fn();
    const scheduleRebuild = vi.fn();
    const clearScheduledRebuild = vi.fn();
    const probe = createEvResumeReachability({
      requestRebuild,
      scheduleRebuild,
      clearScheduledRebuild,
    });
    expect(probe.project({
      deviceId: 'charger-1',
      eligibleForStartProbe: true,
      activityObserved: false,
      base: true,
    })).toBe(true);
    expect(requestRebuild).not.toHaveBeenCalled();
    probe.lifecycle.onDispatchAccepted?.(RESUME);
    expect(scheduleRebuild).toHaveBeenCalledWith('charger-1', expect.any(Number));
    probe.lifecycle.onConfirmed?.(RESUME);
    expect(clearScheduledRebuild).toHaveBeenCalledWith('charger-1');
  });

  it('disposes owned settlement and retry timers even after pruning', () => {
    const clearScheduledRebuild = vi.fn();
    const probe = createEvResumeReachability({
      requestRebuild: vi.fn(),
      scheduleRebuild: vi.fn(),
      clearScheduledRebuild,
    });

    probe.lifecycle.onDispatchAccepted?.(RESUME);
    probe.prune(new Set());
    probe.lifecycle.onDispatchFailed?.({ ...RESUME, deviceId: 'charger-2' });
    probe.dispose();

    expect(clearScheduledRebuild).toHaveBeenCalledWith('charger-1');
    expect(clearScheduledRebuild).toHaveBeenCalledWith('charger-2');
    expect(clearScheduledRebuild).toHaveBeenCalledTimes(2);
  });

  it('fences lifecycle work that completes after disposal', () => {
    const requestRebuild = vi.fn();
    const scheduleRebuild = vi.fn();
    const probe = createEvResumeReachability({
      requestRebuild,
      scheduleRebuild,
      clearScheduledRebuild: vi.fn(),
    });

    probe.dispose();
    probe.lifecycle.onDispatchAccepted?.(RESUME);
    probe.lifecycle.onDispatchFailed?.(RESUME);
    probe.lifecycle.onTimedOut?.(RESUME);

    expect(scheduleRebuild).not.toHaveBeenCalled();
    expect(requestRebuild).not.toHaveBeenCalled();
  });

  it('anchors settlement to dispatch start rather than actuator completion', () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    const scheduleRebuild = vi.fn();
    const probe = createEvResumeReachability({
      requestRebuild: vi.fn(),
      scheduleRebuild,
      clearScheduledRebuild: vi.fn(),
    });

    probe.lifecycle.onDispatchAccepted?.({ ...RESUME, startedAtMs: 10_000 });

    expect(scheduleRebuild).toHaveBeenCalledWith('charger-1', 100_000);
  });

  it('uses 15, 30, then capped 60 minute retry intervals', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const scheduleRebuild = vi.fn();
    const probe = createEvResumeReachability({
      requestRebuild: vi.fn(),
      scheduleRebuild,
      clearScheduledRebuild: vi.fn(),
    });
    probe.project({
      deviceId: 'charger-1',
      eligibleForStartProbe: true,
      activityObserved: false,
      base: true,
    });

    for (const minutes of [15, 30, 60, 60]) {
      const nowMs = Date.now();
      probe.lifecycle.onTimedOut?.(RESUME);
      expect(scheduleRebuild).toHaveBeenLastCalledWith(
        'charger-1',
        nowMs + minutes * 60 * 1000,
      );
      vi.advanceTimersByTime(minutes * 60 * 1000);
    }
  });
});
