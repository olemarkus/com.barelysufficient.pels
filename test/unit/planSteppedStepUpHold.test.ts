import { describe, expect, it } from 'vitest';
import { stampSteppedStepUpHolds } from '../../lib/plan/planSteppedStepUpHold';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { steppedPlanDevice } from '../utils/planTestUtils';
import { insufficientHeadroomFixtureReason } from '../utils/deviceReasonTestUtils';

// A water heater PELS stepped from Max to Low, running there, planned `keep`.
const heater = (overrides: Parameters<typeof steppedPlanDevice>[0] = {}) => steppedPlanDevice({
  id: 'heater', currentState: 'on', plannedState: 'keep',
  selectedStepId: 'low', reportedStepId: 'low', desiredStepId: 'low', lastDesiredStepId: 'low',
  reason: { code: PLAN_REASON_CODES.keep, detail: null },
  ...overrides,
});

const stampOf = (device: ReturnType<typeof heater>) => stampSteppedStepUpHolds([device])[0]?.steppedStepUpHold;

describe('stampSteppedStepUpHolds', () => {
  it('holds a running device PELS stepped down while the shedding latch keeps it', () => {
    expect(stampOf(heater())).toBe(true);
  });

  it('holds it once a tried step-up is refused for lack of room', () => {
    expect(stampOf(heater({ reason: insufficientHeadroomFixtureReason({ needKw: 0.7, availableKw: 0.2 }) }))).toBe(true);
  });

  it('holds it at a middle step below its top step', () => {
    expect(stampOf(heater({
      selectedStepId: 'medium', reportedStepId: 'medium', desiredStepId: 'medium', lastDesiredStepId: 'medium',
    }))).toBe(true);
  });

  it.each([
    { name: 'it is at its top step', overrides: {
      selectedStepId: 'max', reportedStepId: 'max', desiredStepId: 'max', lastDesiredStepId: 'max' } },
    { name: 'its owner left it at a lower step', overrides: { lastDesiredStepId: undefined } },
    { name: 'PELS last commanded a higher step', overrides: { lastDesiredStepId: 'max' } },
    { name: 'a step-up is admitted this cycle', overrides: { desiredStepId: 'medium' } },
    { name: 'its step command is in flight', overrides: { stepCommandPending: true } },
    { name: 'the device has not reached the step', overrides: { reportedStepId: 'medium' } },
    { name: 'it is off', overrides: { currentState: 'off' as const } },
    { name: 'it is being cut', overrides: { plannedState: 'shed' as const,
      reason: { code: PLAN_REASON_CODES.capacity } } },
    { name: 'the shed cooldown runs', overrides: {
      reason: { code: PLAN_REASON_CODES.cooldownShedding, remainingSec: 30 } } },
    { name: 'the restore cooldown runs', overrides: {
      reason: { code: PLAN_REASON_CODES.cooldownRestore, remainingSec: 120 } } },
    { name: 'its demand has ended', overrides: { hasStandingDemand: false } },
    { name: 'PELS cannot command it', overrides: { commandAuthority: false } },
    { name: 'a non-capacity hold lowered it', overrides: { nonCapacityHoldShed: true as const } },
    { name: 'it tracks solar surplus', overrides: { surplusTracking: true } },
    { name: 'the stepped fairness hold states its rule', overrides: {
      steppedFairnessHold: { stepId: 'low', limitedDeviceCount: 1 } } },
  ])('does not hold it when $name', ({ overrides }) => {
    expect(stampOf(heater(overrides))).toBeUndefined();
  });
});
