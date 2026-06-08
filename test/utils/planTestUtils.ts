import type {
  DevicePlanDevice,
  PlanInputDevice,
  TemperatureDiscriminantProbe,
} from '../../lib/plan/planTypes';
import { withTemperatureDiscriminant } from '../../lib/plan/planTypes';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import { isEvDevice, resolveCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { legacyDeviceReason } from './deviceReasonTestUtils.ts';

/**
 * Treat a fixture's `currentTarget` / `currentTemperature` override as the
 * temperature-variant signal: a device carrying either is a temperature device,
 * so default `deviceType: 'temperature'` (unless the fixture set it explicitly)
 * and regroup the cluster onto `TemperatureKind`. Mirrors the production
 * producer, which always stamps `deviceType` from the snapshot. Without this,
 * the `isTemperaturePlanDevice` guard (which keys on `deviceType`) would read
 * `null` for fixtures that express temperature intent only through
 * `currentTarget`.
 */
const withFixtureTemperatureKind = <T extends { deviceType?: 'temperature' | 'onoff' }>(
  fields: T & TemperatureDiscriminantProbe,
): Omit<T, keyof TemperatureDiscriminantProbe> => {
  const hasTemperatureSignal = fields.currentTarget !== undefined
    || fields.currentTemperature !== undefined;
  if (!hasTemperatureSignal) {
    const { currentTarget: _ct, currentTemperature: _cte, ...rest } = fields;
    return rest;
  }
  return withTemperatureDiscriminant({
    deviceType: 'temperature' as const,
    ...fields,
  });
};

type MaterializedEvFields = {
  evBlockReason?: string | null;
  evSessionInactive?: boolean;
  evChargerNotResumable?: boolean;
};

/**
 * Test convenience: materialize the flat EV plug-state sub-fields from a
 * fixture's readable `evChargingState: 'plugged_out'` input so the plan devices
 * it builds carry the producer-resolved decisions the planner reads, and drop
 * the raw `evChargingState` (the observer owns it, not the planner).
 *
 * NOT a full mirror of the producer: `toPlanDevice` attaches the trio to EVERY
 * device (`null`/`false` for non-EV), whereas this helper omits the fields for
 * non-EV / unspecified fixtures. That is behaviourally identical for consumers —
 * the dual-read resolvers treat an absent field and a `false`/`null` value the
 * same — and keeps non-EV fixtures uncluttered.
 */
export const withMaterializedEvPlugState = <T extends { deviceClass?: string; controlCapabilityId?: string }>(
  overrides: T & { evChargingState?: string },
): Omit<T, 'evChargingState'> & MaterializedEvFields => {
  const { evChargingState, ...rest } = overrides;
  if (evChargingState === undefined && !('evChargingState' in overrides)) return rest;
  if (!isEvDevice(rest)) return rest;
  const commandable = resolveCommandableNow({ dev: { ...rest, evChargingState } });
  const evFields: MaterializedEvFields = {
    evBlockReason: commandable.evBlockReason,
    evSessionInactive: commandable.evSessionInactive,
    evChargerNotResumable: commandable.evChargerNotResumable,
  };
  return { ...rest, ...evFields };
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
  overrides: Partial<DevicePlanDevice> & TemperatureDiscriminantProbe & {
    reason?: DevicePlanDevice['reason'] | string;
    evChargingState?: string;
    deviceType?: 'temperature' | 'onoff';
  } = {},
):
DevicePlanDevice => {
  const { reason, currentTarget, currentTemperature, ...rest } = overrides;
  return {
    id: 'dev',
    name: 'Device',
    currentState: 'on',
    plannedState: 'keep',
    controlCapabilityId: 'onoff',
    reason: legacyDeviceReason('keep')!,
    ...withFixtureTemperatureKind({
      ...withMaterializedEvPlugState(rest),
      ...(currentTarget !== undefined ? { currentTarget } : {}),
      ...(currentTemperature !== undefined ? { currentTemperature } : {}),
    }),
    ...(reason !== undefined
      ? { reason: typeof reason === 'string' ? legacyDeviceReason(reason)! : reason }
      : {}),
  } as DevicePlanDevice;
};

export const buildPlanInputDevice = (
  overrides: Partial<PlanInputDevice> & TemperatureDiscriminantProbe & {
    evChargingState?: string;
    deviceType?: 'temperature' | 'onoff';
  } = {},
): PlanInputDevice => {
  const { currentTarget: _currentTarget, currentTemperature, ...rest } = overrides;
  return {
    id: 'dev',
    name: 'Device',
    targets: [],
    binaryControl: { on: true },
    controllable: true,
    controlCapabilityId: 'onoff',
    ...withFixtureTemperatureKind({
      ...withMaterializedEvPlugState(rest),
      ...(currentTemperature !== undefined ? { currentTemperature } : {}),
    }),
  } as PlanInputDevice;
};

export const steppedPlanDevice = (overrides: Partial<DevicePlanDevice> = {}): DevicePlanDevice => {
  const profile = overrides.steppedLoadProfile ?? steppedProfile;
  const selectedStepId = overrides.selectedStepId ?? 'max';
  const step = profile.steps.find((s) => s.id === selectedStepId);
  const defaultPlanningKw = step ? step.planningPowerW / 1000 : 0;

  return buildPlanDevice({
    // `controlModel` is no longer a plan-device (output) field; the stepped
    // discriminant is the presence of a valid `steppedLoadProfile`.
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
