import { buildPlanCycle } from '../utils/planContextPowerFixture';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import type { SoftLimitSource } from '../../packages/contracts/src/settingsUiApi';
import { describe, expect, it } from 'vitest';
import { shouldPlanBudgetExemptRestores } from '../../lib/plan/restore/timing';

const base: {
  gridHeadroomKw: number | null;
  gridTargetKw: number | null;
  sheddingActive: boolean;
  softLimitSource: SoftLimitSource;
  capacityHeadroomKw: number | null;
  hourlyBudgetExhausted: boolean;
  timing: { inCooldown: boolean; inRestoreCooldown: boolean; inStartupStabilization: boolean };
} = {
  gridTargetKw: 5,
  gridHeadroomKw: null,
  sheddingActive: true,
  softLimitSource: 'daily' as const,
  capacityHeadroomKw: 3,
  hourlyBudgetExhausted: false,
  timing: { inCooldown: false, inRestoreCooldown: false, inStartupStabilization: false },
};

const canRestore = (scenario: typeof base): boolean => {
  const { context, power } = buildPlanCycle({
    softLimitSource: scenario.softLimitSource,
    gridImportTargetKw: scenario.gridTargetKw,
    gridHeadroomKw: scenario.gridHeadroomKw,
    capacityHeadroomKw: scenario.capacityHeadroomKw,
  });
  const state = createPlanEngineState();
  state.sheddingActive = scenario.sheddingActive;
  state.hourlyBudgetExhausted = scenario.hourlyBudgetExhausted;
  return shouldPlanBudgetExemptRestores(context, power, state, scenario.timing, scenario.sheddingActive);
};

// Every conjunct of the exempt-lane gate pinned individually
// (notes/safe-pace-two-constraints.md § "Proposed model"): the lane runs ONLY
// while shedding is latched by a budget-driven overshoot with capacity room,
// outside every cooldown/startup hold.
describe('shouldPlanBudgetExemptRestores', () => {
  it('requires the grid clear band even when capacity is disabled and the device is budget exempt', () => {
    expect(canRestore({ ...base, capacityHeadroomKw: null, gridHeadroomKw: 0.39 })).toBe(false);
    expect(canRestore({ ...base, capacityHeadroomKw: null, gridHeadroomKw: 0.4 })).toBe(true);
  });

  it('uses the attainable clear band for a low grid limit while daily pacing binds', () => {
    expect(canRestore({ ...base, capacityHeadroomKw: null, gridTargetKw: 0.285, gridHeadroomKw: 0.02 })).toBe(false);
    expect(canRestore({ ...base, capacityHeadroomKw: null, gridTargetKw: 0.285, gridHeadroomKw: 0.1 })).toBe(true);
  });

  it('opens the lane in the latched budget-overshoot regime with capacity room', () => {
    expect(canRestore(base)).toBe(true);
  });

  it('stays closed when shedding is not latched (the full pass owns that regime)', () => {
    expect(canRestore({ ...base, sheddingActive: false })).toBe(false);
  });

  it('stays closed when the binding limit is capacity-derived', () => {
    expect(canRestore({ ...base, softLimitSource: 'capacity' })).toBe(false);
  });

  it('stays closed at zero capacity headroom', () => {
    expect(canRestore({ ...base, capacityHeadroomKw: 0 })).toBe(false);
  });

  it('stays closed at negative capacity headroom (a breach)', () => {
    expect(canRestore({ ...base, capacityHeadroomKw: -1 })).toBe(false);
  });

  it('stays closed in an exhausted hour — the FLAG, not a headroom forced negative upstream', () => {
    // The hour's kWh is spent, so no freed capacity admits anything before it
    // rolls over. This used to ride on the context forcing every axis to -1.
    expect(canRestore({ ...base, hourlyBudgetExhausted: true })).toBe(false);
  });

  it('stays closed during the shed cooldown', () => {
    expect(canRestore({
      ...base,
      timing: { ...base.timing, inCooldown: true },
    })).toBe(false);
  });

  it('stays closed during the restore cooldown', () => {
    expect(canRestore({
      ...base,
      timing: { ...base.timing, inRestoreCooldown: true },
    })).toBe(false);
  });

  it('stays closed during startup stabilization', () => {
    expect(canRestore({
      ...base,
      timing: { ...base.timing, inStartupStabilization: true },
    })).toBe(false);
  });
});
