import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { resolveSameMeasurementSheddingDecision } from '../../lib/plan/shedding/overshoot';
import type { ShedPlanLatch } from '../../lib/plan/planState';

const NOW = 1_000_000;
const SAMPLE_TS = NOW - 1_000;
const READING_W = 4_351;
const NEEDED_KW = 1.813;

// A state that has already shed once: same-sample latch, the watts that shed was
// decided on, and an overshoot that started long enough ago for the same-sample
// escalation interval to be the only thing gating a second pass.
const shedState = (overrides: {
  lastShedPlanMeasurementTs?: number | null;
  /** Partial fields override the latched shed; `null` is a state with no latch. */
  latch?: Partial<ShedPlanLatch> | null;
  overshootMitigatedAtMs?: number | null;
  overshootStartedMs?: number | null;
} = {}) => {
  const state = createPlanEngineState(NOW);
  state.lastShedPlanMeasurementTs = overrides.lastShedPlanMeasurementTs === undefined
    ? SAMPLE_TS
    : overrides.lastShedPlanMeasurementTs;
  state.shedPlanLatch = overrides.latch === null
    ? null
    : { powerW: READING_W, shedIds: new Set<string>(), atMs: NOW - 10_000, neededKw: NEEDED_KW, ...overrides.latch };
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

    expect(decision).toEqual({ kind: 'proceed', escalatedSameSample: false });
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
      kind: 'hold',
      latch: { powerW: READING_W, shedIds: new Set<string>(), atMs: NOW - 10_000, neededKw: NEEDED_KW },
    });
  });

  it('releases the unchanged-reading hold once the window elapses', () => {
    const decision = resolveSameMeasurementSheddingDecision(
      shedState({ latch: { atMs: NOW - 30_000 } }),
      NOW,
      READING_W,
      NEEDED_KW,
      NOW,
      true,
    );

    expect(decision.kind).toBe('proceed');
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

    expect(decision.kind).toBe('proceed');
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

    expect(decision.kind).toBe('hold');
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

    expect(decision.kind).toBe('proceed');
  });

  it('does not hold when the shed stamp is in the future after a clock correction', () => {
    const decision = resolveSameMeasurementSheddingDecision(
      shedState({ latch: { atMs: NOW + 60_000 } }),
      NOW,
      READING_W,
      NEEDED_KW,
      NOW,
      true,
    );

    expect(decision.kind).toBe('proceed');
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

    expect(decision.kind).toBe('proceed');
  });

  it('does not hold the first shed of a fresh overshoot once the earlier latch is cleared', () => {
    // `planBuilderOvershoot` drops the whole latch when an overshoot ENDS
    // (`clearShedPlanLatch`), so a value latched in one incident cannot delay
    // the next incident's first pass — and before any shed has latched at all
    // there is nothing to hold against either.
    const decision = resolveSameMeasurementSheddingDecision(
      shedState({ latch: null }),
      NOW,
      READING_W,
      NEEDED_KW,
      NOW,
      true,
    );

    expect(decision.kind).toBe('proceed');
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

      expect(decision).toEqual({ kind: 'skip_same_sample' });
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

      expect(decision).toEqual({ kind: 'proceed', escalatedSameSample: true });
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

      expect(decision).toEqual({ kind: 'skip_same_sample' });
    });
  });
});
