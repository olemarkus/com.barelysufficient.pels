import { describe, expect, it } from 'vitest';
import { stampSteppedFairnessHolds } from '../../lib/plan/planSteppedFairnessHold';
import { ShedDecisions } from '../../lib/plan/shedDecisions';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import { buildPlanDevice, steppedPlanDevice } from '../utils/planTestUtils';

const limitedHeater = (id: string, priority = 5): DevicePlanDevice => buildPlanDevice({
  id, priority, plannedState: 'shed', reason: { code: PLAN_REASON_CODES.capacity },
});

const charger = (overrides: Parameters<typeof steppedPlanDevice>[0] = {}) => steppedPlanDevice({
  id: 'charger', isEvCharger: true, plannedState: 'keep', selectedStepId: 'low', desiredStepId: 'low',
  reason: { code: PLAN_REASON_CODES.keep, detail: null },
  ...overrides,
});

const stampFor = (devices: DevicePlanDevice[]) => (
  stampSteppedFairnessHolds(devices, new ShedDecisions()).find((device) => device.id === 'charger')
    ?.steppedFairnessHold
);

describe('stampSteppedFairnessHolds', () => {
  it('holds a stepped device at its lowest active step while other devices are limited', () => {
    expect(stampFor([charger(), limitedHeater('heater-1'), limitedHeater('heater-2')]))
      .toEqual({ stepId: 'low', limitedDeviceCount: 2 });
  });

  it('holds it whatever reason the cycle wrote for the cut and the wait after it', () => {
    for (const reason of [
      { code: PLAN_REASON_CODES.capacity, shortfallKw: 6 },
      { code: PLAN_REASON_CODES.cooldownShedding, remainingSec: 30 },
    ] as const) {
      expect(stampFor([charger({ plannedState: 'shed', reason }), limitedHeater('heater')]))
        .toEqual({ stepId: 'low', limitedDeviceCount: 1 });
    }
  });

  it('states the count of a refused step-up when the cycle wrote one', () => {
    const refused = charger({ reason: {
      code: PLAN_REASON_CODES.shedInvariant, fromStep: 'low', toStep: 'medium', shedDeviceCount: 3, maxStep: 'low',
    } });
    expect(stampFor([refused, limitedHeater('heater')])).toEqual({ stepId: 'low', limitedDeviceCount: 3 });
  });

  it('holds a boosted device while a device ranked above it is limited', () => {
    // Prod 2026-11-02: a boosted priority-4 charger climbed past the rule while
    // the priority-2 thermostat was held. Only the device ranked above it counts.
    expect(stampFor([
      charger({ boostActive: true, priority: 4 }), limitedHeater('thermostat', 2), limitedHeater('heater', 6),
    ])).toEqual({ stepId: 'low', limitedDeviceCount: 1 });
  });

  it.each([
    { name: 'no other device is limited', devices: [charger()] },
    { name: 'it is above its lowest active step', devices: [charger({ desiredStepId: 'medium' }), limitedHeater('h')] },
    { name: 'it is off', devices: [charger({ desiredStepId: 'off' }), limitedHeater('h')] },
    {
      name: 'it is boosted and only devices ranked below it are limited',
      devices: [charger({ boostActive: true, priority: 1 }), limitedHeater('h', 5)],
    },
    {
      name: 'it is observed off and starting at its low step',
      devices: [charger({ currentState: 'off', reason: { code: PLAN_REASON_CODES.restoreNeed,
        fromTarget: 'off', toTarget: 'low', needKw: 1.25 } }),
      limitedHeater('h')],
    },
    {
      // Prod 2026-11-13: a car that paused its own charge read "Limited · Off"
      // with "Holding at 6 A — cannot increase while 1 device is limited".
      name: 'it rests on its off rung while PELS wants its low step',
      devices: [charger({ selectedStepId: 'off' }), limitedHeater('h')],
    },
    { name: 'a non-capacity hold lowered it', devices: [charger({ nonCapacityHoldShed: true }), limitedHeater('h')] },
    { name: 'it tracks solar surplus', devices: [charger({ surplusTracking: true }), limitedHeater('h')] },
    { name: 'PELS cannot command it', devices: [charger({ commandAuthority: false }), limitedHeater('h')] },
    {
      name: 'the capacity period is spent',
      devices: [charger({ plannedState: 'shed', reason: { code: PLAN_REASON_CODES.hourlyBudget } }), limitedHeater('h')],
    },
    {
      name: 'the restore cooldown holds it',
      devices: [charger({ reason: { code: PLAN_REASON_CODES.cooldownRestore, remainingSec: 120 } }), limitedHeater('h')],
    },
  ])('does not hold it when $name', ({ devices }) => {
    expect(stampFor(devices)).toBeUndefined();
  });
});
