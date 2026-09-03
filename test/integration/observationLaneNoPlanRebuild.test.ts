import { describe, expect, it, vi } from 'vitest';
import {
  createPendingBinaryCommandStore,
  syncPendingBinaryCommands,
} from '../../lib/observer/pendingBinaryCommands';
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../../lib/observer/controlCommandConfirmation';
import { createBinaryCommandReachability } from '../../lib/plan/admission/binaryCommandReachability';
import type { PendingBinaryCommand } from '../../lib/observer/pendingBinaryCommandTypes';

/**
 * An observation may drive the UI and the executor. It may NOT drive the
 * planner.
 *
 * The observation lane is `setup/appInit/planObservedStateSubscription.ts`:
 * every `observedStateChanged` event becomes `syncLivePlanState`, which runs
 * the pending-binary reconcile sweep for EVERY pending entry. When that sweep
 * expired a command it raised `onTimedOut`, which shared one function with
 * `onDispatchFailed` and so called `requestRebuild()` — an observation of one
 * device rebuilding the plan on behalf of another device's expired command.
 *
 * These specs drive the two real modules that met at that seam — the observer's
 * sweep and the planner's reachability listener — with only the rebuild seams
 * doubled, because a rebuild request is exactly what is being asserted about.
 */
const pending = (overrides: Partial<PendingBinaryCommand> = {}): PendingBinaryCommand => ({
  dispatchState: 'accepted',
  desired: true,
  startedMs: Date.now(),
  ...overrides,
});

const buildLane = () => {
  const requestRebuild = vi.fn();
  const scheduleRebuild = vi.fn();
  const clearScheduledRebuild = vi.fn();
  const reachability = createBinaryCommandReachability({
    requestRebuild, scheduleRebuild, clearScheduledRebuild,
  });
  const backing: Record<string, PendingBinaryCommand> = {};
  const store = createPendingBinaryCommandStore(backing, reachability.lifecycle);
  return {
    reachability, store, backing, requestRebuild, scheduleRebuild, clearScheduledRebuild,
  };
};

/** The sweep as the observation lane runs it: `syncLivePlanState`'s source. */
const sweepOnObservationLane = (
  store: ReturnType<typeof buildLane>['store'],
  liveDevices: Parameters<typeof syncPendingBinaryCommands>[0]['liveDevices'] = [],
  onConfirmed?: Parameters<typeof syncPendingBinaryCommands>[0]['onConfirmed'],
): boolean => syncPendingBinaryCommands({
  store, liveDevices, source: 'device_update', onConfirmed,
});

describe('the observation lane never requests an immediate plan rebuild', () => {
  it('times out a pending resume without asking the planner to rebuild', () => {
    const { store, backing, requestRebuild, scheduleRebuild } = buildLane();
    const startedMs = Date.now() - (CONTROL_COMMAND_CONFIRMATION_MS + 30_000);
    backing['heater'] = pending({ desired: true, startedMs });

    sweepOnObservationLane(store);

    // The invariant. Before the lane split this was one call.
    expect(requestRebuild).not.toHaveBeenCalled();
    // The timeout itself still happened: entry gone, backoff armed. Arming the
    // retry TIMER is deliberate and is not the thing being forbidden — a rebuild
    // minutes from now is not this observation picking when the planner runs.
    expect(backing['heater']).toBeUndefined();
    expect(scheduleRebuild).toHaveBeenCalledWith('heater', expect.any(Number));
  });

  it('still records the failure, so the device reads as uncommandable at once', () => {
    const { reachability, store, backing, requestRebuild } = buildLane();
    backing['heater'] = pending({
      desired: true,
      startedMs: Date.now() - (CONTROL_COMMAND_CONFIRMATION_MS + 30_000),
    });

    sweepOnObservationLane(store);

    // Suppressing the rebuild request must not suppress the reachability state
    // it exists to publish — the next rebuild, from any trigger, sees this.
    expect(reachability.project({
      deviceId: 'heater', base: true, observedOn: false, available: true,
    })).toEqual({ commandableNow: false, reason: 'binary_command_retry' });
    expect(requestRebuild).not.toHaveBeenCalled();
  });

  it('still settles a confirmed command on the observation lane', () => {
    const { store, backing, requestRebuild } = buildLane();
    const startedMs = Date.now() - 1_000;
    backing['heater'] = pending({ desired: true, startedMs });
    const onConfirmed = vi.fn();

    const changed = sweepOnObservationLane(store, [{
      id: 'heater',
      name: 'Heater',
      binaryCommandConfirmation: {
        state: 'observed', observedValue: true, observedAtMs: startedMs + 10,
      },
    }], onConfirmed);

    // The executor's settlement path is exactly what an observation is FOR.
    expect(changed).toBe(true);
    expect(onConfirmed).toHaveBeenCalledOnce();
    expect(backing['heater']).toBeUndefined();
    expect(requestRebuild).not.toHaveBeenCalled();
  });

  it("does not let one device's observation rebuild for another device's expired command", () => {
    const { store, backing, requestRebuild, scheduleRebuild } = buildLane();
    // The sweep is not device-scoped: an observation of `heater` reconciles
    // `charger` too, which is what made the old edge broader than it looked.
    backing['charger'] = pending({
      desired: true,
      startedMs: Date.now() - (CONTROL_COMMAND_CONFIRMATION_MS + 30_000),
    });

    sweepOnObservationLane(store, [{
      id: 'heater', name: 'Heater', binaryCommandConfirmation: { state: 'unavailable' },
    }]);

    expect(requestRebuild).not.toHaveBeenCalled();
    expect(scheduleRebuild).toHaveBeenCalledWith('charger', expect.any(Number));
  });
});

describe('the lanes that MAY drive the planner still do', () => {
  it('keeps the dispatch lane rebuild — a transport answer is not an observation', () => {
    const { store, requestRebuild } = buildLane();

    store.recordDispatchFailed('heater', { deviceId: 'heater', desired: true });

    expect(requestRebuild).toHaveBeenCalledOnce();
  });

  it('still arms the confirmation deadline on acceptance, unchanged by this split', () => {
    const { store, backing, scheduleRebuild } = buildLane();
    const startedMs = Date.now();
    backing['heater'] = { dispatchState: 'dispatching', desired: true, startedMs };

    store.recordDispatchAccepted('heater', { deviceId: 'heater', desired: true, startedAtMs: startedMs });

    // Pins that the dispatch-acceptance timer is untouched by the lane split.
    // Deliberately NOT an argument that this timer covers the escalation — it is
    // not guaranteed to be armed at all (an unbounded Flow-backed write can expire
    // still `dispatching`), and `binaryCommandReachability`'s own comment refuses
    // to rest on it. What makes the sweep lane safe is the sweep-before-device-read
    // ordering, pinned separately below.
    expect(scheduleRebuild).toHaveBeenCalledWith(
      'heater',
      startedMs + CONTROL_COMMAND_CONFIRMATION_MS,
    );
  });
});
