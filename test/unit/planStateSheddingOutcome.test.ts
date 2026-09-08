import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { NO_SHEDDING_OUTCOME, type ShedPlanLatch } from '../../lib/plan/planState';

const T = 1_000_000;
const latch: ShedPlanLatch = { powerW: 4_351, shedIds: new Set(['vvb']), atMs: T, neededKw: 1.8 };

// The shedding pass reports what it did; the state turns that into the clocks
// the next cycle reads. Each kind's mapping is pinned here because nothing
// downstream of the pass asserts the clocks any more.
describe('PlanEngineState.applySheddingOutcome', () => {
  const stateInIncident = () => {
    const state = createPlanEngineState(T - 120_000);
    state.overshoot.enter(T - 60_000);
    return state;
  };

  it('stamps both incident clocks when an escalation found no candidate, so the cadence holds', () => {
    const state = stateInIncident();
    state.applySheddingOutcome({ kind: 'escalation_blocked', atMs: T }, null);

    expect(state.overshoot.shouldEscalate(T + 10_000)).toBe(false);
    expect(state.overshoot.shouldEscalate(T + 30_000)).toBe(true);
    expect(state.restoreBackoff.lastInstabilityMs).toBeNull();
    expect(state.shedPlanLatch).toBeNull();
  });

  it('records a shed: instability, the sample acted on, the latch, and the mitigation clock', () => {
    const state = stateInIncident();
    state.applySheddingOutcome(
      { kind: 'shed', atMs: T, measurementTs: T - 500, latch, escalatedSameSample: false },
      null,
    );

    expect(state.restoreBackoff.lastInstabilityMs).toBe(T);
    expect(state.lastShedPlanMeasurementTs).toBe(T - 500);
    expect(state.shedPlanLatch).toBe(latch);
    expect(state.overshoot.shouldEscalate(T + 10_000)).toBe(false);
    expect(state.overshoot.shouldEscalate(T + 30_000)).toBe(true);
  });

  it('keeps the previous sample stamp and latch when a shed carried neither', () => {
    const state = stateInIncident();
    state.lastShedPlanMeasurementTs = T - 5_000;
    state.shedPlanLatch = latch;
    state.applySheddingOutcome(
      { kind: 'shed', atMs: T, measurementTs: null, latch: null, escalatedSameSample: true },
      null,
    );

    expect(state.lastShedPlanMeasurementTs).toBe(T - 5_000);
    expect(state.shedPlanLatch).toBe(latch);
    expect(state.overshoot.shouldEscalate(T + 10_000)).toBe(false);
  });

  it('leaves every clock alone on a quiet cycle', () => {
    const state = stateInIncident();
    state.applySheddingOutcome(NO_SHEDDING_OUTCOME, null);

    expect(state.restoreBackoff.lastInstabilityMs).toBeNull();
    expect(state.lastShedPlanMeasurementTs).toBeNull();
    expect(state.shedPlanLatch).toBeNull();
    // Only the incident's own start gates escalation: 60 s in, it is due.
    expect(state.overshoot.shouldEscalate(T)).toBe(true);
  });

  it('records a recovery independently of what the pass did', () => {
    const state = stateInIncident();
    state.applySheddingOutcome(NO_SHEDDING_OUTCOME, T);
    expect(state.restoreBackoff.lastRecoveryMs).toBe(T);

    state.applySheddingOutcome({ kind: 'escalation_blocked', atMs: T + 1 }, T + 2);
    expect(state.restoreBackoff.lastRecoveryMs).toBe(T + 2);
  });

  it('shares one immutable quiet outcome', () => {
    expect(Object.isFrozen(NO_SHEDDING_OUTCOME)).toBe(true);
  });
});
