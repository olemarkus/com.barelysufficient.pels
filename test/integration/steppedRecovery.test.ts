import { recordActivationAttemptStart } from '../../lib/plan/admission';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { planBuilderWiring } from '../helpers/planBuilderWiring';
import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { withCapacityPace } from '../helpers/capacityPaceFixture';
import type { DevicePlanDevice, MeteredDevicePlanDevice } from '../../lib/plan/planTypes';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { PlanEngineState } from '../utils/planEngineStateFixture';
import { isOffSteppedRestoreCandidate } from '../../lib/plan/restore/devices';
import { partialDouble } from '../helpers/partialDouble';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { buildPlanCycle } from '../utils/planContextPowerFixture';
import { applyRestorePlanForSpec, buildPlanInputDevice, steppedPlanDevice } from '../utils/planTestUtils';
import { testLogger } from '../utils/testLogger';

const steppedLoad = (isEvCharger: boolean, overrides: Parameters<typeof steppedPlanDevice>[0] = {}) => steppedPlanDevice({
  id: 'load', name: 'Load', isEvCharger,
  currentState: 'on', selectedStepId: 'low', desiredStepId: 'low', currentDrawKw: 1.25,
  ...(isEvCharger ? {
    evChargingState: overrides.currentState === 'off' ? 'plugged_in_paused' : 'plugged_in_charging',
  } : {}),
  ...overrides,
});

function plan(state: PlanEngineState, devices: MeteredDevicePlanDevice[], headroomKw = 5, sheddingActive = false) {
  const history = state.shedDecisions;
  history.lastPlannedDeviceIds = new Set(devices.map(({ id }) => id));
  history.lastPlannedKeptIds = new Set(devices.filter((dev) => !isOffSteppedRestoreCandidate(dev)).map(({ id }) => id));
  history.lastPlannedShedIds = new Set(devices.filter(isOffSteppedRestoreCandidate).map(({ id }) => id));
  const total = devices.reduce((sum, dev) => sum + dev.currentDrawKw, 0);
  return applyRestorePlanForSpec({
    planDevices: devices,
    ...buildPlanCycle({
      total, softLimit: total + headroomKw, capacitySoftLimit: total + headroomKw,
      headroomRaw: headroomKw, headroom: headroomKw, budgetKWh: 10, minutesRemaining: 30,
    }),
    state, sheddingActive,
    deps: {
      structuredLog: testLogger,
      powerTracker: partialDouble<PowerTrackerState>({ lastTimestamp: Date.now() }),
      temperatureSetpoints: new Map(), getShedBehavior: () => ({ action: 'turn_off' }),
    },
  });
}

function loadIn(devices: DevicePlanDevice[]) {
  const device = devices.find(({ id }) => id === 'load');
  if (!device) throw new Error('Missing load');
  return device;
}

describe.each([false, true])('shared stepped recovery, EV=%s', (isEvCharger) => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('recovers on the first irregular meter cycle after the common post-pressure wait', () => {
    const state = createPlanEngineState();
    const reducedAt = Date.now();
    state.actuation.markShed('load', reducedAt);
    state.restoreBackoff.noteInstability(reducedAt);
    // Relief has arrived, but pressure did not clear until this later sample.
    vi.advanceTimersByTime(23_000);
    state.restoreBackoff.noteRecovery(Date.now());
    for (const sinceReduction of [37_000, 82_000]) {
      vi.setSystemTime(reducedAt + sinceReduction);
      expect(loadIn(plan(state, [steppedLoad(isEvCharger)]).planDevices).desiredStepId).toBe('low');
    }
    vi.setSystemTime(reducedAt + 91_000);
    expect(loadIn(plan(state, [steppedLoad(isEvCharger)]).planDevices)).toMatchObject({
      desiredStepId: 'max', reason: { code: 'restore_need' },
    });
  });

  it('keeps existing restrictions while pressure remains, even after the timers expire', () => {
    const state = createPlanEngineState();
    state.actuation.markShed('load', Date.now());
    state.restoreBackoff.noteInstability(Date.now());
    vi.advanceTimersByTime(301_000);
    for (const headroom of [-0.1, 0.2, 0.39]) {
      expect(loadIn(plan(state, [steppedLoad(isEvCharger)], headroom, true).planDevices).desiredStepId).toBe('low');
    }
  });

  it('requires the shared recent-shed margin rather than raising into marginal headroom', () => {
    const state = createPlanEngineState();
    state.actuation.markShed('load', Date.now());
    state.restoreBackoff.noteInstability(Date.now());
    vi.advanceTimersByTime(61_000);
    const device = steppedLoad(isEvCharger, {
      selectedStepId: 'low', desiredStepId: 'low', currentDrawKw: 1,
      steppedLoadProfile: { steps: [
        { id: 'off', planningPowerW: 0 }, { id: 'low', planningPowerW: 1000 },
        { id: 'max', planningPowerW: 2000 },
      ] },
    });
    // A normal increase needs 1 + 0.2 kW; a recent reduction needs 1.38 kW.
    expect(loadIn(plan(state, [device], 1.3).planDevices)).toMatchObject({
      desiredStepId: 'low', reason: { code: 'insufficient_headroom' },
    });
    expect(loadIn(plan(state, [device], 1.4).planDevices).desiredStepId).toBe('max');
  });

  it('restarts the common stability wait when pressure returns', () => {
    const state = createPlanEngineState();
    const startedAt = Date.now();
    state.actuation.markShed('load', startedAt);
    state.restoreBackoff.noteInstability(startedAt);
    vi.advanceTimersByTime(40_000);
    state.restoreBackoff.noteRecovery(Date.now());
    vi.advanceTimersByTime(40_000);
    state.actuation.markShed('load', Date.now());
    state.restoreBackoff.noteInstability(Date.now());
    vi.advanceTimersByTime(30_000);
    state.restoreBackoff.noteRecovery(Date.now());
    vi.advanceTimersByTime(59_000);
    expect(loadIn(plan(state, [steppedLoad(isEvCharger)]).planDevices).desiredStepId).toBe('low');
    vi.advanceTimersByTime(11_000);
    expect(loadIn(plan(state, [steppedLoad(isEvCharger)]).planDevices).desiredStepId).toBe('max');
  });

  it('keeps shared post-increase pacing when power evidence has not arrived', () => {
    const state = createPlanEngineState();
    state.actuation.markShed('load', Date.now() - 90_000);
    state.restoreBackoff.noteInstability(Date.now() - 90_000);
    state.actuation.markRestore('other', Date.now());
    vi.advanceTimersByTime(299_999);
    expect(loadIn(plan(state, [steppedLoad(isEvCharger)]).planDevices).desiredStepId).toBe('low');
    vi.advanceTimersByTime(1);
    expect(loadIn(plan(state, [steppedLoad(isEvCharger)]).planDevices).desiredStepId).toBe('max');
  });

  it('does not let boost bypass the common post-pressure wait', () => {
    const state = createPlanEngineState();
    state.actuation.markShed('load', Date.now());
    state.restoreBackoff.noteInstability(Date.now());
    vi.advanceTimersByTime(59_000);
    expect(loadIn(plan(state, [steppedLoad(isEvCharger, { boostActive: true })]).planDevices)).toMatchObject({
      desiredStepId: 'low', reason: { code: 'cooldown_shedding' },
    });
  });

  it('activates an off load at its floor through the same recovery gate', () => {
    const state = createPlanEngineState();
    state.actuation.markShed('load', Date.now());
    state.restoreBackoff.noteInstability(Date.now());
    const device = steppedLoad(isEvCharger, {
      currentState: 'off', selectedStepId: 'off', desiredStepId: 'off', currentDrawKw: 0,
    });
    vi.advanceTimersByTime(59_000);
    expect(loadIn(plan(state, [device]).planDevices).plannedState).toBe('shed');
    vi.advanceTimersByTime(2_000);
    expect(loadIn(plan(state, [device]).planDevices)).toMatchObject({
      plannedState: 'keep', desiredStepId: 'low', reason: { code: 'restore_need' },
    });
  });
});

type LoadKind = 'binary' | 'stepped' | 'ev';

function recoveryTimeline(kind: LoadKind) {
  const state = createPlanEngineState();
  const startedAt = Date.now();
  state.shedDecisions.lastPlannedDeviceIds = new Set(['load']);
  if (kind === 'binary') state.shedDecisions.lastPlannedShedIds = new Set(['load']);
  else state.shedDecisions.lastPlannedKeptIds = new Set(['load']);
  const settings = {
    capacityEnabled: true, gridImportLimitKw: null, limitKw: 5, marginKw: 0, periodMinutes: 60 as const,
  };
  let headroom = 4;
  const builder = new PlanBuilder({
    ...planBuilderWiring(), capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
    getCapacitySettings: () => settings,
    getShedBehavior: () => ({ action: kind === 'binary' ? 'turn_off' : 'set_step' }),
    getPowerTracker: () => withCapacityPace({
      lastTimestamp: Date.now(), lastPowerW: (5 - headroom) * 1000,
    }, settings, 5),
  }, state);

  async function sample(elapsedMs: number, availableKw: number, atMax = false) {
    vi.setSystemTime(startedAt + elapsedMs);
    headroom = availableKw;
    const reducedDrawKw = kind === 'binary' ? 0 : 1;
    const device = buildPlanInputDevice({
      id: 'load', name: 'Load', deviceType: 'onoff', priority: 1,
      binaryCapabilityId: 'onoff', binaryControl: { on: atMax || kind !== 'binary' },
      currentDrawKw: atMax ? 3 : reducedDrawKw, expectedPowerKw: 3,
      ...(kind === 'binary' ? {} : {
        selectedStepId: atMax ? 'max' : 'low', desiredStepId: atMax ? 'max' : 'low',
        shedBehavior: { action: 'set_step' as const },
        steppedLoadProfile: { steps: [
          { id: 'off', planningPowerW: 0 }, { id: 'low', planningPowerW: 1000 },
          { id: 'max', planningPowerW: 3000 },
        ] },
      }),
      ...(kind === 'ev' ? { isEvCharger: true, evChargingState: 'plugged_in_charging' } : {}),
    });
    return loadIn((await builder.buildDevicePlanSnapshot([device])).devices);
  }
  function expectHeld(device: DevicePlanDevice) {
    if (kind === 'binary') expect(device.plannedState).toBe('shed');
    else expect(device.desiredStepId).toBe('low');
  }
  function expectRecovered(device: DevicePlanDevice) {
    expect(device.plannedState).toBe('keep');
    if (kind !== 'binary') expect(device.desiredStepId).toBe('max');
  }
  return { state, sample, expectHeld, expectRecovered };
}

// Exercise the real latch and attribution producers, not just injected timer states.
describe.each(['binary', 'stepped', 'ev'] as const)('pressure recovery through PlanBuilder: %s', (kind) => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-07T12:20:00Z')); });
  afterEach(() => vi.useRealTimers());

  it('holds through fluctuations and resumes on the first well-funded cycle after recovery', async () => {
    const { state, sample, expectHeld, expectRecovered } = recoveryTimeline(kind);
    state.sheddingActive = true;
    state.actuation.markShed('load', Date.now());
    state.restoreBackoff.noteInstability(Date.now());
    for (const [elapsedMs, availableKw] of [[17_000, 0.2], [43_000, 0.39], [71_000, 0.05], [89_000, 0.3]]) {
      expectHeld(await sample(elapsedMs, availableKw));
      expect(state.sheddingActive).toBe(true);
    }
    expectHeld(await sample(103_000, 4));
    expect(state.sheddingActive).toBe(false);
    expect(state.restoreBackoff.lastRecoveryMs).toBe(Date.now());
    expectHeld(await sample(161_000, 4));
    expectRecovered(await sample(169_000, 4));
  });

  it('backs off a failed increase equally after an attributed overshoot and re-reduction', async () => {
    const { state, sample, expectHeld, expectRecovered } = recoveryTimeline(kind);
    expectRecovered(await sample(0, 4));
    // Model executor feedback for the admitted increase. Attribution and
    // instability below are produced by the real planner from the next sample.
    state.actuation.markRestore('load', Date.now());
    recordActivationAttemptStart(state, 'load', Date.now());
    expectHeld(await sample(20_000, -0.8, true));
    expect(state.activationPenaltyByDevice.load).toMatchObject({ level: 1, lastSetbackMs: Date.now() });
    expect(state.restoreBackoff.lastInstabilityMs).toBe(Date.now());
    state.actuation.markShed('load', Date.now());
    expectHeld(await sample(40_000, 4));
    expect(state.restoreBackoff.restoreCooldownMs).toBe(600_000);
    expectHeld(await sample(201_000, 4)); // Past the removed EV timer, but still unsafe to retry.
    expectHeld(await sample(319_000, 4));
    expectRecovered(await sample(321_000, 4));
  });
});
