import { isNonSteppedDeviceRecovering } from '../../lib/plan/planShedRecovery';
import type { PlanEngineState } from '../../lib/plan/planState';
import { buildPlanInputDevice, steppedInputDevice } from '../utils/planTestUtils';

type RecoveryState = Pick<PlanEngineState, 'shedDecidedMs' | 'lastDeviceRestoreMs' | 'swapByDevice'>;

const buildState = (overrides: Partial<RecoveryState> = {}): RecoveryState => ({
  shedDecidedMs: {},
  lastDeviceRestoreMs: {},
  swapByDevice: {},
  ...overrides,
});

describe('isNonSteppedDeviceRecovering', () => {
  it('is false for an uncontrollable device', () => {
    const device = buildPlanInputDevice({ id: 'a', controllable: false, currentState: 'off' });
    expect(isNonSteppedDeviceRecovering(device, buildState())).toBe(false);
  });

  it('is false for a stepped-load device even when observed off', () => {
    const device = steppedInputDevice({ id: 'a', selectedStepId: 'off' });
    expect(isNonSteppedDeviceRecovering(device, buildState({
      shedDecidedMs: { a: 1000 },
    }))).toBe(false);
  });

  it('is false when the device is not observed off', () => {
    const device = buildPlanInputDevice({ id: 'a', currentState: 'on' });
    expect(isNonSteppedDeviceRecovering(device, buildState({
      shedDecidedMs: { a: 1000 },
    }))).toBe(false);
  });

  it('is true for an observed-off device that is swapped out', () => {
    const device = buildPlanInputDevice({ id: 'a', currentState: 'off' });
    expect(isNonSteppedDeviceRecovering(device, buildState({
      swapByDevice: { a: { swappedOutFor: 'b' } },
    }))).toBe(true);
  });

  it('is true for an observed-off device with a pending swap target', () => {
    const device = buildPlanInputDevice({ id: 'a', currentState: 'off' });
    expect(isNonSteppedDeviceRecovering(device, buildState({
      swapByDevice: { a: { pendingTarget: true } },
    }))).toBe(true);
  });

  it('is false when observed off but never shed and not swapped', () => {
    const device = buildPlanInputDevice({ id: 'a', currentState: 'off' });
    expect(isNonSteppedDeviceRecovering(device, buildState())).toBe(false);
  });

  it('is true when shed and not yet restored', () => {
    const device = buildPlanInputDevice({ id: 'a', currentState: 'off' });
    expect(isNonSteppedDeviceRecovering(device, buildState({
      shedDecidedMs: { a: 1000 },
      lastDeviceRestoreMs: { a: 500 },
    }))).toBe(true);
  });

  it('is true when shed and never restored', () => {
    const device = buildPlanInputDevice({ id: 'a', currentState: 'off' });
    expect(isNonSteppedDeviceRecovering(device, buildState({
      shedDecidedMs: { a: 1000 },
    }))).toBe(true);
  });

  it('is false when restored at or after the latest shed decision', () => {
    const device = buildPlanInputDevice({ id: 'a', currentState: 'off' });
    expect(isNonSteppedDeviceRecovering(device, buildState({
      shedDecidedMs: { a: 1000 },
      lastDeviceRestoreMs: { a: 1000 },
    }))).toBe(false);
  });
});
