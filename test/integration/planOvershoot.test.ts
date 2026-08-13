import {
  SHED_GRACE_HEADROOM_FRACTION,
  SHED_GRACE_MAX_MS,
  SOFT_OVERSHOOT_PERSIST_MS,
} from '../../lib/plan/planConstants';
import { resolveShedGraceMs, resolveSoftOvershootDecision } from '../../lib/plan/planOvershoot';
import { createPlanEngineState } from '../../lib/plan/planState';

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

    let decision = resolveSoftOvershootDecision({
      headroomKw: -0.01,
      hourRemainingKWh: 4.7,
      restoreTransientPossible: false,
      state,
      nowTs: Date.now(),
    });
    expect(decision.actionable).toBe(false);
    state.softOvershootPendingSinceMs = decision.pendingSinceMs;

    vi.advanceTimersByTime(5_000);
    decision = resolveSoftOvershootDecision({
      headroomKw: 0.002,
      hourRemainingKWh: 4.7,
      restoreTransientPossible: false,
      state,
      nowTs: Date.now(),
    });
    expect(decision.actionable).toBe(false);
    expect(decision.pendingSinceMs).toBeNull();
    state.softOvershootPendingSinceMs = decision.pendingSinceMs;

    vi.advanceTimersByTime(5_000);
    decision = resolveSoftOvershootDecision({
      headroomKw: -0.008,
      hourRemainingKWh: 4.7,
      restoreTransientPossible: false,
      state,
      nowTs: Date.now(),
    });
    expect(decision.actionable).toBe(false);
    expect(decision.pendingSinceMs).toBe(Date.now());
  });

  it('promotes a small deficit after the dwell time elapses', () => {
    const state = createPlanEngineState();
    state.softOvershootPendingSinceMs = Date.now() - SOFT_OVERSHOOT_PERSIST_MS;
    const pendingSinceMs = state.softOvershootPendingSinceMs;

    const decision = resolveSoftOvershootDecision({
      headroomKw: -0.01,
      hourRemainingKWh: 4.7,
      restoreTransientPossible: false,
      state,
      nowTs: Date.now(),
    });

    expect(decision.actionable).toBe(true);
    expect(decision.pendingSinceMs).toBe(pendingSinceMs);
  });

  it('treats meaningful overshoot above the deadband as immediately actionable', () => {
    const state = createPlanEngineState();

    const decision = resolveSoftOvershootDecision({
      headroomKw: -0.2,
      hourRemainingKWh: 4.7,
      restoreTransientPossible: false,
      state,
      nowTs: Date.now(),
    });

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

      const decision = resolveSoftOvershootDecision({
        headroomKw: -1.611,
        hourRemainingKWh: 4.45,
        restoreTransientPossible: true,
        state,
        nowTs: Date.now(),
      });

      // Attribution must not wait — the backoff ladder learns from this.
      expect(decision.actionable).toBe(true);
      // Shedding must, because the deficit may be the restore still ramping.
      expect(decision.shedActionable).toBe(false);
    });

    it('acts once the deficit has burned the energy we were willing to slip', () => {
      const state = createPlanEngineState();
      state.softOvershootPendingSinceMs = Date.now() - SHED_GRACE_MAX_MS;

      const decision = resolveSoftOvershootDecision({
        headroomKw: -1.611,
        hourRemainingKWh: 4.45,
        restoreTransientPossible: true,
        state,
        nowTs: Date.now(),
      });

      expect(decision.shedActionable).toBe(true);
    });

    it('never defers when the hour has no budget left to absorb the wait', () => {
      const state = createPlanEngineState();

      const decision = resolveSoftOvershootDecision({
        headroomKw: -1.611,
        hourRemainingKWh: 0,
        restoreTransientPossible: true,
        state,
        nowTs: Date.now(),
      });

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

  it('keeps a persisted tiny deficit latched across later cycles', () => {
    const state = createPlanEngineState();
    const initialPendingSinceMs = Date.now() - SOFT_OVERSHOOT_PERSIST_MS;
    state.softOvershootPendingSinceMs = initialPendingSinceMs;

    let decision = resolveSoftOvershootDecision({
      headroomKw: -0.01,
      hourRemainingKWh: 4.7,
      restoreTransientPossible: false,
      state,
      nowTs: Date.now(),
    });
    expect(decision.actionable).toBe(true);
    expect(decision.pendingSinceMs).toBe(initialPendingSinceMs);

    state.softOvershootPendingSinceMs = decision.pendingSinceMs;
    vi.advanceTimersByTime(5_000);
    decision = resolveSoftOvershootDecision({
      headroomKw: -0.01,
      hourRemainingKWh: 4.7,
      restoreTransientPossible: false,
      state,
      nowTs: Date.now(),
    });

    expect(decision.actionable).toBe(true);
    expect(decision.pendingSinceMs).toBe(initialPendingSinceMs);
  });
});
