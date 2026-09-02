import { describe, expect, it } from 'vitest';
import { shouldPlanBudgetExemptRestores } from '../../lib/plan/restore/timing';

const base = {
  sheddingActive: true,
  softLimitSource: 'daily' as const,
  capacityHeadroomKw: 3,
  hourlyBudgetExhausted: false,
  timing: { inCooldown: false, inRestoreCooldown: false, inStartupStabilization: false },
};

// Every conjunct of the exempt-lane gate pinned individually
// (notes/safe-pace-two-constraints.md § "Proposed model"): the lane runs ONLY
// while shedding is latched by a budget-driven overshoot with capacity room,
// outside every cooldown/startup hold.
describe('shouldPlanBudgetExemptRestores', () => {
  it('opens the lane in the latched budget-overshoot regime with capacity room', () => {
    expect(shouldPlanBudgetExemptRestores(base)).toBe(true);
  });

  it('stays closed when shedding is not latched (the full pass owns that regime)', () => {
    expect(shouldPlanBudgetExemptRestores({ ...base, sheddingActive: false })).toBe(false);
  });

  it('stays closed when the binding limit is capacity-derived', () => {
    expect(shouldPlanBudgetExemptRestores({ ...base, softLimitSource: 'capacity' })).toBe(false);
  });

  it('stays closed at zero capacity headroom', () => {
    expect(shouldPlanBudgetExemptRestores({ ...base, capacityHeadroomKw: 0 })).toBe(false);
  });

  it('stays closed at negative capacity headroom (a breach)', () => {
    expect(shouldPlanBudgetExemptRestores({ ...base, capacityHeadroomKw: -1 })).toBe(false);
  });

  it('stays closed in an exhausted hour — the FLAG, not a headroom forced negative upstream', () => {
    // The hour's kWh is spent, so no freed capacity admits anything before it
    // rolls over. This used to ride on the context forcing every axis to -1.
    expect(shouldPlanBudgetExemptRestores({ ...base, hourlyBudgetExhausted: true })).toBe(false);
  });

  it('stays closed during the shed cooldown', () => {
    expect(shouldPlanBudgetExemptRestores({
      ...base,
      timing: { ...base.timing, inCooldown: true },
    })).toBe(false);
  });

  it('stays closed during the restore cooldown', () => {
    expect(shouldPlanBudgetExemptRestores({
      ...base,
      timing: { ...base.timing, inRestoreCooldown: true },
    })).toBe(false);
  });

  it('stays closed during startup stabilization', () => {
    expect(shouldPlanBudgetExemptRestores({
      ...base,
      timing: { ...base.timing, inStartupStabilization: true },
    })).toBe(false);
  });
});
