import { describe, it, expect, vi } from 'vitest';
import {
  DeferredObjectiveLifecycleEmitter,
  type DeferredObjectiveLifecycleEmitterDeps,
} from '../../lib/objectives/deferredObjectives/lifecycleEmitter';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { DeferredObjectiveSettingsV1 } from '../../lib/objectives/deferredObjectives/settings';
import type { DeferredObjectiveActivePlansV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';
import {
  createDeferredObjectiveStatusBus,
  type DeferredObjectiveStatusSnapshot,
} from '../../lib/objectives/deferredObjectives/statusBus';
import { createDeferredObjectiveHoursRemainingBus } from '../../lib/objectives/deferredObjectives/hoursRemainingBus';
import {
  createDeferredObjectiveHoursRemainingTracker,
} from '../../lib/objectives/deferredObjectives/hoursRemainingCrossings';
import type { ObjectiveDeviceInput } from '../../lib/objectives/types';

const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 0, 1, 17, 0, 0);

// A plugged-in EV the controller can run: stepped profile + fresh, below-target
// SoC so the diagnostic resolves to a real (non-`unknown`) trajectory status
// rather than short-circuiting on missing data.
const buildEvDevice = (overrides: Partial<ObjectiveDeviceInput> = {}): ObjectiveDeviceInput => ({
  id: 'ev-1',
  name: 'Driveway EV',
  deviceClass: 'evcharger',
  evChargingState: 'plugged_in_paused',
  stateOfCharge: { percent: 40, status: 'fresh', observedAtMs: NOW_MS },
  steppedLoadProfile: {
    model: 'stepped_load',
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'on', planningPowerW: 2000 },
    ],
  },
  lastFreshDataMs: NOW_MS,
  ...overrides,
});

const buildEvSettings = (deadlineAtMs: number): DeferredObjectiveSettingsV1 => ({
  version: 1,
  objectivesByDeviceId: {
    'ev-1': {
      enabled: true,
      kind: 'ev_soc',
      enforcement: 'soft',
      targetPercent: 80,
      deadlineAtMs,
    },
  },
});

const buildDeps = (
  overrides: Partial<DeferredObjectiveLifecycleEmitterDeps> = {},
): DeferredObjectiveLifecycleEmitterDeps => ({
  getDeferredObjectiveSettings: () => ({ version: 1, objectivesByDeviceId: {} } as DeferredObjectiveSettingsV1),
  getTimeZone: () => 'UTC',
  getDevices: () => [],
  getPowerTracker: () => ({ lastTimestamp: Date.now() } as PowerTrackerState),
  getDailyBudgetSnapshot: () => null,
  buildPriceHorizon: () => [],
  getPriceOptimizationEnabled: () => false,
  getDeferredObjectiveActivePlans: () => null,
  getHardCapKw: () => 10,
  ...overrides,
});

describe('DeferredObjectiveLifecycleEmitter', () => {
  it('evaluates and forwards each tick to the plan-history recorder', () => {
    const observeDeferredObjectivePlanHistory = vi.fn();
    const emitter = new DeferredObjectiveLifecycleEmitter(buildDeps({
      observeDeferredObjectivePlanHistory,
    }));

    emitter.tick(1_000_000_000_000);

    expect(observeDeferredObjectivePlanHistory).toHaveBeenCalledTimes(1);
    const [diagnostics, nowMs] = observeDeferredObjectivePlanHistory.mock.calls[0]!;
    expect(Array.isArray(diagnostics)).toBe(true);
    expect(nowMs).toBe(1_000_000_000_000);
  });

  it('reads the active-plan snapshot once per tick and forwards that same instance to observe', () => {
    const activePlans: DeferredObjectiveActivePlansV1 = { version: 1, plansByDeviceId: {} };
    const getDeferredObjectiveActivePlans = vi.fn(() => activePlans);
    const observeDeferredObjectivePlanHistory = vi.fn();
    const emitter = new DeferredObjectiveLifecycleEmitter(buildDeps({
      getDeferredObjectiveActivePlans,
      observeDeferredObjectivePlanHistory,
    }));

    emitter.tick(1_000_000_000_000);

    // Exactly one recorder read per tick (shared by the diagnostics build and observe).
    expect(getDeferredObjectiveActivePlans).toHaveBeenCalledTimes(1);
    // The same snapshot instance reaches the observe callback (third positional arg).
    const observedActivePlans = observeDeferredObjectivePlanHistory.mock.calls[0]![2];
    expect(observedActivePlans).toBe(activePlans);
  });

  it('no-ops when no settings provider returns settings', () => {
    const observeDeferredObjectivePlanHistory = vi.fn();
    const emitter = new DeferredObjectiveLifecycleEmitter(buildDeps({
      getDeferredObjectiveSettings: () => undefined,
      observeDeferredObjectivePlanHistory,
    }));

    emitter.tick(Date.now());

    expect(observeDeferredObjectivePlanHistory).not.toHaveBeenCalled();
  });

  it('forwards each tick to the active-plan recorder (the write rides the clock)', () => {
    const observeDeferredObjectiveActivePlans = vi.fn();
    const emitter = new DeferredObjectiveLifecycleEmitter(buildDeps({
      observeDeferredObjectiveActivePlans,
    }));

    emitter.tick(1_000_000_000_000);

    expect(observeDeferredObjectiveActivePlans).toHaveBeenCalledTimes(1);
    const [diagnostics, nowMs] = observeDeferredObjectiveActivePlans.mock.calls[0]!;
    expect(Array.isArray(diagnostics)).toBe(true);
    expect(nowMs).toBe(1_000_000_000_000);
  });

  it('does not write active plans when no settings are returned', () => {
    const observeDeferredObjectiveActivePlans = vi.fn();
    const emitter = new DeferredObjectiveLifecycleEmitter(buildDeps({
      getDeferredObjectiveSettings: () => undefined,
      observeDeferredObjectiveActivePlans,
    }));

    emitter.tick(Date.now());

    expect(observeDeferredObjectiveActivePlans).not.toHaveBeenCalled();
  });

  it('observes plan history before writing the active-plan commitment', () => {
    // The emitter reads the active-plan snapshot ONCE per tick and forwards it to
    // plan-history; the active-plan WRITE then mutates the recorder afterwards.
    // So history runs first and intentionally correlates against the pre-write
    // (previous-tick) commitment — a ≤30 s lag, immaterial for the history record.
    const order: string[] = [];
    const emitter = new DeferredObjectiveLifecycleEmitter(buildDeps({
      observeDeferredObjectiveActivePlans: () => { order.push('active-plan'); },
      observeDeferredObjectivePlanHistory: () => { order.push('history'); },
    }));

    emitter.tick(1_000_000_000_000);

    expect(order).toEqual(['history', 'active-plan']);
  });

  // Emit-side contract (PR-C): the emitter is the clock-driven owner of the
  // status-bus publish, the hours-remaining crossing, and the deadline-passed
  // device disable. These drive the SDK boundary only via the real buses and
  // the wired `onDeadlineReached` hook — no PELS internals are mocked.

  it('on a passed deadline, publishes the status transition AND fires the device disable', () => {
    const statusBus = createDeferredObjectiveStatusBus();
    const published: DeferredObjectiveStatusSnapshot[] = [];
    statusBus.onTransition((snapshot) => published.push(snapshot));
    const onDeadlineReached = vi.fn();

    const emitter = new DeferredObjectiveLifecycleEmitter(buildDeps({
      // Deadline an hour in the past → the device cannot meet it, and the
      // deadline-passed disable must fire.
      getDeferredObjectiveSettings: () => buildEvSettings(NOW_MS - HOUR_MS),
      getDevices: () => [buildEvDevice()],
      getPriceOptimizationEnabled: () => true,
      getDeferredObjectiveStatusBus: () => statusBus,
      onDeadlineReached,
    }));

    emitter.tick(NOW_MS);

    // (b) deadline-passed → device disable through the status bus, with the
    // exact (deviceId, kind, deadlineAtMs, nowMs) the wiring needs to cap off
    // and disarm the task.
    expect(onDeadlineReached).toHaveBeenCalledTimes(1);
    expect(onDeadlineReached).toHaveBeenCalledWith('ev-1', 'ev_soc', NOW_MS - HOUR_MS, NOW_MS);

    // (a) status-transition publish from the implicit `none` baseline. The run
    // is below target with the deadline gone, so it publishes a missed
    // `cannot_meet`.
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      deviceId: 'ev-1',
      kind: 'ev_soc',
      status: 'cannot_meet',
      previousStatus: 'none',
      deadlineMissed: true,
    });
  });

  it('does not fire the device disable while the deadline is still in the future', () => {
    const statusBus = createDeferredObjectiveStatusBus();
    const published: DeferredObjectiveStatusSnapshot[] = [];
    statusBus.onTransition((snapshot) => published.push(snapshot));
    const onDeadlineReached = vi.fn();

    const emitter = new DeferredObjectiveLifecycleEmitter(buildDeps({
      getDeferredObjectiveSettings: () => buildEvSettings(NOW_MS + 3 * HOUR_MS),
      getDevices: () => [buildEvDevice()],
      getPriceOptimizationEnabled: () => true,
      getDeferredObjectiveStatusBus: () => statusBus,
      onDeadlineReached,
    }));

    emitter.tick(NOW_MS);

    // Deadline not yet reached: the disable hook must stay silent even though a
    // status transition still publishes.
    expect(onDeadlineReached).not.toHaveBeenCalled();
    expect(published).toHaveLength(1);
    expect(published[0].deadlineMissed).toBe(false);
  });

  it('publishes an hours-remaining crossing for a future deadline', () => {
    const hoursRemainingBus = createDeferredObjectiveHoursRemainingBus();
    const crossings: { deviceId: string; hoursRemaining: number; previousHoursRemaining: number | null }[] = [];
    hoursRemainingBus.onCrossing((event) => crossings.push(event));
    // Real tracker with no persistence backend (in-memory latch), so the first
    // observation of a freshly-armed deadline counts as a crossing.
    const hoursRemainingTracker = createDeferredObjectiveHoursRemainingTracker();

    const emitter = new DeferredObjectiveLifecycleEmitter(buildDeps({
      getDeferredObjectiveSettings: () => buildEvSettings(NOW_MS + 3 * HOUR_MS),
      getDevices: () => [buildEvDevice()],
      getPriceOptimizationEnabled: () => true,
      getDeferredObjectiveHoursRemainingBus: () => hoursRemainingBus,
      getDeferredObjectiveHoursRemainingTracker: () => hoursRemainingTracker,
    }));

    emitter.tick(NOW_MS);

    expect(crossings).toEqual([
      {
        deviceId: 'ev-1',
        deviceName: 'Driveway EV',
        hoursRemaining: 3,
        previousHoursRemaining: null,
      },
    ]);
  });
});
