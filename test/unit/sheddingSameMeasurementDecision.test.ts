import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { resolveSameMeasurementSheddingDecision } from '../../lib/plan/shedding/overshoot';

const NOW = 1_000_000;
const SAMPLE_TS = NOW - 1_000;
const READING_W = 4_351;
const NEEDED_KW = 1.813;

// A state that has already shed once: same-sample latch, the watts that shed was
// decided on, and an overshoot that started long enough ago for the same-sample
// escalation interval to be the only thing gating a second pass.
const shedState = (overrides: {
  lastShedPlanMeasurementTs?: number | null;
  lastShedPlanPowerW?: number | null;
  lastShedPlanAtMs?: number | null;
  lastShedPlanNeededKw?: number | null;
  overshootMitigatedAtMs?: number | null;
  overshootStartedMs?: number | null;
} = {}) => {
  const state = createPlanEngineState(NOW);
  state.lastShedPlanMeasurementTs = overrides.lastShedPlanMeasurementTs === undefined
    ? SAMPLE_TS
    : overrides.lastShedPlanMeasurementTs;
  state.lastShedPlanPowerW = overrides.lastShedPlanPowerW === undefined
    ? READING_W
    : overrides.lastShedPlanPowerW;
  state.lastShedPlanAtMs = overrides.lastShedPlanAtMs === undefined
    ? NOW - 10_000
    : overrides.lastShedPlanAtMs;
  state.lastShedPlanNeededKw = overrides.lastShedPlanNeededKw === undefined
    ? NEEDED_KW
    : overrides.lastShedPlanNeededKw;
  const startedMs = overrides.overshootStartedMs === undefined ? NOW - 120_000 : overrides.overshootStartedMs;
  const mitigatedAtMs = overrides.overshootMitigatedAtMs === undefined
    ? NOW - 10_000
    : overrides.overshootMitigatedAtMs;
  // Entering resets the mitigation clock, so the incident opens first and is
  // then stamped; a null start is an incident that never opened.
  if (startedMs !== null) state.overshoot.enter(startedMs);
  if (mitigatedAtMs !== null) state.overshoot.noteMitigation(mitigatedAtMs);
  return state;
};

describe('resolveSameMeasurementSheddingDecision', () => {
  it('proceeds on a new sample carrying a new reading', () => {
    const decision = resolveSameMeasurementSheddingDecision(
      shedState(),
      NOW,
      3_270,
      NEEDED_KW,
      NOW,
      true,
    );

    expect(decision).toEqual({
      skip: false,
      escalatedSameSample: false,
      heldOnUnchangedReading: false,
    });
  });

  it('holds a new sample that repeats the reading the last shed was decided on', () => {
    const decision = resolveSameMeasurementSheddingDecision(
      shedState(),
      NOW,
      READING_W,
      NEEDED_KW,
      NOW,
      true,
    );

    expect(decision).toEqual({
      skip: true,
      escalatedSameSample: false,
      heldOnUnchangedReading: true,
    });
  });

  it('releases the unchanged-reading hold once the window elapses', () => {
    const decision = resolveSameMeasurementSheddingDecision(
      shedState({ lastShedPlanAtMs: NOW - 30_000 }),
      NOW,
      READING_W,
      NEEDED_KW,
      NOW,
      true,
    );

    expect(decision.skip).toBe(false);
    expect(decision.heldOnUnchangedReading).toBe(false);
  });

  it('releases when the same watts now sit under a tighter limit', () => {
    // Hour rollover recomputing the soft limit grows the deficit. The reading is
    // unchanged, but the question it has to answer is not.
    const decision = resolveSameMeasurementSheddingDecision(
      shedState(),
      NOW,
      READING_W,
      NEEDED_KW + 0.7,
      NOW,
      true,
    );

    expect(decision.skip).toBe(false);
    expect(decision.heldOnUnchangedReading).toBe(false);
  });

  it('still holds when the deficit shrinks or only drifts', () => {
    const decision = resolveSameMeasurementSheddingDecision(
      shedState(),
      NOW,
      READING_W,
      NEEDED_KW + 0.0005,
      NOW,
      true,
    );

    expect(decision.skip).toBe(true);
    expect(decision.heldOnUnchangedReading).toBe(true);
  });

  it('treats a one-watt move as a real observation and does not hold', () => {
    const decision = resolveSameMeasurementSheddingDecision(
      shedState(),
      NOW,
      READING_W - 1,
      NEEDED_KW,
      NOW,
      true,
    );

    expect(decision.skip).toBe(false);
    expect(decision.heldOnUnchangedReading).toBe(false);
  });

  it('does not hold when the shed stamp is in the future after a clock correction', () => {
    const decision = resolveSameMeasurementSheddingDecision(
      shedState({ lastShedPlanAtMs: NOW + 60_000 }),
      NOW,
      READING_W,
      NEEDED_KW,
      NOW,
      true,
    );

    expect(decision.skip).toBe(false);
  });

  it('does not hold when the tracker carries no usable reading', () => {
    const decision = resolveSameMeasurementSheddingDecision(
      shedState(),
      NOW,
      null,
      NEEDED_KW,
      NOW,
      true,
    );

    expect(decision.skip).toBe(false);
  });

  it('does not hold before any shed has latched a reading', () => {
    const decision = resolveSameMeasurementSheddingDecision(
      shedState({ lastShedPlanPowerW: null }),
      NOW,
      READING_W,
      NEEDED_KW,
      NOW,
      true,
    );

    expect(decision.skip).toBe(false);
  });

  it('does not hold the first shed of a fresh overshoot once the earlier latch is cleared', () => {
    // `planBuilderOvershoot` drops the whole latch when an overshoot ENDS
    // (`clearShedPlanLatch`), so a value latched in one incident cannot delay
    // the next incident's first pass.
    const decision = resolveSameMeasurementSheddingDecision(
      shedState({ lastShedPlanAtMs: null }),
      NOW,
      READING_W,
      NEEDED_KW,
      NOW,
      true,
    );

    expect(decision.skip).toBe(false);
  });

  describe('same-sample behaviour is unchanged', () => {
    it('skips a re-shed on the very sample the last shed was planned from', () => {
      const decision = resolveSameMeasurementSheddingDecision(
      shedState({ overshootMitigatedAtMs: NOW - 1_000 }),
      SAMPLE_TS,
      READING_W,
      NEEDED_KW,
      NOW,
      true,
    );

      expect(decision).toEqual({
        skip: true,
        escalatedSameSample: false,
        heldOnUnchangedReading: false,
      });
    });

    it('escalates on the same sample once the escalation interval has passed', () => {
      const decision = resolveSameMeasurementSheddingDecision(
      shedState({ overshootMitigatedAtMs: NOW - 30_000 }),
      SAMPLE_TS,
      READING_W,
      NEEDED_KW,
      NOW,
      true,
    );

      expect(decision).toEqual({
        skip: false,
        escalatedSameSample: true,
        heldOnUnchangedReading: false,
      });
    });

    it('never escalates the same sample when escalation is not allowed', () => {
      const decision = resolveSameMeasurementSheddingDecision(
      shedState({ overshootMitigatedAtMs: NOW - 30_000 }),
      SAMPLE_TS,
      READING_W,
      NEEDED_KW,
      NOW,
      false,
    );

      expect(decision).toEqual({
        skip: true,
        escalatedSameSample: false,
        heldOnUnchangedReading: false,
      });
    });
  });
});
