import { createPlanEngineState, type PlanEngineState } from '../../lib/plan/planState';
import {
  SURPLUS_ABSORB_MIN_DWELL_MS,
  SURPLUS_ABSORB_RESERVE_KW,
  SURPLUS_ABSORB_SETTLE_MS,
  syncSurplusEligibilityState,
} from '../../lib/plan/admission/surplusAbsorb';

const DEVICE = 'heater-1';
const EXPECTED_DRAW_KW = 1;
const AMPLE_SURPLUS_KW = 2; // clears the engage bar of expectedDraw + reserve

const baseParams = (overrides: Record<string, unknown> = {}) => ({
  deviceId: DEVICE,
  willing: true,
  expectedDrawKw: EXPECTED_DRAW_KW,
  availableSurplusKw: AMPLE_SURPLUS_KW,
  ...overrides,
});

// Settle requires the condition to persist across cycles, so engagement needs a
// priming call to open the window then a confirming call a settle-window later.
const engageAt = (state: PlanEngineState, engagedMs: number, overrides: Record<string, unknown> = {}) => {
  syncSurplusEligibilityState({ state, ...baseParams(overrides), nowTs: engagedMs - SURPLUS_ABSORB_SETTLE_MS });
  return syncSurplusEligibilityState({ state, ...baseParams(overrides), nowTs: engagedMs });
};

describe('surplus-absorb eligibility gate', () => {
  it('never engages a non-willing device and clears any leftover state', () => {
    const state = createPlanEngineState(0);
    state.surplusEligibilityByDevice[DEVICE] = { eligible: true, sinceMs: 0 };
    const result = syncSurplusEligibilityState({ state, ...baseParams({ willing: false }), nowTs: 1000 });
    expect(result.eligible).toBe(false);
    expect(state.surplusEligibilityByDevice[DEVICE]).toBeUndefined();
  });

  it('never engages without an expected-draw estimate', () => {
    const state = createPlanEngineState(0);
    expect(engageAt(state, SURPLUS_ABSORB_SETTLE_MS, { expectedDrawKw: 0 }).eligible).toBe(false);
  });

  it('engages only after the surplus persists for the settle window', () => {
    const state = createPlanEngineState(0);
    expect(syncSurplusEligibilityState({ state, ...baseParams(), nowTs: 0 }).eligible).toBe(false);
    expect(
      syncSurplusEligibilityState({ state, ...baseParams(), nowTs: SURPLUS_ABSORB_SETTLE_MS - 1 }).eligible,
    ).toBe(false);
    expect(
      syncSurplusEligibilityState({ state, ...baseParams(), nowTs: SURPLUS_ABSORB_SETTLE_MS }).eligible,
    ).toBe(true);
  });

  it('applies the overshoot-fit gate: surplus must cover expected draw plus the reserve', () => {
    const justUnder = createPlanEngineState(0);
    const under = EXPECTED_DRAW_KW + SURPLUS_ABSORB_RESERVE_KW - 0.01;
    expect(engageAt(justUnder, SURPLUS_ABSORB_SETTLE_MS, { availableSurplusKw: under }).eligible).toBe(false);

    const justOver = createPlanEngineState(0);
    const over = EXPECTED_DRAW_KW + SURPLUS_ABSORB_RESERVE_KW;
    expect(engageAt(justOver, SURPLUS_ABSORB_SETTLE_MS, { availableSurplusKw: over }).eligible).toBe(true);
  });

  it('releases after the min-dwell once the allocated surplus is gone', () => {
    const state = createPlanEngineState(0);
    const engagedAt = SURPLUS_ABSORB_SETTLE_MS;
    engageAt(state, engagedAt);
    const gone = { availableSurplusKw: 0 };

    // Min dwell holds the lift first, even with the release condition sustained.
    expect(
      syncSurplusEligibilityState({ state, ...baseParams(gone), nowTs: engagedAt + SURPLUS_ABSORB_MIN_DWELL_MS - 1 })
        .eligible,
    ).toBe(true);
    // Past the dwell, once the release settles, it drops back and the entry clears.
    expect(
      syncSurplusEligibilityState({
        state,
        ...baseParams(gone),
        nowTs: engagedAt + SURPLUS_ABSORB_MIN_DWELL_MS + SURPLUS_ABSORB_SETTLE_MS,
      }).eligible,
    ).toBe(false);
    expect(state.surplusEligibilityByDevice[DEVICE]).toBeUndefined();
  });

  it('never engages when the allocated surplus is unknown (null)', () => {
    const state = createPlanEngineState(0);
    expect(engageAt(state, SURPLUS_ABSORB_SETTLE_MS, { availableSurplusKw: null }).eligible).toBe(false);
  });
});
