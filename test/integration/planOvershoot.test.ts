import {
  SHED_GRACE_HEADROOM_FRACTION,
  SHED_GRACE_MAX_MS,
  SOFT_OVERSHOOT_PERSIST_MS,
} from '../../lib/plan/planConstants';
import { resolveShedGraceMs, unpricedShedGrace } from '../../lib/plan/planOvershoot';
import { createPlanEngineState } from '../utils/planEngineStateFixture';

describe('resolveSoftOvershootDecision', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores rounding-level fluctuations around zero without latching overshoot', () => {
    const state = createPlanEngineState();

    let decision = state.overshoot.decideSoft(-0.01, 4.7, false, Date.now());
    expect(decision.actionable).toBe(false);

    vi.advanceTimersByTime(5_000);
    decision = state.overshoot.decideSoft(0.002, 4.7, false, Date.now());
    expect(decision.actionable).toBe(false);
    expect(decision.pendingSinceMs).toBeNull();

    vi.advanceTimersByTime(5_000);
    decision = state.overshoot.decideSoft(-0.008, 4.7, false, Date.now());
    expect(decision.actionable).toBe(false);
    expect(decision.pendingSinceMs).toBe(Date.now());
  });

  it('promotes a small deficit after the dwell time elapses', () => {
    const state = createPlanEngineState();
    const pendingSinceMs = Date.now() - SOFT_OVERSHOOT_PERSIST_MS;
    state.overshoot['softPendingSinceMs'] = pendingSinceMs;

    const decision = state.overshoot.decideSoft(-0.01, 4.7, false, Date.now());

    expect(decision.actionable).toBe(true);
    expect(decision.pendingSinceMs).toBe(pendingSinceMs);
  });

  it('treats meaningful overshoot above the deadband as immediately actionable', () => {
    const state = createPlanEngineState();

    const decision = state.overshoot.decideSoft(-0.2, 4.7, false, Date.now());

    expect(decision.actionable).toBe(true);
    // No restore in flight, so nothing to wait for — acting is immediate.
    expect(decision.shedActionable).toBe(true);
    // The deficit's start is now stamped even above the deadband: the grace
    // needs an origin to measure from when a restore IS in flight.
    expect(decision.pendingSinceMs).toBe(Date.now());
  });

  describe('shed grace while a restore is still settling', () => {
    it('records the overshoot immediately but defers acting on it', () => {
      const state = createPlanEngineState();

      const decision = state.overshoot.decideSoft(-1.611, 4.45, true, Date.now());

      // Attribution must not wait — the backoff ladder learns from this.
      expect(decision.actionable).toBe(true);
      // Shedding must, because the deficit may be the restore still ramping.
      expect(decision.shedActionable).toBe(false);
    });

    it('acts once the deficit has burned the energy we were willing to slip', () => {
      const state = createPlanEngineState();
      state.overshoot['softPendingSinceMs'] = Date.now() - SHED_GRACE_MAX_MS;

      const decision = state.overshoot.decideSoft(-1.611, 4.45, true, Date.now());

      expect(decision.shedActionable).toBe(true);
    });

    it('never defers when the hour has no budget left to absorb the wait', () => {
      const state = createPlanEngineState();

      const decision = state.overshoot.decideSoft(-1.611, 0, true, Date.now());

      expect(decision.shedActionable).toBe(true);
    });
  });

  describe('resolveShedGraceMs', () => {
    // The invariant the whole design rests on: waiting can never put more than
    // SHED_GRACE_HEADROOM_FRACTION of the remaining hour at risk, because the
    // window IS the time the deficit needs to consume exactly that much.
    it('bounds the energy at risk regardless of how large the deficit is', () => {
      const hourRemainingKWh = 4.7;
      for (const deficitKw of [0.2, 1.222, 5.6, 20]) {
        const graceMs = resolveShedGraceMs({ deficitKw, hourRemainingKWh });
        const energyAtRiskKWh = deficitKw * (graceMs / 3_600_000);
        expect(energyAtRiskKWh).toBeLessThanOrEqual(
          hourRemainingKWh * SHED_GRACE_HEADROOM_FRACTION + 1e-9,
        );
      }
    });

    it('gives a larger deficit a shorter grace, once past the cap', () => {
      // Below roughly 5.6 kW every deficit saturates SHED_GRACE_MAX_MS at a
      // full hour's budget, so the ratio is only observable above it. That the
      // cap binds for ordinary deficits mid-hour is intended: the wager is
      // already tiny there, and the cap is what stops it growing without bound.
      const small = resolveShedGraceMs({ deficitKw: 8, hourRemainingKWh: 4.7 });
      const large = resolveShedGraceMs({ deficitKw: 20, hourRemainingKWh: 4.7 });
      expect(small).toBeLessThan(SHED_GRACE_MAX_MS);
      expect(large).toBeLessThan(small);
    });

    it('shortens the grace as the hour is used up, reaching zero when it is spent', () => {
      const early = resolveShedGraceMs({ deficitKw: 1.222, hourRemainingKWh: 4.45 });
      const late = resolveShedGraceMs({ deficitKw: 1.222, hourRemainingKWh: 0.2 });
      expect(late).toBeLessThan(early);
      expect(resolveShedGraceMs({ deficitKw: 1.222, hourRemainingKWh: 0 })).toBe(0);
    });

    it('caps the wait even when the deficit is trivial and the hour wide open', () => {
      expect(resolveShedGraceMs({ deficitKw: 0.06, hourRemainingKWh: 4.7 })).toBe(SHED_GRACE_MAX_MS);
    });

  });

  // Capacity limit off: no period prices the wait, so a restore transient gets
  // the bounded maximum whatever the deficit — even when the tracked period is
  // spent, which with Capacity limit on buys none.
  it('grants the unpriced grace the bounded maximum, a spent period notwithstanding', () => {
    const state = createPlanEngineState();
    expect(unpricedShedGrace(20)).toBe(SHED_GRACE_MAX_MS);
    expect(unpricedShedGrace(0)).toBe(0);
    expect(state.overshoot.decideSoft(-1.611, 0, true, Date.now()).shedActionable).toBe(true);

    const unpriced = createPlanEngineState();
    expect(unpriced.overshoot.decideSoftUnpriced(-1.611, true, Date.now()).shedActionable).toBe(false);
    vi.advanceTimersByTime(SHED_GRACE_MAX_MS);
    expect(unpriced.overshoot.decideSoftUnpriced(-1.611, true, Date.now()).shedActionable).toBe(true);
    // No restore of its own in flight: a real deficit is acted on at once.
    expect(createPlanEngineState().overshoot.decideSoftUnpriced(-1.611, false, Date.now()).shedActionable).toBe(true);
  });

  it('ends the soft-deficit clock on a grid breach and when no limit is enabled', () => {
    const state = createPlanEngineState();
    state.overshoot['softPendingSinceMs'] = Date.now() - SHED_GRACE_MAX_MS;

    expect(state.overshoot.decideGridBreach()).toEqual({ actionable: true, shedActionable: true, pendingSinceMs: null });
    // The soft deficit after the breach is timed from its own first build, so a
    // restore transient gets its grace.
    expect(state.overshoot.decideSoft(-1.611, 4.45, true, Date.now())).toMatchObject({
      shedActionable: false, pendingSinceMs: Date.now(),
    });

    vi.advanceTimersByTime(30_000);
    expect(state.overshoot.decideWithoutLimit()).toEqual({ actionable: false, shedActionable: false, pendingSinceMs: null });
    expect(state.overshoot.decideSoft(-1.611, 4.45, true, Date.now()).pendingSinceMs).toBe(Date.now());
  });

  it('keeps a persisted tiny deficit latched across later cycles', () => {
    const state = createPlanEngineState();
    const initialPendingSinceMs = Date.now() - SOFT_OVERSHOOT_PERSIST_MS;
    state.overshoot['softPendingSinceMs'] = initialPendingSinceMs;

    let decision = state.overshoot.decideSoft(-0.01, 4.7, false, Date.now());
    expect(decision.actionable).toBe(true);
    expect(decision.pendingSinceMs).toBe(initialPendingSinceMs);
    vi.advanceTimersByTime(5_000);
    decision = state.overshoot.decideSoft(-0.01, 4.7, false, Date.now());

    expect(decision.actionable).toBe(true);
    expect(decision.pendingSinceMs).toBe(initialPendingSinceMs);
  });
});
