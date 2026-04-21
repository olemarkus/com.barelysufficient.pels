import type {
  DevicePlanDevice,
  PlanInputDevice,
} from '../../lib/plan/planTypes';
import type { SteppedLoadProfile } from '../../lib/utils/types';
import { legacyDeviceReason } from './deviceReasonTestUtils.ts';

export const steppedProfile: SteppedLoadProfile = {
  model: 'stepped_load',
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'medium', planningPowerW: 2000 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

export const buildPlanDevice = (overrides: Partial<DevicePlanDevice> & { reason?: DevicePlanDevice['reason'] | string } = {}):
DevicePlanDevice => {
  const { reason, ...rest } = overrides;
  return {
    id: 'dev',
    name: 'Device',
    currentState: 'on',
    plannedState: 'keep',
    currentTarget: null,
    plannedTarget: null,
    reason: legacyDeviceReason('keep')!,
    ...rest,
    ...(reason !== undefined
      ? { reason: typeof reason === 'string' ? legacyDeviceReason(reason)! : reason }
      : {}),
  };
};

export const buildPlanInputDevice = (overrides: Partial<PlanInputDevice> = {}): PlanInputDevice => ({
  id: 'dev',
  name: 'Device',
  targets: [],
  currentOn: true,
  controllable: true,
  ...overrides,
});

export const steppedPlanDevice = (overrides: Partial<DevicePlanDevice> = {}): DevicePlanDevice => {
  const profile = overrides.steppedLoadProfile ?? steppedProfile;
  const selectedStepId = overrides.selectedStepId ?? 'max';
  const step = profile.steps.find((s) => s.id === selectedStepId);
  const defaultPlanningKw = step ? step.planningPowerW / 1000 : 0;

  return buildPlanDevice({
    controlModel: 'stepped_load',
    steppedLoadProfile: profile,
    selectedStepId,
    planningPowerKw: defaultPlanningKw,
    ...overrides,
  });
};

export const steppedInputDevice = (overrides: Partial<PlanInputDevice> = {}): PlanInputDevice => {
  const profile = overrides.steppedLoadProfile ?? steppedProfile;
  const selectedStepId = overrides.selectedStepId ?? 'max';
  const step = profile?.steps.find((s) => s.id === selectedStepId);
  const defaultPlanningKw = step ? step.planningPowerW / 1000 : 0;

  return buildPlanInputDevice({
    controlModel: 'stepped_load',
    steppedLoadProfile: profile,
    selectedStepId,
    planningPowerKw: defaultPlanningKw,
    hasBinaryControl: true,
    targets: [{ id: 'target_temperature', value: 65, unit: '°C' }],
    ...overrides,
  });
};
