import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import {
  isSteppedDeviceAtActiveStep,
  isSteppedDeviceAtOffStep,
} from '../../lib/utils/deviceControlProfiles';
import {
  isPlanDeviceObservedOff,
  isPlanDeviceObservedOn,
  resolveSteppedKeepDesiredStepId,
} from '../../lib/plan/planSteppedLoad';
import {
  isActivationObservationActiveNow,
  isActivationObservationExplicitlyInactive,
} from '../../lib/plan/admission/activationBackoff';
import { sumControlledUsageKw } from '../../lib/plan/planUsage';
import { withHeadroomCurrentOn } from '../../lib/plan/planHeadroomSupport';

// A step-only stepper: a `target_power`-style load with a stepped profile but NO
// binary handle (`controlCapabilityId === undefined`, so `currentOn === undefined`).
// Its on/off lives ENTIRELY on the step axis. These tests pin that the predicates
// every step-only fix routes through resolve it from the step, not the (absent)
// binary truth.
const profile: SteppedLoadProfile = {
  model: 'stepped_load',
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'high', planningPowerW: 3000 },
  ],
};

describe('isSteppedDeviceAtOffStep / isSteppedDeviceAtActiveStep', () => {
  it('partitions off / active / unknown cleanly', () => {
    expect(isSteppedDeviceAtOffStep({ steppedLoadProfile: profile, selectedStepId: 'off' })).toBe(true);
    expect(isSteppedDeviceAtActiveStep({ steppedLoadProfile: profile, selectedStepId: 'off' })).toBe(false);

    expect(isSteppedDeviceAtOffStep({ steppedLoadProfile: profile, selectedStepId: 'low' })).toBe(false);
    expect(isSteppedDeviceAtActiveStep({ steppedLoadProfile: profile, selectedStepId: 'low' })).toBe(true);
  });

  it('answers false to BOTH for an unknown / missing / unprofiled step', () => {
    expect(isSteppedDeviceAtOffStep({ steppedLoadProfile: profile, selectedStepId: 'ghost' })).toBe(false);
    expect(isSteppedDeviceAtActiveStep({ steppedLoadProfile: profile, selectedStepId: 'ghost' })).toBe(false);
    expect(isSteppedDeviceAtOffStep({ steppedLoadProfile: profile })).toBe(false);
    expect(isSteppedDeviceAtActiveStep({ steppedLoadProfile: profile })).toBe(false);
    expect(isSteppedDeviceAtOffStep({ selectedStepId: 'low' })).toBe(false);
    expect(isSteppedDeviceAtActiveStep({ selectedStepId: 'low' })).toBe(false);
  });
});

describe('isPlanDeviceObservedOff / isPlanDeviceObservedOn — kind-aware on/off', () => {
  it('reads the binary truth for a binary device', () => {
    const off = { controlCapabilityId: 'onoff' as const, currentOn: false };
    const on = { controlCapabilityId: 'onoff' as const, currentOn: true };
    expect(isPlanDeviceObservedOff(off)).toBe(true);
    expect(isPlanDeviceObservedOn(off)).toBe(false);
    expect(isPlanDeviceObservedOff(on)).toBe(false);
    expect(isPlanDeviceObservedOn(on)).toBe(true);
  });

  it('reads a binary+stepped device via currentOn (which already folds step-off)', () => {
    // currentOn is the resolved truth here; the step fields must NOT double-resolve.
    const binarySteppedOff = {
      controlCapabilityId: 'onoff' as const, currentOn: false,
      steppedLoadProfile: profile, selectedStepId: 'low',
    };
    expect(isPlanDeviceObservedOff(binarySteppedOff)).toBe(true);
    expect(isPlanDeviceObservedOn(binarySteppedOff)).toBe(false);
  });

  it('reads a STEP-ONLY stepper from the step axis', () => {
    const atOff = { steppedLoadProfile: profile, selectedStepId: 'off' };
    const atLow = { steppedLoadProfile: profile, selectedStepId: 'low' };
    const atUnknown = { steppedLoadProfile: profile, selectedStepId: undefined };

    expect(isPlanDeviceObservedOff(atOff)).toBe(true);
    expect(isPlanDeviceObservedOn(atOff)).toBe(false);

    expect(isPlanDeviceObservedOff(atLow)).toBe(false);
    expect(isPlanDeviceObservedOn(atLow)).toBe(true);

    // A binary device is never "unknown", but a step-only stepper at an unknown
    // step is neither off nor on (the step axis can't decide).
    expect(isPlanDeviceObservedOff(atUnknown)).toBe(false);
    expect(isPlanDeviceObservedOn(atUnknown)).toBe(false);
  });

  it('treats a device with neither a binary handle nor a step as off=false / on=false', () => {
    expect(isPlanDeviceObservedOff({})).toBe(false);
    expect(isPlanDeviceObservedOn({})).toBe(false);
  });
});

describe('activation backoff observation — step-only steppers', () => {
  it('detects a step-only stepper at its off step as explicitly inactive', () => {
    expect(isActivationObservationExplicitlyInactive({
      currentOn: undefined, steppedLoadProfile: profile, selectedStepId: 'off',
    })).toBe(true);
    // at an active step it is NOT inactive
    expect(isActivationObservationExplicitlyInactive({
      currentOn: undefined, steppedLoadProfile: profile, selectedStepId: 'low',
    })).toBe(false);
  });

  it('detects a step-only stepper at an active step as active-now without needing a measurement', () => {
    expect(isActivationObservationActiveNow({
      currentOn: undefined, steppedLoadProfile: profile, selectedStepId: 'low',
    })).toBe(true);
    // at the off step, with no measured draw, it is not active
    expect(isActivationObservationActiveNow({
      currentOn: undefined, steppedLoadProfile: profile, selectedStepId: 'off',
    })).toBe(false);
  });

  it('falls back to the currentState label for a label-only observation (restore caller)', () => {
    // The restore caller builds the observation with `currentState` but no step
    // fields, so a step-only stepper must still be classified from the label.
    expect(isActivationObservationExplicitlyInactive({ currentOn: undefined, currentState: 'off' })).toBe(true);
    expect(isActivationObservationActiveNow({ currentOn: undefined, currentState: 'on' })).toBe(true);
    expect(isActivationObservationExplicitlyInactive({ currentOn: undefined, currentState: 'on' })).toBe(false);
  });

  it('leaves binary observation reasoning unchanged', () => {
    expect(isActivationObservationExplicitlyInactive({ currentOn: false })).toBe(true);
    expect(isActivationObservationExplicitlyInactive({ currentOn: true })).toBe(false);
    expect(isActivationObservationActiveNow({ currentOn: true })).toBe(true);
    expect(isActivationObservationActiveNow({ currentOn: false })).toBe(false);
  });
});

describe('resolveSteppedKeepDesiredStepId — step-only steppers keep their step-down', () => {
  // Regression: a step-only stepper has no `currentOn`, so a strict
  // `currentOn === true/false` skipped BOTH branches and fell through to the
  // reported-step path, abandoning an in-flight step-down toward `desiredStepId`.
  it('honours an in-flight step-down (reported high, desired low) for a step-only stepper', () => {
    expect(resolveSteppedKeepDesiredStepId({
      steppedLoadProfile: profile,
      selectedStepId: 'high',
      desiredStepId: 'low',
      plannedState: 'keep',
      // step-only: no controlCapabilityId, no currentOn
    })).toBe('low');
  });

  it('returns the lowest active step for a step-only stepper parked at its off step', () => {
    expect(resolveSteppedKeepDesiredStepId({
      steppedLoadProfile: profile,
      selectedStepId: 'off',
      desiredStepId: 'off',
      plannedState: 'keep',
    })).toBe('low');
  });

  it('is unchanged for a binary+stepped device (routes through currentOn)', () => {
    expect(resolveSteppedKeepDesiredStepId({
      controlCapabilityId: 'onoff',
      currentOn: true,
      steppedLoadProfile: profile,
      selectedStepId: 'high',
      desiredStepId: 'low',
      plannedState: 'keep',
    })).toBe('low');
  });
});

describe('raw-snapshot currentOn stamping (powerSample / headroom seams)', () => {
  // A raw TargetDeviceSnapshot carries `binaryControl` but no plan-stamped
  // `currentOn`. Reading `!currentOn` directly treats an idle-but-ON binary device
  // as off (and charges expected kW). The seam stamps `currentOn` first.
  it('stamps currentOn from binaryControl so the on/off read is correct', () => {
    const stampedOn = withHeadroomCurrentOn({ controlCapabilityId: 'onoff', binaryControl: { on: true } });
    expect(stampedOn.currentOn).toBe(true);
    expect(isPlanDeviceObservedOff(stampedOn)).toBe(false);

    const stampedOff = withHeadroomCurrentOn({ controlCapabilityId: 'onoff', binaryControl: { on: false } });
    expect(stampedOff.currentOn).toBe(false);
    expect(isPlanDeviceObservedOff(stampedOff)).toBe(true);
  });
});

describe('sumControlledUsageKw — step-only steppers', () => {
  it('counts a shed step-only stepper parked at its off step as 0, not unknown', () => {
    const total = sumControlledUsageKw([{
      controllable: true,
      plannedState: 'shed',
      steppedLoadProfile: profile,
      selectedStepId: 'off',
      // no currentOn (step-only), no measuredPowerKw
    }]);
    expect(total).toBe(0);
  });

  it('attributes a keep step-only stepper at an active step via the on-usage path', () => {
    const total = sumControlledUsageKw([{
      controllable: true,
      plannedState: 'keep',
      steppedLoadProfile: profile,
      selectedStepId: 'low',
      expectedPowerKw: 1.25,
    }]);
    expect(total).toBe(1.25);
  });
});
