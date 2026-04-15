import {
  SOFT_OVERSHOOT_PERSIST_MS,
} from '../lib/plan/planConstants';
import { resolveSoftOvershootDecision } from '../lib/plan/planOvershoot';
import { createPlanEngineState } from '../lib/plan/planState';

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
      state,
      nowTs: Date.now(),
    });
    expect(decision.actionable).toBe(false);
    state.softOvershootPendingSinceMs = decision.pendingSinceMs;

    vi.advanceTimersByTime(5_000);
    decision = resolveSoftOvershootDecision({
      headroomKw: 0.002,
      state,
      nowTs: Date.now(),
    });
    expect(decision.actionable).toBe(false);
    expect(decision.pendingSinceMs).toBeNull();
    state.softOvershootPendingSinceMs = decision.pendingSinceMs;

    vi.advanceTimersByTime(5_000);
    decision = resolveSoftOvershootDecision({
      headroomKw: -0.008,
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
      state,
      nowTs: Date.now(),
    });

    expect(decision.actionable).toBe(true);
    expect(decision.pendingSinceMs).toBeNull();
  });

  it('keeps a persisted tiny deficit latched across later cycles', () => {
    const state = createPlanEngineState();
    const initialPendingSinceMs = Date.now() - SOFT_OVERSHOOT_PERSIST_MS;
    state.softOvershootPendingSinceMs = initialPendingSinceMs;

    let decision = resolveSoftOvershootDecision({
      headroomKw: -0.01,
      state,
      nowTs: Date.now(),
    });
    expect(decision.actionable).toBe(true);
    expect(decision.pendingSinceMs).toBe(initialPendingSinceMs);

    state.softOvershootPendingSinceMs = decision.pendingSinceMs;
    vi.advanceTimersByTime(5_000);
    decision = resolveSoftOvershootDecision({
      headroomKw: -0.01,
      state,
      nowTs: Date.now(),
    });

    expect(decision.actionable).toBe(true);
    expect(decision.pendingSinceMs).toBe(initialPendingSinceMs);
  });
});
