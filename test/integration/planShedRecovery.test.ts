import { isNonSteppedDeviceRecovering } from '../../lib/plan/planShedRecovery';
import type { PlanEngineState } from '../../lib/plan/planState';
import { seedSwapReservation } from '../utils/swapLedgerFixture';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { buildPlanInputDevice, steppedInputDevice } from '../utils/planTestUtils';

const buildState = (overrides: {
  lastPlannedShedIds?: readonly string[];
  swapReservation?: { targetId: string; donorIds?: readonly string[] };
} = {}): PlanEngineState => {
  const state = createPlanEngineState();
  state.shedDecisions.lastPlannedShedIds = new Set(overrides.lastPlannedShedIds);
  if (overrides.swapReservation) seedSwapReservation(state, overrides.swapReservation);
  return state;
};

describe('isNonSteppedDeviceRecovering', () => {
  it('is false for an uncontrollable device', () => {
    const device = buildPlanInputDevice({ id: 'a', controllable: false, currentState: 'off' });
    expect(isNonSteppedDeviceRecovering(device, buildState())).toBe(false);
  });

  it('is false for a stepped-load device even when observed off', () => {
    const device = steppedInputDevice({ id: 'a', selectedStepId: 'off' });
    expect(isNonSteppedDeviceRecovering(device, buildState({
      lastPlannedShedIds: ['a'],
    }))).toBe(false);
  });

  it('is false when the device is not observed off', () => {
    const device = buildPlanInputDevice({ id: 'a', currentState: 'on' });
    expect(isNonSteppedDeviceRecovering(device, buildState({
      lastPlannedShedIds: ['a'],
    }))).toBe(false);
  });

  it('is true for an observed-off device that is swapped out', () => {
    const device = buildPlanInputDevice({ id: 'a', currentState: 'off' });
    expect(isNonSteppedDeviceRecovering(device, buildState({
      swapReservation: { targetId: 'b', donorIds: ['a'] },
    }))).toBe(true);
  });

  it('is true for an observed-off device with a pending swap target', () => {
    const device = buildPlanInputDevice({ id: 'a', currentState: 'off' });
    expect(isNonSteppedDeviceRecovering(device, buildState({
      swapReservation: { targetId: 'a' },
    }))).toBe(true);
  });

  it('is false when observed off but never shed and not swapped', () => {
    const device = buildPlanInputDevice({ id: 'a', currentState: 'off' });
    expect(isNonSteppedDeviceRecovering(device, buildState())).toBe(false);
  });

  it('is true while the previous plan still holds it shed', () => {
    const device = buildPlanInputDevice({ id: 'a', currentState: 'off' });
    expect(isNonSteppedDeviceRecovering(device, buildState({
      lastPlannedShedIds: ['a'],
    }))).toBe(true);
  });
});
