import { describe, expect, it, vi } from 'vitest';
import {
  createPendingBinaryCommandStore,
  syncPendingBinaryCommands,
} from '../../lib/observer/pendingBinaryCommands';
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../../lib/ports/controlCommandConfirmation';
import { createBinaryCommandReachability } from '../../lib/plan/admission/binaryCommandReachability';
import type { PendingBinaryCommand } from '../../lib/observer/pendingBinaryCommandTypes';
import Homey from 'homey';
import { ObservedStateEmitter } from '../../lib/observer/observedStateEvents';
import type { PlanService } from '../../lib/plan/planService';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import { subscribePlanObservedState } from '../../setup/appInit/planObservedStateSubscription';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import {
  createTestDeviceTransport,
  initWithLiveFeed,
  onObservedState,
  seedTransportDevices,
} from '../helpers/deviceTransportHarness';
import { emitCapability } from '../helpers/liveFeedSocketHarness';
import { mockHomeyInstance } from '../mocks/homey';

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

describe('a discharging home battery on the observation lane', () => {
  // Every accepted battery reading, discharging included, is an observation the
  // lane receives (it advances the observer projection's revision). None of
  // them may pick when the planner runs.
  it('never rebuilds the plan or clears a rebuild suppression for negative readings', async () => {
    const noop = (): void => undefined;
    const logger: Logger = {
      log: noop,
      error: noop,
      structuredLog: { info: noop, error: noop, debug: noop, warn: noop } as unknown as Logger['structuredLog'],
    };
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger, {
      getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' as const }),
      getManaged: () => true,
    });
    const lastUpdated = new Date().toISOString();
    const battery: HomeyDeviceLike = {
      id: 'battery-1',
      name: 'Home Battery',
      class: 'battery',
      capabilities: ['measure_battery', 'measure_power'],
      capabilitiesObj: {
        measure_battery: { id: 'measure_battery', value: 60, lastUpdated },
        measure_power: { id: 'measure_power', value: 1200, lastUpdated },
      },
    };
    await initWithLiveFeed(transport);
    await seedTransportDevices(transport, [battery]);

    const syncLivePlanState = vi.fn().mockResolvedValue(false);
    const rebuildPlanFromCache = vi.fn();
    // The plan answers "this device can move the actionable load", so only the
    // event itself stands between a reading and a suppression clear.
    const ctx = createAppContextMock({
      planService: {
        syncLivePlanState, rebuildPlanFromCache, canDeviceChangeActionableLoad: () => true,
      } as unknown as PlanService,
    });
    const laneEmitter = new ObservedStateEmitter();
    const invalidateRebuildSuppression = vi.fn();
    subscribePlanObservedState({
      ctx,
      syncLivePlanState: (event) => syncLivePlanState(event.source),
      getObservedStateEmitter: () => laneEmitter,
      syncExternalOffHold: vi.fn(),
      invalidateRebuildSuppression,
      getHomeRuntimeRegistry: () => undefined,
    });
    onObservedState(transport, (event) => laneEmitter.emitObservedStateChanged(event));

    for (const watts of [-1500, -1500, -300, 0, -2500]) {
      await emitCapability('battery-1', 'measure_power', watts);
    }

    expect(syncLivePlanState).toHaveBeenCalledTimes(5);
    expect(invalidateRebuildSuppression).not.toHaveBeenCalled();
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();

    // The wiring is live: a battery that starts drawing hard does clear the
    // suppression, as any device would. Still no rebuild.
    await emitCapability('battery-1', 'measure_power', 2500);
    expect(invalidateRebuildSuppression).toHaveBeenCalledWith('battery-1');
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
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
