import { describe, expect, it } from 'vitest';
import {
  resolvePlanningCeilingKw,
  resolvePlanningPowerCeiling,
  resolveUsableCapacityKw,
} from '../../lib/power/capacityModel';
import { resolveDeferredObjectivePowerLimit } from '../../lib/objectives/deferredObjectives/policyHorizon';
import { configuredPowerCeiling } from '../../packages/shared-domain/src/settings/powerLimits';
import { capacityOnlyPowerLimits, powerLimits } from '../helpers/powerLimitSettings';

// The power owner resolves one house ceiling from the enabled limits, so planning
// consumers (daily-budget hours, smart-task headroom, budget pressure, weather
// suggestion) follow the Capacity limit and Grid import limit switches instead
// of a persisted hard cap that may be switched off.
describe('planning power ceiling', () => {
  it('is exactly hard cap minus safety margin with only Capacity limit on', () => {
    const settings = capacityOnlyPowerLimits(10, 0.2);
    expect(resolvePlanningPowerCeiling(settings)).toEqual({
      limit: 'capacity',
      kw: resolveUsableCapacityKw(settings),
    });
    expect(resolvePlanningCeilingKw(settings)).toBe(resolveUsableCapacityKw(settings));
  });

  it('is absent with both limits off, whatever hard cap stays persisted', () => {
    const settings = powerLimits({ enabled: false, limitKw: 5, marginKw: 0.2 }, null);
    expect(resolvePlanningPowerCeiling(settings)).toBeNull();
    expect(resolvePlanningCeilingKw(settings)).toBeNull();
  });

  it('is the grid import target once Capacity limit is off', () => {
    // A 5 kW capacity user who switches to a 17 kW grid limit plans at 16.15 kW,
    // not at the hidden 4.8 kW.
    const settings = powerLimits({ enabled: false, limitKw: 5, marginKw: 0.2 }, 17);
    expect(resolvePlanningPowerCeiling(settings)).toEqual({ limit: 'grid', kw: 17 * 0.95 });
  });

  it('is the lower working rate when both limits are on', () => {
    // Default 10/0.2 capacity with a 7.4 kW grid limit: live control holds 7.03 kW,
    // so planning must not reserve 9.8 kW.
    expect(resolvePlanningPowerCeiling(powerLimits({ enabled: true, limitKw: 10, marginKw: 0.2 }, 7.4)))
      .toEqual({ limit: 'grid', kw: 7.4 * 0.95 });
    expect(resolvePlanningPowerCeiling(powerLimits({ enabled: true, limitKw: 5, marginKw: 0.2 }, 17)))
      .toEqual({ limit: 'capacity', kw: resolveUsableCapacityKw(capacityOnlyPowerLimits(5, 0.2)) });
  });

  it('names the grid import limit on an exact tie', () => {
    // 9.5 kW hard cap, no margin; 10 kW grid limit targets 9.5 kW.
    expect(resolvePlanningPowerCeiling(powerLimits({ enabled: true, limitKw: 9.5, marginKw: 0 }, 10)))
      .toEqual({ limit: 'grid', kw: 9.5 });
  });
});

describe('configured power ceiling', () => {
  it('is the hard cap itself with only Capacity limit on', () => {
    expect(configuredPowerCeiling(capacityOnlyPowerLimits(10, 0.2))).toEqual({ limit: 'capacity', kw: 10 });
  });

  it('is absent with both limits off', () => {
    expect(configuredPowerCeiling(powerLimits({ enabled: false, limitKw: 10, marginKw: 0.2 }, null)))
      .toBeNull();
  });

  it('is the grid import limit once Capacity limit is off', () => {
    expect(configuredPowerCeiling(powerLimits({ enabled: false, limitKw: 10, marginKw: 0.2 }, 7.4)))
      .toEqual({ limit: 'grid', kw: 7.4 });
  });

  it('is the lower configured limit when both are on', () => {
    expect(configuredPowerCeiling(powerLimits({ enabled: true, limitKw: 10, marginKw: 0.2 }, 7.4)))
      .toEqual({ limit: 'grid', kw: 7.4 });
    expect(configuredPowerCeiling(powerLimits({ enabled: true, limitKw: 5, marginKw: 0.2 }, 17)))
      .toEqual({ limit: 'capacity', kw: 5 });
  });
});

describe('smart-task horizon power limit', () => {
  it('is limited with no admission ceiling with only Capacity limit on', () => {
    expect(resolveDeferredObjectivePowerLimit(capacityOnlyPowerLimits(10, 0.2), false))
      .toEqual({ kind: 'limited', admissionCeilingKw: null });
  });

  it('is unlimited with no power limit enabled', () => {
    expect(resolveDeferredObjectivePowerLimit(powerLimits({ enabled: false, limitKw: 10, marginKw: 0.2 }, null), false))
      .toEqual({ kind: 'unlimited' });
  });

  it('admits no rung above the grid import target in a home with no solar production', () => {
    expect(resolveDeferredObjectivePowerLimit(powerLimits({ enabled: false, limitKw: 10, marginKw: 0.2 }, 1.5), false))
      .toEqual({ kind: 'limited', admissionCeilingKw: 1.5 * 0.95 });
    // Capacity binds the planning ceiling here, but the grid target still bounds each rung.
    expect(resolveDeferredObjectivePowerLimit(powerLimits({ enabled: true, limitKw: 5, marginKw: 0.2 }, 17), false))
      .toEqual({ kind: 'limited', admissionCeilingKw: 17 * 0.95 });
  });

  it('keeps the whole ladder in a home with solar production, where export can make room', () => {
    expect(resolveDeferredObjectivePowerLimit(powerLimits({ enabled: false, limitKw: 10, marginKw: 0.2 }, 1.5), true))
      .toEqual({ kind: 'limited', admissionCeilingKw: null });
  });
});
