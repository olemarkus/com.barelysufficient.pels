import {
  getSteppedLoadNextRestoreStep,
  getSteppedLoadShedTargetStep,
  isSteppedLoadDevice,
  resolveSteppedLoadCurrentState,
  resolveSteppedLoadImmediateReliefKw,
  resolveSteppedLoadInitialDesiredStepId,
  resolveSteppedLoadPlanningKw,
  resolveSteppedLoadRestoreDeltaKw,
} from '../lib/plan/planSteppedLoad';

const steppedProfile = {
  model: 'stepped_load' as const,
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

const steppedDevice = (overrides: Record<string, unknown> = {}) => ({
  controlModel: 'stepped_load' as const,
  steppedLoadProfile: steppedProfile,
  selectedStepId: 'max',
  desiredStepId: undefined,
  measuredPowerKw: 2.4,
  ...overrides,
});

describe('planSteppedLoad', () => {
  it('detects stepped-load devices and resolves current state', () => {
    expect(isSteppedLoadDevice(steppedDevice())).toBe(true);
    expect(isSteppedLoadDevice({ controlModel: 'binary_power', steppedLoadProfile: null })).toBe(false);

    expect(resolveSteppedLoadCurrentState({ controlModel: 'binary_power', steppedLoadProfile: null, selectedStepId: 'off' }))
      .toBeNull();
    expect(resolveSteppedLoadCurrentState(steppedDevice({ selectedStepId: undefined }))).toBe('unknown');
    expect(resolveSteppedLoadCurrentState(steppedDevice({ selectedStepId: 'off' }))).toBe('off');
    expect(resolveSteppedLoadCurrentState(steppedDevice({ selectedStepId: 'low' }))).toBe('on');
  });

  it('resolves initial desired step and next restore step', () => {
    expect(resolveSteppedLoadInitialDesiredStepId(
      steppedDevice({ selectedStepId: 'low' }),
    )).toBe('low');
    expect(resolveSteppedLoadInitialDesiredStepId(
      steppedDevice({ selectedStepId: 'missing' }),
    )).toBeUndefined();
    expect(resolveSteppedLoadInitialDesiredStepId({
      controlModel: 'binary_power',
      steppedLoadProfile: null,
      selectedStepId: 'low',
    })).toBeUndefined();

    expect(getSteppedLoadNextRestoreStep(steppedDevice({ selectedStepId: 'off' }))?.id).toBe('low');
    expect(getSteppedLoadNextRestoreStep(steppedDevice({ selectedStepId: 'low' }))?.id).toBe('max');
    expect(getSteppedLoadNextRestoreStep(steppedDevice({ selectedStepId: 'max' }))).toBeNull();
    expect(getSteppedLoadNextRestoreStep({
      controlModel: 'binary_power',
      steppedLoadProfile: null,
      selectedStepId: 'off',
    })).toBeNull();
  });

  it('resolves shed targets conservatively for turn-off and set-step behavior', () => {
    expect(getSteppedLoadShedTargetStep({
      device: steppedDevice({ selectedStepId: 'max' }),
      shedAction: 'set_step',
      shedStepId: 'low',
    })?.id).toBe('low');

    expect(getSteppedLoadShedTargetStep({
      device: steppedDevice({ selectedStepId: 'low' }),
      shedAction: 'set_step',
      shedStepId: 'max',
    })?.id).toBe('low');

    expect(getSteppedLoadShedTargetStep({
      device: steppedDevice({ selectedStepId: 'max' }),
      shedAction: 'turn_off',
    })?.id).toBe('off');

    const noOffProfile = {
      model: 'stepped_load' as const,
      steps: [
        { id: 'eco', planningPowerW: 900 },
        { id: 'boost', planningPowerW: 1800 },
      ],
    };
    expect(getSteppedLoadShedTargetStep({
      device: {
        controlModel: 'stepped_load',
        steppedLoadProfile: noOffProfile,
        selectedStepId: 'boost',
      },
      shedAction: 'turn_off',
    })?.id).toBe('eco');

    expect(getSteppedLoadShedTargetStep({
      device: {
        controlModel: 'binary_power',
        steppedLoadProfile: null,
        selectedStepId: 'max',
      },
      shedAction: 'turn_off',
    })).toBeNull();

    expect(getSteppedLoadShedTargetStep({
      device: steppedDevice({ selectedStepId: 'missing' }),
      shedAction: 'turn_off',
    })).toBeNull();
  });

  it('uses planning power for restore math and measured power for immediate shed relief', () => {
    expect(resolveSteppedLoadPlanningKw(steppedDevice(), 'max')).toBe(3);
    expect(resolveSteppedLoadPlanningKw(steppedDevice(), 'missing')).toBe(0);
    expect(resolveSteppedLoadPlanningKw({
      controlModel: 'binary_power',
      steppedLoadProfile: null,
    }, 'max')).toBe(0);

    expect(resolveSteppedLoadImmediateReliefKw({
      device: steppedDevice({ measuredPowerKw: 2.4 }),
      fromStepId: 'max',
      toStepId: 'low',
    })).toBeCloseTo(1.15, 6);
    expect(resolveSteppedLoadImmediateReliefKw({
      device: steppedDevice({ measuredPowerKw: undefined }),
      fromStepId: 'max',
      toStepId: 'low',
    })).toBe(0);
    expect(resolveSteppedLoadImmediateReliefKw({
      device: {
        controlModel: 'binary_power',
        steppedLoadProfile: null,
        measuredPowerKw: 2,
      },
      fromStepId: 'max',
      toStepId: 'low',
    })).toBe(0);

    expect(resolveSteppedLoadRestoreDeltaKw({
      device: steppedDevice(),
      fromStepId: 'low',
      toStepId: 'max',
    })).toBeCloseTo(1.75, 6);
    expect(resolveSteppedLoadRestoreDeltaKw({
      device: steppedDevice(),
      fromStepId: 'max',
      toStepId: 'low',
    })).toBe(0);
    expect(resolveSteppedLoadRestoreDeltaKw({
      device: {
        controlModel: 'binary_power',
        steppedLoadProfile: null,
      },
      fromStepId: 'low',
      toStepId: 'max',
    })).toBe(0);
  });
});
