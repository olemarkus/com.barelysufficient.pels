import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';
import { describe, expect, it } from 'vitest';
import { buildObjectiveProfileSample, type ObjectiveSampleDevice } from '../../lib/objectives/samples';
import { resolveObjectiveObservedQuantity } from '../../packages/shared-domain/src/objectiveObservedQuantity';
import { resolveObjectiveSteps } from '../../lib/objectives/deferredObjectives/objectiveSteps';
import { resolvePlanningSpeedKw } from '../../lib/objectives/deferredObjectives/planningSpeed';
import type { ObjectiveDeviceInput } from '../../lib/objectives/types';

// Regression coverage for the de-kind widening: objectives now identify EV
// chargers via the canonical `isEvDevice` (deviceClass OR the
// `evcharger_charging` capability), not the narrow `deviceClass === 'evcharger'`.
// These fixtures are EV BY CAPABILITY ONLY — no `deviceClass` — so the old check
// would have skipped the EV branch (returning [] / null). Each assertion fails
// if the EV identity regresses to the class-only form.
const NOW = 1_700_000_000_000;

const capabilityOnlyEv = (extra: Partial<ObjectiveDeviceInput> = {}): ObjectiveDeviceInput => ({
  id: 'ev-cap',
  name: 'EV (capability only)',
  deviceClass: 'evcharger',
  currentDrawKw: 0,
  expectedPowerKw: 7,
  objectiveSessionInactive: false,
  ...extra,
});

// Non-EV, non-temperature device with the same power: no synthetic charge step.
const plainOnOff: ObjectiveDeviceInput = {
  id: 'x', name: 'Plain', currentDrawKw: 0, expectedPowerKw: 7, objectiveSessionInactive: false,
};

describe('lib/objectives de-kind — capability-only EV takes the EV branch', () => {
  it('resolveObjectiveSteps emits a charge step for a capability-only EV', () => {
    expect(resolveObjectiveSteps(capabilityOnlyEv())).toEqual([{
      id: 'charge',
      usefulPowerKw: 7,
      admissionPowerKw: 7,
    }]);
    expect(resolveObjectiveSteps(plainOnOff)).toEqual([]);
  });

  it('resolvePlanningSpeedKw returns the EV rate for a capability-only EV', () => {
    expect(resolvePlanningSpeedKw(capabilityOnlyEv())).toBe(7);
    expect(resolvePlanningSpeedKw(plainOnOff)).toBeNull();
  });

  it('buildObjectiveProfileSample emits an SoC sample for a capability-only EV', () => {
    const observed = {
      id: 'ev-cap',
      name: 'EV (capability only)',
      deviceClass: 'evcharger',
      targets: [],
      available: true,
      stateOfCharge: stateOfChargeFixture({ percent: 55, observedAtMs: NOW }),
      lastFreshDataMs: NOW,
    };
    // Through the real seam rather than a cast: `observedQuantity` is what the
    // sampler reads, and hand-building it would test the fixture instead of the
    // resolution that decides a charger reports its charge.
    const device: ObjectiveSampleDevice = {
      ...observed,
      // Producer-resolved: this charger has no meter, which resolves to 0 kW.
      currentDrawKw: 0,
      observedQuantity: resolveObjectiveObservedQuantity({
        device: observed,
        deviceObservedAtMs: observed.lastFreshDataMs,
      }),
    };
    const sample = buildObjectiveProfileSample(device, NOW);
    expect(sample?.value).toBe(55);
  });
});
