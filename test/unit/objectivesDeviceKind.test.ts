import { describe, expect, it } from 'vitest';
import { buildObjectiveProfileSample } from '../../lib/objectives/samples';
import { resolveObjectiveSteps } from '../../lib/objectives/deferredObjectives/objectiveSteps';
import { resolvePlanningSpeedKw } from '../../lib/objectives/deferredObjectives/planningSpeed';
import type { ObjectiveDeviceInput } from '../../lib/objectives/types';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

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
  controlCapabilityId: 'evcharger_charging',
  expectedPowerKw: 7,
  ...extra,
});

// Non-EV, non-temperature device with the same power: no synthetic charge step.
const plainOnOff: ObjectiveDeviceInput = { id: 'x', name: 'Plain', expectedPowerKw: 7 };

describe('lib/objectives de-kind — capability-only EV takes the EV branch', () => {
  it('resolveObjectiveSteps emits a charge step for a capability-only EV', () => {
    expect(resolveObjectiveSteps(capabilityOnlyEv())).toEqual([{ id: 'charge', usefulPowerKw: 7 }]);
    expect(resolveObjectiveSteps(plainOnOff)).toEqual([]);
  });

  it('resolvePlanningSpeedKw returns the EV rate for a capability-only EV', () => {
    expect(resolvePlanningSpeedKw(capabilityOnlyEv())).toBe(7);
    expect(resolvePlanningSpeedKw(plainOnOff)).toBeNull();
  });

  it('buildObjectiveProfileSample emits an SoC sample for a capability-only EV', () => {
    const device = {
      id: 'ev-cap',
      name: 'EV (capability only)',
      controlCapabilityId: 'evcharger_charging',
      stateOfCharge: { status: 'fresh', percent: 55, observedAtMs: NOW },
      lastFreshDataMs: NOW,
    } as unknown as TargetDeviceSnapshot;
    const sample = buildObjectiveProfileSample(device, NOW);
    expect(sample?.value).toBe(55);
    expect(sample?.unit).toBe('percent');
  });
});
