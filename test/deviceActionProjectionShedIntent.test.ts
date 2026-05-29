import { resolveShedIntent } from '../lib/device/deviceActionProjection';
import type { TargetCapabilitySnapshot } from '../packages/contracts/src/types';

const target = (
  overrides: Partial<TargetCapabilitySnapshot> = {},
): TargetCapabilitySnapshot => ({
  id: 'target_temperature',
  value: 21,
  min: 5,
  max: 30,
  step: 0.5,
  unit: '°C',
  ...overrides,
});

const steppedProfile = {
  model: 'stepped_load' as const,
  steps: [
    { id: 'off', planningPowerW: 0, restoreFromOff: false },
    { id: 'low', planningPowerW: 800, restoreFromOff: true },
    { id: 'high', planningPowerW: 2000, restoreFromOff: false },
  ],
};

describe('resolveShedIntent', () => {
  it('returns turn_off for a simple binary device with shedBehavior turn_off', () => {
    expect(resolveShedIntent({
      shedBehavior: { action: 'turn_off', temperature: null, stepId: null },
      controllable: true,
      hasBinaryControl: true,
    })).toEqual({ kind: 'turn_off' });
  });

  it('returns set_temperature with normalised setpoint when behaviour is set_temperature and a primary target exists', () => {
    expect(resolveShedIntent({
      shedBehavior: { action: 'set_temperature', temperature: 17.3, stepId: null },
      controllable: true,
      hasBinaryControl: true,
      primaryTarget: target({ step: 0.5 }),
    })).toEqual({ kind: 'set_temperature', temperature: 17.5 });
  });

  it('clamps the setpoint to the target capability min/max', () => {
    expect(resolveShedIntent({
      shedBehavior: { action: 'set_temperature', temperature: 100, stepId: null },
      controllable: true,
      hasBinaryControl: true,
      primaryTarget: target({ min: 5, max: 28 }),
    })).toEqual({ kind: 'set_temperature', temperature: 28 });
  });

  it('falls back to turn_off when set_temperature is configured but no primary target exists', () => {
    expect(resolveShedIntent({
      shedBehavior: { action: 'set_temperature', temperature: 18, stepId: null },
      controllable: true,
      hasBinaryControl: true,
      primaryTarget: null,
    })).toEqual({ kind: 'turn_off' });
  });

  it('falls back to turn_off when set_temperature has a null temperature', () => {
    expect(resolveShedIntent({
      shedBehavior: { action: 'set_temperature', temperature: null, stepId: null },
      controllable: true,
      hasBinaryControl: true,
      primaryTarget: target(),
    })).toEqual({ kind: 'turn_off' });
  });

  it('returns set_step with the configured stepId resolved when behaviour is set_step on a stepped device', () => {
    expect(resolveShedIntent({
      shedBehavior: { action: 'set_step', temperature: null, stepId: 'low' },
      controllable: true,
      hasBinaryControl: true,
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
    })).toEqual({ kind: 'set_step', targetStepId: 'low' });
  });

  it('falls back to the lowest active step when the configured stepId is null', () => {
    expect(resolveShedIntent({
      shedBehavior: { action: 'set_step', temperature: null, stepId: null },
      controllable: true,
      hasBinaryControl: false,
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
    })).toEqual({ kind: 'set_step', targetStepId: 'low' });
  });

  it('falls back to the lowest active step when the configured stepId is unknown', () => {
    expect(resolveShedIntent({
      shedBehavior: { action: 'set_step', temperature: null, stepId: 'does_not_exist' },
      controllable: true,
      hasBinaryControl: false,
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
    })).toEqual({ kind: 'set_step', targetStepId: 'low' });
  });

  it('returns set_step for a stepped device with no binary control regardless of behaviour action', () => {
    expect(resolveShedIntent({
      shedBehavior: { action: 'turn_off', temperature: null, stepId: null },
      controllable: true,
      hasBinaryControl: false,
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
    })).toEqual({ kind: 'set_step', targetStepId: 'low' });
  });

  it('returns turn_off for a stepped device with binary control and turn_off behaviour', () => {
    expect(resolveShedIntent({
      shedBehavior: { action: 'turn_off', temperature: null, stepId: null },
      controllable: true,
      hasBinaryControl: true,
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
    })).toEqual({ kind: 'turn_off' });
  });

  it('returns turn_off for a non-stepped device even when set_step is configured', () => {
    expect(resolveShedIntent({
      shedBehavior: { action: 'set_step', temperature: null, stepId: 'low' },
      controllable: true,
      hasBinaryControl: true,
    })).toEqual({ kind: 'turn_off' });
  });

  it('returns turn_off when controlModel is stepped but steppedLoadProfile.model mismatches', () => {
    expect(resolveShedIntent({
      shedBehavior: { action: 'set_step', temperature: null, stepId: 'low' },
      controllable: false,
      hasBinaryControl: false,
      controlModel: 'stepped_load',
      // @ts-expect-error - exercising the runtime guard for a malformed profile
      steppedLoadProfile: { model: 'not_stepped_load', steps: [] },
    })).toEqual({ kind: 'turn_off' });
  });

  // PR A: controllable folded into producer
  describe('controllable fold (PR A)', () => {
    it('collapses set_temperature to turn_off when controllable=false (non-stepped)', () => {
      expect(resolveShedIntent({
        shedBehavior: { action: 'set_temperature', temperature: 17, stepId: null },
        controllable: false,
        hasBinaryControl: true,
        primaryTarget: target(),
      })).toEqual({ kind: 'turn_off' });
    });

    it('collapses set_temperature to turn_off when controllable=false (stepped + binary)', () => {
      expect(resolveShedIntent({
        shedBehavior: { action: 'set_temperature', temperature: 17, stepId: null },
        controllable: false,
        hasBinaryControl: true,
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
        primaryTarget: target(),
      })).toEqual({ kind: 'turn_off' });
    });

    it('keeps set_step for cap-off stepped device with no binary control (no other handle)', () => {
      expect(resolveShedIntent({
        shedBehavior: { action: 'set_step', temperature: null, stepId: null },
        controllable: false,
        hasBinaryControl: false,
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })).toEqual({ kind: 'set_step', targetStepId: 'low' });
    });

    it('collapses set_step to turn_off when controllable=false on stepped+binary device', () => {
      expect(resolveShedIntent({
        shedBehavior: { action: 'set_step', temperature: null, stepId: null },
        controllable: false,
        hasBinaryControl: true,
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfile,
      })).toEqual({ kind: 'turn_off' });
    });
  });
});
