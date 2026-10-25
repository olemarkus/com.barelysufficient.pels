import { describe, expect, it } from 'vitest';
import type { ProjectedObservedDeviceState } from '../../packages/contracts/src/types';
import { ObservedDeviceStateProjection } from '../../lib/observer/observedDeviceStateProjection';
import { buildRestoreTiming, shouldPlanRestores } from '../../lib/plan/restore/timing';
import type { RestoreDeps } from '../../lib/plan/restore/types';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { applyShedTemperatureHold } from '../../lib/plan/planReasons';
import { fixtureLimitedSetpoints } from '../helpers/temperatureSetpointsFixture';
import { applyRestorePlanForSpec, buildPlanDevice, sheddingPlanFixture, steppedPlanDevice } from '../utils/planTestUtils';
import { buildPlanCycle } from '../utils/planContextPowerFixture';
import { testLogger } from '../utils/testLogger';

const reading = (id: string, kw: number, measuredAtMs: number): ProjectedObservedDeviceState => ({
  id, name: id, available: true, targets: [], measuredPowerKw: kw,
  measuredPowerObservedAtMs: measuredAtMs, measuredPowerIsDirectMeasurement: true,
});

function observe(projection: ObservedDeviceStateProjection, value: ProjectedObservedDeviceState, receivedAtMs: number) {
  projection.applyDelta({
    source: 'realtime_capability', deviceId: value.id, observed: value, observedAtMs: receivedAtMs,
    observationSeq: receivedAtMs,
  });
}

// The whole-home reading, holding the value it took at `sinceMs` as of a sample at `atMs`.
const homeReading = (sinceMs: number, atMs = sinceMs): PowerTrackerState => ({
  lastTimestamp: atMs, lastPowerW: 2000,
  heldReading: {
    powerW: 2000, sinceMs, atMs, baseline: { totalW: 0, loadKey: 0 }, contradictedAtMs: null, longHoldEndedAtMs: null,
  },
});

const restoredHeater = (id: string): DevicePlanDevice => buildPlanDevice({ id, expectedPowerKw: 1.5 });

// `first` restored at 1000, idle at 500, drawing 1.5 kW from 2000 (received 2100);
// the home reading changed at 2500.
function poweredRestore() {
  const observer = new ObservedDeviceStateProjection();
  const state = createPlanEngineState(1);
  state.restoreBackoff.clearStartupBlock(1);
  state.actuation.markRestore('first', 1000);
  observe(observer, reading('first', 0, 500), 500);
  observe(observer, reading('first', 1.5, 2000), 2100);
  const deps: RestoreDeps = {
    powerTracker: homeReading(2500, 3000),
    hasStartedDrawingSince: observer.hasStartedDrawingSince.bind(observer),
    getShedBehavior: () => ({ action: 'turn_off' }),
    temperatureSetpoints: new Map(), structuredLog: testLogger,
  };
  const nowTs = 4000;
  return { observer, state, deps, nowTs, devices: [restoredHeater('first')] };
}

describe('observer drawing-start evidence', () => {
  it('starts a run when a live idle reading is followed by an active one', () => {
    const { observer } = poweredRestore();
    expect(observer.hasStartedDrawingSince('first', 1000, 2101, 0.75)).toBe(true);
    expect(observer.hasStartedDrawingSince('first', 1000, 2101, 1.6)).toBe(false);
  });

  it.each([
    ['a rebound below the earlier draw', [1, 0.8, 0.9]],
    ['a rise above the earlier draw', [1, 1.5]],
    ['a rise of exactly the active threshold', [0.1, 0.15]],
  ])('never starts a run for a device that was already drawing: %s', (_label, kws) => {
    const observer = new ObservedDeviceStateProjection();
    kws.forEach((kw, index) => observe(observer, reading('first', kw, 500 + index * 1000), 500 + index * 1000));
    expect(observer.hasStartedDrawingSince('first', 0, 10_000, 0.05)).toBe(false);
  });

  it('counts a start from an idle reading at the active threshold boundary', () => {
    const observer = new ObservedDeviceStateProjection();
    observe(observer, reading('first', 0.049, 500), 500);
    observe(observer, reading('first', 0.05, 1500), 1500);
    expect(observer.hasStartedDrawingSince('first', 0, 10_000, 0.05)).toBe(true);
  });

  it.each([
    [1000, 2101, 0.75, true], [2000, 2101, 0.75, false], [1000, 2100, 0.75, false],
  ])('orders the start after %s and the level before %s', (sinceMs, reachedBeforeMs, minKw, started) => {
    const { observer } = poweredRestore();
    expect(observer.hasStartedDrawingSince('first', sinceMs, reachedBeforeMs, minKw)).toBe(started);
  });

  it('requires the start to be measured as well as received after the restore', () => {
    const observer = new ObservedDeviceStateProjection();
    observe(observer, reading('first', 0, 500), 500);
    observe(observer, reading('first', 1, 900), 2100);
    expect(observer.hasStartedDrawingSince('first', 1000, 10_000, 0.5)).toBe(false);
  });

  it('does not treat the first reading as a start from idle', () => {
    const observer = new ObservedDeviceStateProjection();
    observe(observer, reading('first', 1.5, 2000), 2100);
    expect(observer.hasStartedDrawingSince('first', 1000, 10_000, 0.05)).toBe(false);
  });

  it('rejects a delayed reading measured before the last one, and a repeated measurement time', () => {
    const observer = new ObservedDeviceStateProjection();
    observe(observer, reading('first', 0, 1500), 1500);
    observe(observer, reading('first', 1, 1200), 2100);
    expect(observer.hasStartedDrawingSince('first', 1000, 10_000, 0.5)).toBe(false);
    observe(observer, reading('first', 2, 1200), 2200);
    expect(observer.hasStartedDrawingSince('first', 1000, 10_000, 0.5)).toBe(false);
  });

  it('dates the level by the latest climb, not by fluctuation around it', () => {
    const observer = new ObservedDeviceStateProjection();
    observe(observer, reading('first', 0, 500), 500);
    observe(observer, reading('first', 0.06, 1500), 1500);
    observe(observer, reading('first', 0.9, 2500), 2500);
    observe(observer, reading('first', 0.92, 3500), 3500);
    expect(observer.hasStartedDrawingSince('first', 1000, 1501, 0.5)).toBe(false);
    expect(observer.hasStartedDrawingSince('first', 1000, 2501, 0.5)).toBe(true);
    observe(observer, reading('first', 1.5, 4500), 4500);
    expect(observer.hasStartedDrawingSince('first', 1000, 3501, 0.5)).toBe(false);
    expect(observer.hasStartedDrawingSince('first', 1000, 4501, 0.5)).toBe(true);
  });

  it('keeps the run through duplicates and unrelated updates without re-dating it', () => {
    const { observer } = poweredRestore();
    observe(observer, reading('first', 2, 2500), 2100); // Duplicate sequence is dropped.
    observe(observer, { ...reading('first', 1.5, 2000), name: 'renamed' }, 4000);
    expect(observer.hasStartedDrawingSince('first', 1000, 2101, 0.75)).toBe(true);
    expect(observer.hasStartedDrawingSince('first', 3000, 10_000, 0.75)).toBe(false);
  });

  it.each(['back to idle', 'unavailable', 'interval average'])('withdraws the run when the reading goes %s', (kind) => {
    const { observer } = poweredRestore();
    const value = reading('first', kind === 'back to idle' ? 0 : 1.5, 3000);
    if (kind === 'unavailable') value.available = false;
    if (kind === 'interval average') value.measuredPowerIsDirectMeasurement = false;
    observe(observer, value, 3100);
    expect(observer.hasStartedDrawingSince('first', 1000, 10_000, 0.75)).toBe(false);
  });

  it.each(['unavailable', 'interval average', 'missing timestamp'])(
    'does not start a run from %s', (kind) => {
      const observer = new ObservedDeviceStateProjection();
      observe(observer, reading('first', 0, 500), 500);
      const value = reading('first', 1, 2000);
      if (kind === 'unavailable') value.available = false;
      if (kind === 'interval average') value.measuredPowerIsDirectMeasurement = false;
      if (kind === 'missing timestamp') delete value.measuredPowerObservedAtMs;
      observe(observer, value, 2100);
      expect(observer.hasStartedDrawingSince('first', 1000, 10_000, 0.5)).toBe(false);
    },
  );

  it('accepts refresh evidence and drops it when the device disappears', () => {
    const observer = new ObservedDeviceStateProjection();
    observe(observer, reading('first', 0, 500), 500);
    observer.applyRefresh({ ignoredReadIds: [], entries: [{ observed: reading('first', 1, 2000), observedAtMs: 2100, observationSeq: 2100 }] });
    expect(observer.hasStartedDrawingSince('first', 1000, 10_000, 0.5)).toBe(true);
    observer.applyRefresh({ ignoredReadIds: [], entries: [] });
    expect(observer.hasStartedDrawingSince('first', 1000, 10_000, 0.5)).toBe(false);
  });
});

describe('restore cooldown early release', () => {
  it('releases only once the home reading has changed since the device reached its draw', () => {
    const { state, deps, nowTs, devices } = poweredRestore();
    // A reading that took its value with the device's draw, or before it and repeated since.
    for (const unchanged of [homeReading(2100, 3000), homeReading(900, 3900)]) {
      expect(buildRestoreTiming(state, 8, { ...deps, powerTracker: unchanged }, devices, nowTs).inRestoreCooldown)
        .toBe(true);
    }
    const reset: PowerTrackerState = { lastTimestamp: 3000, lastPowerW: 2000 };
    expect(buildRestoreTiming(state, 8, { ...deps, powerTracker: reset }, devices, nowTs).inRestoreCooldown).toBe(true);
    const timing = buildRestoreTiming(state, 8, deps, devices, nowTs);
    expect(timing.inRestoreCooldown).toBe(false);
    expect(timing.restoreCooldownRemainingSec).toBe(0);
    expect(shouldPlanRestores(false, timing, false)).toBe(true);
    expect(state.actuation.lastDeviceRestoreMs.first).toBe(1000);
  });

  it('keeps the timer until the device reaches half its expected draw', () => {
    const { state, deps, nowTs } = poweredRestore();
    const larger = [buildPlanDevice({ id: 'first', expectedPowerKw: 3.1 })];
    expect(buildRestoreTiming(state, 8, deps, larger, nowTs).inRestoreCooldown).toBe(true);
  });

  it('judges a stepped load against the step it runs at', () => {
    const { state, deps, nowTs } = poweredRestore();
    const atStep = (planningPowerKw: number) => [steppedPlanDevice({ id: 'first', planningPowerKw })];
    expect(buildRestoreTiming(state, 8, deps, atStep(2.9), nowTs).inRestoreCooldown).toBe(false);
    expect(buildRestoreTiming(state, 8, deps, atStep(3.1), nowTs).inRestoreCooldown).toBe(true);
  });

  it('keeps the timer for a restore whose device is not in the plan', () => {
    const { state, deps, nowTs } = poweredRestore();
    expect(buildRestoreTiming(state, 8, deps, [], nowTs).inRestoreCooldown).toBe(true);
  });

  it('keeps the timer for a running device whose draw only rose after its restore', () => {
    const { observer, state, deps, nowTs, devices } = poweredRestore();
    state.actuation.markRestore('running', 1100);
    observe(observer, reading('running', 1, 500), 500);
    observe(observer, reading('running', 2.5, 2000), 2100);
    expect(buildRestoreTiming(state, 8, deps, [...devices, restoredHeater('running')], nowTs).inRestoreCooldown)
      .toBe(true);
  });

  it('waits for every recent restore in a batch', () => {
    const { observer, state, deps, nowTs, devices } = poweredRestore();
    state.actuation.markRestore('second', 1100);
    const batch = [...devices, restoredHeater('second')];
    expect(buildRestoreTiming(state, 8, deps, batch, nowTs).inRestoreCooldown).toBe(true);
    observe(observer, reading('second', 0, 500), 500);
    observe(observer, reading('second', 1, 2000), 2100);
    expect(buildRestoreTiming(state, 8, deps, batch, nowTs).inRestoreCooldown).toBe(false);
  });

  it('requires new evidence after a retry and expires the normal timer without it', () => {
    const { state, deps, nowTs, devices } = poweredRestore();
    state.actuation.markRestore('first', 2500);
    expect(buildRestoreTiming(state, 8, deps, devices, nowTs).inRestoreCooldown).toBe(true);
    expect(buildRestoreTiming(state, 8, deps, devices, 302500).inRestoreCooldown).toBe(false);
  });

  it('ignores expired restores but still requires evidence for the latest one', () => {
    const { observer, state, deps, devices } = poweredRestore();
    const batch = [...devices, restoredHeater('second')];
    state.actuation.lastDeviceRestoreMs = {};
    expect(buildRestoreTiming(state, 8, deps, batch, 4000).inRestoreCooldown).toBe(true);
    state.actuation.markRestore('second', 302000);
    state.actuation.lastDeviceRestoreMs.first = 1000;
    deps.powerTracker = homeReading(302800);
    expect(buildRestoreTiming(state, 8, deps, batch, 303000).inRestoreCooldown).toBe(true);
    observe(observer, reading('second', 0, 301000), 301000);
    observe(observer, reading('second', 1, 302500), 302600);
    expect(buildRestoreTiming(state, 8, deps, batch, 303000).inRestoreCooldown).toBe(false);
  });

  const pendingTarget = {
    desired: 21, startedMs: 1000, lastAttemptMs: 1000, retryCount: 0, nextRetryAtMs: 31000,
    status: 'waiting_confirmation',
  } as const;

  it.each([
    ['an in-flight on/off write on any device', 'in_flight'],
    ['a pending on/off command on any device', 'binary'],
    ['a pending step command on a restored device', 'step'],
    ['a pending target temperature on a restored device', 'target'],
  ] as const)('keeps %s behind the timer', (_label, pending) => {
    const { state, deps, nowTs } = poweredRestore();
    if (pending === 'in_flight') state.actuation.beginRestore('other');
    if (pending === 'target') state.pendingTargetCommands.first = pendingTarget;
    const restored = buildPlanDevice({ id: 'first', expectedPowerKw: 1.5, stepCommandPending: pending === 'step' });
    const other = buildPlanDevice({ id: 'other', binaryCommandPending: pending === 'binary' });
    expect(buildRestoreTiming(state, 8, deps, [restored, other], nowTs).inRestoreCooldown).toBe(true);
  });

  it('lets a device that was not restored keep an unconfirmed step or target without holding the others', () => {
    const { state, deps, nowTs, devices } = poweredRestore();
    state.pendingTargetCommands.other = pendingTarget;
    const other = buildPlanDevice({ id: 'other', stepCommandPending: true });
    expect(buildRestoreTiming(state, 8, deps, [...devices, other], nowTs).inRestoreCooldown).toBe(false);
  });

  it('preserves instability backoff even when every device has evidence', () => {
    const { state, deps, nowTs, devices } = poweredRestore();
    state.restoreBackoff.noteInstability(1500);
    const timing = buildRestoreTiming(state, 8, deps, devices, nowTs);
    expect(timing.restoreCooldownMs).toBe(600000);
    expect(timing.inRestoreCooldown).toBe(true);
    state.restoreBackoff.commitCooldown(timing);
    state.actuation.markRestore('first', 1800);
    expect(buildRestoreTiming(state, 8, deps, devices, nowTs).inRestoreCooldown).toBe(true);
  });

  it('keeps the timer for a restore made before instability that a later restore left at the base window', () => {
    const { observer, state, deps, nowTs, devices } = poweredRestore();
    state.restoreBackoff.noteInstability(1500);
    state.actuation.markRestore('second', 1800);
    observe(observer, reading('second', 0, 1700), 1700);
    observe(observer, reading('second', 1.5, 2000), 2100);
    const batch = [...devices, restoredHeater('second')];
    const timing = buildRestoreTiming(state, 8, deps, batch, nowTs);
    expect(timing.restoreCooldownMs).toBe(300000);
    expect(timing.inRestoreCooldown).toBe(true);
    delete state.actuation.lastDeviceRestoreMs.first;
    expect(buildRestoreTiming(state, 8, deps, batch, nowTs).inRestoreCooldown).toBe(false);
  });

  it('preserves startup, shedding and spent-budget holds', () => {
    const { state, deps, nowTs, devices } = poweredRestore();
    state.restoreBackoff.beginStartupBlock(nowTs - 1000);
    expect(shouldPlanRestores(false, buildRestoreTiming(state, 8, deps, devices, nowTs), false)).toBe(false);
    state.restoreBackoff.clearStartupBlock(nowTs);
    const timing = buildRestoreTiming(state, 8, deps, devices, nowTs);
    expect(shouldPlanRestores(true, timing, false)).toBe(false);
    expect(shouldPlanRestores(false, timing, true)).toBe(false);
  });

  it.each(['binary', 'stepped'])('admits a waiting %s device early only when it fits', (kind) => {
    const { state, deps, nowTs, devices } = poweredRestore();
    const device = kind === 'binary'
      ? buildPlanDevice({ id: 'waiting', currentState: 'off', plannedState: 'keep', currentDrawKw: 0, expectedPowerKw: 1 })
      : steppedPlanDevice({ id: 'waiting', currentState: 'off', selectedStepId: 'off', currentDrawKw: 0 });
    const run = (headroom: number) => applyRestorePlanForSpec({
      planDevices: [...devices, device], state, deps, sheddingActive: false,
      ...buildPlanCycle({ nowTs, headroom, capacitySoftLimit: 10, softLimit: 10 }),
    });
    expect(run(0).restoredOneThisCycle).toBe(false);
    expect(run(8).restoredOneThisCycle).toBe(true);
  });

  it.each([false, true])('temperature restores use the same evidence verdict (%s)', (hasEvidence) => {
    const { state, deps, nowTs, devices } = poweredRestore();
    if (!hasEvidence) deps.powerTracker = homeReading(2000);
    deps.temperatureSetpoints = fixtureLimitedSetpoints({ waiting: 16 });
    deps.getShedBehavior = () => ({ action: 'set_temperature', temperature: 16 });
    const device = buildPlanDevice({
      id: 'waiting', currentState: 'on', plannedState: 'keep', currentDrawKw: 0,
      currentTarget: 16, currentTemperature: 18, plannedTarget: 21,
      expectedPowerKw: 1, shedAction: 'set_temperature',
    });
    const restore = applyRestorePlanForSpec({
      planDevices: [...devices, device], state, deps, sheddingActive: false,
      ...buildPlanCycle({ nowTs, headroom: 8, capacitySoftLimit: 10, softLimit: 10 }),
    });
    const held = applyShedTemperatureHold(state, restore, sheddingPlanFixture(), deps.temperatureSetpoints);
    expect(held.planDevices.find((entry) => entry.id === 'waiting')).toMatchObject({ plannedTarget: hasEvidence ? 21 : 16 });
  });
});
