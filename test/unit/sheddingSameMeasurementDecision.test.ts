import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { buildPlanInputDevice } from '../utils/planTestUtils';
import { resolveSameMeasurementSheddingDecision } from '../../lib/plan/shedding/overshoot';
import type { ShedPlanLatch } from '../../lib/plan/planState';

const NOW = 1_000_000;
const SAMPLE_TS = NOW - 1_000;
const READING_W = 4_351;

// The 2026-08-01 field case: the water heater was shed for 2 kW and its own
// meter now reads it off, while the whole-home reading has not caught up.
const devices = [
  buildPlanInputDevice({ id: 'vvb', binaryControl: { on: false }, currentDrawKw: 0 }),
];

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
    : {
      powerW: READING_W,
      decisions: new Map([['vvb', [{ decidedAtMs: NOW - 10_000, creditedKw: 2 }]]]),
      stepTargets: new Map(),
      ...overrides.latch,
    };
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

const decidedAt = (decidedAtMs: number): Partial<ShedPlanLatch> => ({
  decisions: new Map([['vvb', [{ decidedAtMs, creditedKw: 2 }]]]),
});

const decide = (state: ReturnType<typeof shedState>, measurementTs: number, powerW: number | null) => (
  resolveSameMeasurementSheddingDecision(state, devices, measurementTs, powerW, NOW, true)
);

describe('resolveSameMeasurementSheddingDecision', () => {
  it('credits a new sample that repeats the reading the last shed was decided on', () => {
    const decision = decide(shedState(), NOW, READING_W);

    if (decision.kind !== 'credit_pending_relief') throw new Error(`expected a credit, got ${decision.kind}`);
    expect(decision.pending.totalKw).toBeCloseTo(2, 6);
    expect(decision.pending.powerW).toBe(READING_W);
  });

  it('still credits a reading that has moved by a few watts without showing the shed', () => {
    // 4351 -> 4348: a live meter moves, but a jitter is not the shed landing.
    const decision = decide(shedState(), NOW, READING_W - 3);

    if (decision.kind !== 'credit_pending_relief') throw new Error(`expected a credit, got ${decision.kind}`);
    expect(decision.pending.totalKw).toBeCloseTo(1.997, 6);
  });

  it('proceeds once the reading has fallen by half the delivered relief', () => {
    // The meter caught up with ~1.08 of the 2 kW credited: it has seen the shed,
    // and what it shows now is the deficit.
    expect(decide(shedState(), NOW, 3_271)).toMatchObject({ kind: 'proceed', escalatedSameSample: false });
  });

  it('stops crediting once the window elapses', () => {
    const decision = decide(shedState({ latch: decidedAt(NOW - 30_000) }), NOW, READING_W);

    expect(decision.kind).toBe('proceed');
  });

  it('does not credit when the shed stamp is in the future after a clock correction', () => {
    const decision = decide(shedState({ latch: decidedAt(NOW + 60_000) }), NOW, READING_W);

    expect(decision.kind).toBe('proceed');
  });

  it('does not credit when the tracker carries no usable reading', () => {
    expect(decide(shedState(), NOW, null).kind).toBe('proceed');
  });

  it('does not credit the first shed of a fresh overshoot once the earlier latch is cleared', () => {
    // `planBuilderOvershoot` drops the whole latch when an overshoot ENDS
    // (`clearShedPlanLatch`), so relief credited in one incident cannot delay
    // the next incident's first pass — and before any shed has latched at all
    // there is nothing to credit.
    expect(decide(shedState({ latch: null }), NOW, READING_W).kind).toBe('proceed');
  });

  describe('same-sample behaviour is unchanged', () => {
    it('skips a re-shed on the very sample the last shed was planned from, still holding its decision', () => {
      const decision = decide(shedState({ overshootMitigatedAtMs: NOW - 1_000 }), SAMPLE_TS, READING_W);

      if (decision.kind !== 'skip_same_sample') throw new Error(`expected a skip, got ${decision.kind}`);
      expect([...(decision.pending?.held.keys() ?? [])]).toEqual(['vvb']);
    });

    it('holds nothing on the same sample once the decision is out of its window', () => {
      const decision = decide(
        shedState({ overshootMitigatedAtMs: NOW - 1_000, latch: decidedAt(NOW - 30_000) }),
        SAMPLE_TS,
        READING_W,
      );

      if (decision.kind !== 'skip_same_sample') throw new Error(`expected a skip, got ${decision.kind}`);
      expect(decision.pending?.held.size).toBe(0);
    });

    it('escalates on the same sample once the escalation interval has passed', () => {
      const decision = decide(shedState({ overshootMitigatedAtMs: NOW - 30_000 }), SAMPLE_TS, READING_W);

      expect(decision).toEqual({ kind: 'proceed', escalatedSameSample: true, pending: null });
    });

    it('never escalates the same sample when escalation is not allowed', () => {
      const decision = resolveSameMeasurementSheddingDecision(
        shedState({ overshootMitigatedAtMs: NOW - 30_000 }),
        devices,
        SAMPLE_TS,
        READING_W,
        NOW,
        false,
      );

      expect(decision.kind).toBe('skip_same_sample');
    });
  });
});
