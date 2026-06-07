import type {
  DevicePlanDevice,
  PlanInputDevice,
} from '../../lib/plan/planTypes';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import { resolveEvCommandability } from '../../packages/shared-domain/src/commandableNow';
import { legacyDeviceReason } from './deviceReasonTestUtils.ts';

/**
 * Materialize `evCommandability` from a raw `evChargingState` exactly as the
 * production producer (`setup/appInit/toPlanDevice.ts`) does, so EV fixtures can
 * keep their readable `evChargingState: 'plugged_out'` inputs while the plan
 * devices they build carry the producer-resolved decisions the planner reads.
 * The raw `evChargingState` is dropped — the observer owns it, not the planner.
 */
export const withMaterializedEvCommandability = <T extends { deviceClass?: string; controlCapabilityId?: string }>(
  overrides: T & { evChargingState?: string },
): Omit<T, 'evChargingState'> & { evCommandability?: ReturnType<typeof resolveEvCommandability> } => {
  const { evChargingState, ...rest } = overrides;
  if (evChargingState === undefined && !('evChargingState' in overrides)) return rest;
  return { ...rest, evCommandability: resolveEvCommandability({ ...rest, evChargingState }) };
};

export const steppedProfile: SteppedLoadProfile = {
  model: 'stepped_load',
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'medium', planningPowerW: 2000 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

export const buildPlanDevice = (
  overrides: Partial<DevicePlanDevice> & { reason?: DevicePlanDevice['reason'] | string; evChargingState?: string } = {},
):
DevicePlanDevice => {
  const { reason, ...rest } = overrides;
  return {
    id: 'dev',
    name: 'Device',
    currentState: 'on',
    plannedState: 'keep',
    currentTarget: null,
    controlCapabilityId: 'onoff',
    reason: legacyDeviceReason('keep')!,
    ...withMaterializedEvCommandability(rest),
    ...(reason !== undefined
      ? { reason: typeof reason === 'string' ? legacyDeviceReason(reason)! : reason }
      : {}),
  };
};

export const buildPlanInputDevice = (
  overrides: Partial<PlanInputDevice> & { evChargingState?: string } = {},
): PlanInputDevice => ({
  id: 'dev',
  name: 'Device',
  targets: [],
  binaryControl: { on: true },
  controllable: true,
  controlCapabilityId: 'onoff',
  ...withMaterializedEvCommandability(overrides),
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

export const steppedInputDevice = (
  overrides: Partial<PlanInputDevice> & { evChargingState?: string } = {},
): PlanInputDevice => {
  const profile = overrides.steppedLoadProfile ?? steppedProfile;
  const selectedStepId = overrides.selectedStepId ?? 'max';
  const step = profile?.steps.find((s) => s.id === selectedStepId);
  const defaultPlanningKw = step ? step.planningPowerW / 1000 : 0;

  return buildPlanInputDevice({
    controlModel: 'stepped_load',
    steppedLoadProfile: profile,
    selectedStepId,
    planningPowerKw: defaultPlanningKw,
    controlCapabilityId: 'onoff',
    targets: [{ id: 'target_temperature', value: 65, unit: '°C' }],
    ...overrides,
  });
};
