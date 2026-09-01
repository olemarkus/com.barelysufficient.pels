import { describe, expect, it, vi } from 'vitest';
import { createBinaryCommandReachability } from '../../lib/plan/admission/binaryCommandReachability';

const buildReachability = () => {
  const requestRebuild = vi.fn();
  const scheduleRebuild = vi.fn();
  const clearScheduledRebuild = vi.fn();
  return {
    reachability: createBinaryCommandReachability({
      requestRebuild,
      scheduleRebuild,
      clearScheduledRebuild,
    }),
    requestRebuild,
    scheduleRebuild,
    clearScheduledRebuild,
  };
};

describe('binary command reachability', () => {
  it('schedules the semantic confirmation deadline for an accepted resume', () => {
    const { reachability, scheduleRebuild } = buildReachability();

    reachability.lifecycle.onDispatchAccepted?.({
      deviceId: 'heater',
      desired: true,
      startedAtMs: 1_000,
    });

    expect(scheduleRebuild).toHaveBeenCalledWith('heater', 91_000);
    expect(reachability.project({ deviceId: 'heater', base: true, observedOn: false, available: true }))
      .toEqual({ commandableNow: true, reason: 'none' });
  });

  it('temporarily makes any failed binary resume uncommandable', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { reachability, requestRebuild, scheduleRebuild } = buildReachability();

    reachability.lifecycle.onDispatchFailed?.({ deviceId: 'heater', desired: true });

    expect(requestRebuild).toHaveBeenCalledOnce();
    expect(scheduleRebuild).toHaveBeenCalledWith('heater', 910_000);
    expect(reachability.project({ deviceId: 'heater', base: true, observedOn: false, available: true }))
      .toEqual({ commandableNow: false, reason: 'binary_command_retry' });
    vi.setSystemTime(910_000);
    expect(reachability.project({ deviceId: 'heater', base: true, observedOn: false, available: true }))
      .toEqual({ commandableNow: true, reason: 'none' });
    vi.useRealTimers();
  });

  it('does not apply resume reachability to turn-off commands', () => {
    const { reachability, requestRebuild, scheduleRebuild } = buildReachability();

    reachability.lifecycle.onDispatchAccepted?.({
      deviceId: 'heater', desired: false, startedAtMs: 1_000,
    });
    reachability.lifecycle.onTimedOut?.({ deviceId: 'heater', desired: false });

    expect(requestRebuild).not.toHaveBeenCalled();
    expect(scheduleRebuild).not.toHaveBeenCalled();
    expect(reachability.project({ deviceId: 'heater', base: true, observedOn: false, available: true }))
      .toEqual({ commandableNow: true, reason: 'none' });
  });

  it('clears resume backoff from late observed on or unavailable-to-available recovery', () => {
    const { reachability } = buildReachability();
    reachability.lifecycle.onTimedOut?.({ deviceId: 'heater', desired: true });
    expect(reachability.project({ deviceId: 'heater', base: true, observedOn: true, available: true }))
      .toEqual({ commandableNow: true, reason: 'none' });

    reachability.lifecycle.onDispatchFailed?.({ deviceId: 'charger', desired: true });
    expect(reachability.project({ deviceId: 'charger', base: false, observedOn: false, available: false }))
      .toEqual({ commandableNow: false, reason: 'none' });
    expect(reachability.project({ deviceId: 'charger', base: true, observedOn: false, available: true }))
      .toEqual({ commandableNow: true, reason: 'none' });
  });

  it('does not clear an on-command backoff from an off confirmation', () => {
    const { reachability } = buildReachability();
    reachability.lifecycle.onTimedOut?.({ deviceId: 'heater', desired: true });
    reachability.lifecycle.onConfirmed?.({ deviceId: 'heater', desired: false });
    expect(reachability.project({ deviceId: 'heater', base: true, observedOn: false, available: true }))
      .toEqual({ commandableNow: false, reason: 'binary_command_retry' });
  });

  it('clears reachability state on confirmation, pruning, and disposal', () => {
    const { reachability, clearScheduledRebuild } = buildReachability();
    reachability.lifecycle.onDispatchFailed?.({ deviceId: 'heater', desired: true });
    reachability.lifecycle.onConfirmed?.({ deviceId: 'heater', desired: true });
    expect(clearScheduledRebuild).toHaveBeenCalledWith('heater');

    reachability.lifecycle.onDispatchFailed?.({ deviceId: 'charger', desired: true });
    reachability.prune(new Set());
    expect(clearScheduledRebuild).toHaveBeenCalledWith('charger');

    reachability.lifecycle.onDispatchFailed?.({ deviceId: 'boiler', desired: true });
    reachability.dispose();
    expect(clearScheduledRebuild).toHaveBeenCalledWith('boiler');
  });
});
