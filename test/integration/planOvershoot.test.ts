import { resolveSoftOvershootDecision } from '../../lib/plan/planOvershoot';
import { SHED_GRACE_MAX_MS, SOFT_OVERSHOOT_PERSIST_MS } from '../../lib/plan/planConstants';

describe('pressure episode persistence', () => {
  it('clears the episode when pressure clears', () => {
    expect(resolveSoftOvershootDecision(0.002, true, 0, 5000)).toEqual({
      actionable: false, shedActionable: false, pendingSinceMs: null,
    });
  });

  it('ignores rounding noise until it persists', () => {
    expect(resolveSoftOvershootDecision(-0.01, false, null, 0).actionable).toBe(false);
    expect(resolveSoftOvershootDecision(-0.01, false, 0, SOFT_OVERSHOOT_PERSIST_MS)).toEqual({
      actionable: true, shedActionable: true, pendingSinceMs: 0,
    });
  });

  it('records meaningful pressure immediately while a funded wait defers new cuts', () => {
    expect(resolveSoftOvershootDecision(-2, true, null, 1000)).toEqual({
      actionable: true, shedActionable: false, pendingSinceMs: 1000,
    });
  });

  it('acts immediately when the period allowance cannot fund another wait', () => {
    expect(resolveSoftOvershootDecision(-0.2, false, null, 1000)).toEqual({
      actionable: true, shedActionable: true, pendingSinceMs: 1000,
    });
  });

  it('never restarts a sustained pressure clock on a later build', () => {
    const first = resolveSoftOvershootDecision(-2, true, null, 1000);
    const later = resolveSoftOvershootDecision(-1, true, first.pendingSinceMs, 1000 + SHED_GRACE_MAX_MS);
    expect(later).toEqual({ actionable: true, shedActionable: true, pendingSinceMs: 1000 });
  });
});
