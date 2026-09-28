import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';
import { describe, expect, it } from 'vitest';
import { buildObjectiveProfileSample, type ObjectiveSampleDevice } from '../../lib/objectives/samples';
import { resolveObjectiveObservedQuantity } from '../../packages/shared-domain/src/objectiveObservedQuantity';
import { resolveObjectiveSteps } from '../../lib/objectives/deferredObjectives/objectiveSteps';
import { resolvePlanningSpeedKw } from '../../lib/objectives/deferredObjectives/planningSpeed';
import type { ObjectiveDeviceInput } from '../../lib/objectives/types';

// Objectives identify EV chargers through the canonical `isEvDevice`, never a
// class literal of their own. The EV fixture carries the charger class (the
// planner device keeps no capability list for the capability branch of
// `isEvDevice` to read); what these cases pin is that the two branches give
// different answers: the EV branch plans at the calibrated `expectedPowerKw`
// (7 kW), the plain on/off fallback at the live draw (3 kW).
const NOW = 1_700_000_000_000;

const capabilityOnlyEv = (extra: Partial<ObjectiveDeviceInput> = {}): ObjectiveDeviceInput => ({
  id: 'ev-cap',
  name: 'EV (capability only)',
  deviceClass: 'evcharger',
  currentDrawKw: 3,
  expectedPowerKw: 7,
  objectiveSessionInactive: false,
  thermalDirection: 'heating',
  ...extra,
});

// Non-EV, non-temperature device drawing 3 kW (a relay an energy task runs):
// one synthetic rung at its live draw, not at the expected power.
const plainOnOff: ObjectiveDeviceInput = {
  id: 'x', name: 'Plain', currentDrawKw: 3, expectedPowerKw: 7,
  objectiveSessionInactive: false, thermalDirection: 'heating',
};

describe('lib/objectives de-kind — capability-only EV takes the EV branch', () => {
  it('resolveObjectiveSteps emits a charge step for a capability-only EV', () => {
    expect(resolveObjectiveSteps(capabilityOnlyEv())).toEqual([{
      id: 'charge',
      usefulPowerKw: 7,
      admissionPowerKw: 7,
    }]);
    expect(resolveObjectiveSteps(plainOnOff)).toEqual([{ id: 'charge', usefulPowerKw: 3, admissionPowerKw: 3 }]);
  });

  it('resolvePlanningSpeedKw returns the EV rate for a capability-only EV', () => {
    expect(resolvePlanningSpeedKw(capabilityOnlyEv())).toBe(7);
    expect(resolvePlanningSpeedKw(plainOnOff)).toBe(3);
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
    const observedQuantity = resolveObjectiveObservedQuantity(observed);
    // The seam drops a device with no reading, so reaching the sampler at all is
    // itself the assertion that this capability-only charger resolved one.
    expect(observedQuantity).not.toBeNull();
    const device: ObjectiveSampleDevice = {
      ...observed,
      // Producer-resolved: this charger has no meter, which resolves to 0 kW.
      currentDrawKw: 0,
      thermalDirection: 'heating',
      observedQuantity: observedQuantity as NonNullable<typeof observedQuantity>,
    };
    const sample = buildObjectiveProfileSample(device, NOW);
    expect(sample?.value).toBe(55);
  });
});
