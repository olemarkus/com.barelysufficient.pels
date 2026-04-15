import {
  getSteppedLoadNextRestoreStep,
  getSteppedLoadShedTargetStep,
  isSteppedLoadDevice,
  resolveSteppedKeepDesiredStepId,
  resolveSteppedLoadCurrentState,
  resolveSteppedLoadImmediateReliefKw,
  resolveSteppedLoadInitialDesiredStepId,
  resolveSteppedLoadRestoreDeltaKw,
  resolveSteppedLoadSheddingTarget,
} from '../lib/plan/planSteppedLoad';
import { steppedInputDevice, steppedPlanDevice, steppedProfile } from './utils/planTestUtils';

describe('planSteppedLoad', () => {
  it('resolves initial desired step and next restore step', () => {
    expect(resolveSteppedLoadInitialDesiredStepId(steppedInputDevice({ selectedStepId: 'low' }))).toBe('low');
    expect(resolveSteppedLoadInitialDesiredStepId(steppedInputDevice({ selectedStepId: undefined }))).toBeUndefined();
    expect(resolveSteppedLoadInitialDesiredStepId(steppedInputDevice({
      controlModel: 'binary_power',
      steppedLoadProfile: undefined,
      selectedStepId: 'low',
    }))).toBeUndefined();

    expect(getSteppedLoadNextRestoreStep(steppedInputDevice({ selectedStepId: 'off' }))?.id).toBe('low');
    expect(getSteppedLoadNextRestoreStep(steppedInputDevice({ selectedStepId: 'medium' }))?.id).toBe('max');
    expect(getSteppedLoadNextRestoreStep(steppedPlanDevice({
      selectedStepId: 'medium',
      currentState: 'off',
    }))?.id).toBe('medium');
    expect(getSteppedLoadNextRestoreStep(steppedPlanDevice({
      selectedStepId: undefined as unknown as string,
      currentState: 'off',
    }))?.id).toBe('low');
    expect(getSteppedLoadNextRestoreStep(steppedInputDevice({ selectedStepId: 'max' }))).toBeNull();
    expect(getSteppedLoadNextRestoreStep(steppedInputDevice({
      controlModel: 'binary_power',
      steppedLoadProfile: undefined,
      selectedStepId: 'off',
    }))).toBeNull();

    expect(resolveSteppedKeepDesiredStepId(steppedPlanDevice({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: undefined as unknown as string,
      desiredStepId: 'max',
    }))).toBe('low');
    expect(resolveSteppedKeepDesiredStepId(steppedPlanDevice({
      currentState: 'off',
      plannedState: 'keep',
      selectedStepId: 'medium',
      desiredStepId: 'max',
    }))).toBe('medium');
    expect(resolveSteppedKeepDesiredStepId(steppedPlanDevice({
      currentState: 'unknown',
      plannedState: 'keep',
      selectedStepId: 'medium',
      desiredStepId: 'max',
    }))).toBe('medium');
    expect(resolveSteppedKeepDesiredStepId(steppedPlanDevice({
      currentState: 'unknown',
      plannedState: 'keep',
      selectedStepId: undefined as unknown as string,
      desiredStepId: 'max',
    }))).toBe('low');
  });

  it('resolves shed targets conservatively for turn-off and set-step behavior', () => {
    expect(getSteppedLoadShedTargetStep({
      device: steppedInputDevice({ selectedStepId: 'max' }),
      shedAction: 'set_step',
    })?.id).toBe('medium');

    expect(getSteppedLoadShedTargetStep({
      device: steppedInputDevice({ selectedStepId: 'medium' }),
      shedAction: 'set_step',
    })?.id).toBe('low');

    expect(getSteppedLoadShedTargetStep({
      device: steppedInputDevice({ selectedStepId: 'low' }),
      shedAction: 'set_step',
    })?.id).toBe('low');

    expect(getSteppedLoadShedTargetStep({
      device: steppedInputDevice({ selectedStepId: 'max' }),
      shedAction: 'turn_off',
    })?.id).toBe('medium');

    expect(getSteppedLoadShedTargetStep({
      device: steppedPlanDevice({ selectedStepId: 'max', currentState: 'off' }),
      shedAction: 'turn_off',
    })?.id).toBe('off');

    expect(getSteppedLoadShedTargetStep({
      device: steppedInputDevice({ selectedStepId: 'low' }),
      shedAction: 'turn_off',
    })?.id).toBe('off');

    const noOffProfile = {
      model: 'stepped_load' as const,
      steps: [
        { id: 'low', planningPowerW: 1000 },
        { id: 'max', planningPowerW: 2000 },
      ],
    };
    expect(getSteppedLoadShedTargetStep({
      device: steppedInputDevice({ steppedLoadProfile: noOffProfile, selectedStepId: 'max' }),
      shedAction: 'turn_off',
    })?.id).toBe('low');

    expect(getSteppedLoadShedTargetStep({
      device: steppedInputDevice({ selectedStepId: 'max' }),
      shedAction: 'set_step',
    })?.id).toBe('medium');

    expect(getSteppedLoadShedTargetStep({
      device: steppedInputDevice({ selectedStepId: 'low' }),
      shedAction: 'set_step',
    })?.id).toBe('low');
  });

  it('resolves shedding target including profile and relief flags', () => {
    const targetStep = { id: 'low', planningPowerW: 1250 };
    const target = resolveSteppedLoadSheddingTarget({
      device: steppedInputDevice({ selectedStepId: 'max' }),
      targetStep,
    });

    expect(target?.steppedProfile).toBe(steppedProfile);
    expect(target?.selectedStep.id).toBe('max');
    expect(target?.clampedTargetStep.id).toBe('low');
    expect(target?.hasUnconfirmedLowerDesiredStep).toBe(false);

    const targetWithPending = resolveSteppedLoadSheddingTarget({
      device: steppedInputDevice({
        selectedStepId: 'max',
        stepCommandPending: true,
        desiredStepId: 'low',
      }),
      targetStep,
    });
    expect(targetWithPending?.hasUnconfirmedLowerDesiredStep).toBe(true);

    expect(resolveSteppedLoadSheddingTarget({
      device: steppedInputDevice({ controlModel: 'binary_power', steppedLoadProfile: undefined }),
      targetStep,
    })).toBeNull();

    const zeroOnlyProfile = {
      model: 'stepped_load' as const,
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'idle', planningPowerW: 0 },
      ],
    };
    expect(getSteppedLoadShedTargetStep({
      device: {
        controlModel: 'stepped_load',
        steppedLoadProfile: zeroOnlyProfile,
        selectedStepId: 'idle',
      },
      shedAction: 'set_step',
    })).toBeNull();
  });

  it('resolves current state from binary onoff or stepped profile', () => {
    expect(resolveSteppedLoadCurrentState(steppedInputDevice({ selectedStepId: undefined }))).toBe('unknown');
    expect(resolveSteppedLoadCurrentState(steppedInputDevice({ currentOn: true, selectedStepId: 'low' }))).toBe('on');
    expect(resolveSteppedLoadCurrentState(steppedInputDevice({ currentOn: false, selectedStepId: 'low' }))).toBe('off');
    expect(resolveSteppedLoadCurrentState(steppedInputDevice({ currentOn: true, selectedStepId: 'off' }))).toBe('off');
    expect(resolveSteppedLoadCurrentState(steppedInputDevice({ controlModel: 'binary_power', steppedLoadProfile: undefined, currentOn: true }))).toBe('on');
    expect(resolveSteppedLoadCurrentState(steppedInputDevice({ controlModel: 'binary_power', steppedLoadProfile: undefined, currentOn: false }))).toBe('off');
    expect(resolveSteppedLoadCurrentState(steppedInputDevice({ controlModel: 'binary_power', steppedLoadProfile: undefined, currentOn: true }))).toBe('on');
  });

  it('uses planning power for restore math and measured power for immediate shed relief', () => {
    expect(resolveSteppedLoadRestoreDeltaKw({
      device: steppedInputDevice(),
      fromStepId: 'low',
      toStepId: 'max',
    })).toBeCloseTo(1.75, 6);
    expect(resolveSteppedLoadRestoreDeltaKw({
      device: steppedPlanDevice({ currentState: 'off' }),
      fromStepId: 'medium',
      toStepId: 'low',
    })).toBeCloseTo(1.25, 6);
    expect(resolveSteppedLoadRestoreDeltaKw({
      device: steppedInputDevice(),
      fromStepId: 'max',
      toStepId: 'low',
    })).toBe(0);
    expect(resolveSteppedLoadRestoreDeltaKw({
      device: steppedInputDevice({
        controlModel: 'binary_power',
        steppedLoadProfile: undefined,
      }),
      fromStepId: 'low',
      toStepId: 'max',
    })).toBe(0);

    expect(resolveSteppedLoadImmediateReliefKw({
      device: steppedInputDevice({ measuredPowerKw: 2.5 }),
      toStepId: 'low',
    })).toBeCloseTo(1.25, 6);
    expect(resolveSteppedLoadImmediateReliefKw({
      device: steppedInputDevice({ selectedStepId: 'low', measuredPowerKw: 0.5, hasBinaryControl: false }),
      toStepId: 'off',
    })).toBeCloseTo(0.5, 6);
    expect(resolveSteppedLoadImmediateReliefKw({
      device: steppedInputDevice({
        controlModel: 'binary_power',
        steppedLoadProfile: undefined,
      }),
      toStepId: 'low',
    })).toBe(0);
  });

  it('isSteppedLoadDevice identifies stepped devices', () => {
    expect(isSteppedLoadDevice(steppedInputDevice())).toBe(true);
    expect(isSteppedLoadDevice(steppedInputDevice({ controlModel: 'binary_power', steppedLoadProfile: undefined }))).toBe(false);
  });
});
