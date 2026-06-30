import type {
  DevicePlanDevice,
  PlanInputDevice,
  SteppedDiscriminantProbe,
  TemperatureDiscriminantProbe,
  TemperatureKind,
} from '../../lib/plan/planTypes';
import { withBinaryDiscriminant, withTemperatureDiscriminant } from '../../lib/plan/planTypes';
import type { EvChargingState, SteppedLoadProfile } from '../../packages/contracts/src/types';
import { isEvDevice, resolveCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { resolveCurrentOn, resolveObservedCurrentState } from '../../lib/observer/observedState';
import type { BinaryControlCapabilityId } from '../../packages/contracts/src/types';
import { legacyDeviceReason } from './deviceReasonTestUtils.ts';

/**
 * Mirror the production producer: a binary fixture's `currentOn` is the resolved
 * on/off truth. Prefer an explicit override; then the structural resolution
 * (binary axis AND stepped-off fold via `resolveCurrentOn`) when the fixture
 * carries those signals; then the four-valued `currentState` label as a last
 * resort. Keeps fixtures' on/off truth consistent with the runtime stamping so
 * consumers reading `currentOn` behave identically to production.
 */
export const resolveFixtureCurrentOn = (device: {
  currentOn?: boolean;
  currentState?: string;
  binaryControl?: { on: boolean };
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
}): boolean => {
  if (typeof device.currentOn === 'boolean') return device.currentOn;
  // An EXPLICIT `currentState` is the production-consistent on/off label (it
  // already folds binary + step — e.g. "off at a higher step" sets `'off'` with
  // an active `selectedStepId`), so it wins over re-resolving from raw signals.
  if (device.currentState === 'off') return false;
  if (device.currentState === 'on') return true;
  if (device.binaryControl !== undefined || device.steppedLoadProfile !== undefined) {
    return resolveCurrentOn(device);
  }
  return true;
};

/**
 * Mirror the production producer (`toPlanDevice` → `resolveObservedCurrentState`):
 * the four-valued `currentState` label is resolved ONCE from the raw observed
 * signals and carried on the plan device, so plan consumers
 * (`planDevices.resolveCurrentState`, `planReconcileState`) can trust it without
 * re-resolving from the raw binary axis. An explicit fixture `currentState` wins;
 * otherwise resolve from the binary axis (explicit `binaryControl`, else derived
 * from the resolved `currentOn` for a binary device) + the stepped profile +
 * staleness — the SAME resolver the runtime producer uses, so a fixture's label
 * matches what production would stamp for the same observed signals.
 */
export const resolveFixtureCurrentState = (device: {
  currentState?: string;
  currentOn?: boolean;
  binaryControl?: { on: boolean };
  controlCapabilityId?: string;
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
}): string => {
  if (typeof device.currentState === 'string') return device.currentState;
  const binaryControl = device.binaryControl
    ?? (device.controlCapabilityId !== undefined ? { on: resolveFixtureCurrentOn(device) } : undefined);
  return resolveObservedCurrentState({
    binaryControl,
    controlCapabilityId: device.controlCapabilityId as BinaryControlCapabilityId | undefined,
    steppedLoadProfile: device.steppedLoadProfile,
    selectedStepId: device.selectedStepId,
  });
};

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
):
| Omit<T, keyof TemperatureDiscriminantProbe>
| (Omit<T, keyof TemperatureDiscriminantProbe> & TemperatureKind) => {
  const hasTemperatureSignal = fields.currentTarget !== undefined
    || fields.currentTemperature !== undefined;
  if (!hasTemperatureSignal) {
    const {
      currentTarget: _ct, currentTemperature: _cte, plannedTarget: _pt, ...rest
    } = fields;
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
  commandableNow?: boolean;
  commandableNowReason?: string | null;
};

/**
 * Test convenience: materialize the flat EV plug-state sub-fields (and the
 * `commandableNow` bit) from a fixture's readable `evChargingState:
 * 'plugged_out'` input so the plan devices it builds carry the producer-resolved
 * decisions consumers read, and drop the raw `evChargingState` (the observer
 * owns it, not the planner — the raw `evChargingState` consumer arm is retired,
 * so an unmaterialized fixture would have NO plug-state signal at all).
 *
 * Mirrors the producer (`toPlanDevice`) for EV devices: it runs the same
 * `resolveCommandableNow` and attaches `commandableNow` / `commandableNowReason`
 * alongside the EV trio, so the fixture is faithful to a real `PlanInputDevice`
 * (the executor drift path reads `commandableNow` off it). Crucially it
 * materializes even when `evChargingState` is absent — a cold-start EV resolves
 * to `'charger state unknown'` / `commandableNow: false`, exactly as the
 * producer does for a device that has not yet reported a plug-state.
 *
 * Non-EV fixtures are left uncluttered (the resolvers default an absent field to
 * `false`/`null`, identical to the producer's explicit `false`/`null`).
 */
export const withMaterializedEvPlugState = <T extends { deviceClass?: string; controlCapabilityId?: string }>(
  overrides: T & { evChargingState?: string },
): Omit<T, 'evChargingState'> & MaterializedEvFields => {
  const { evChargingState, ...rest } = overrides;
  if (!isEvDevice(rest)) return rest;
  const commandable = resolveCommandableNow({
    dev: { ...rest, evChargingState: evChargingState as EvChargingState | undefined },
  });
  const evFields: MaterializedEvFields = {
    evBlockReason: commandable.evBlockReason,
    evSessionInactive: commandable.evSessionInactive,
    evChargerNotResumable: commandable.evChargerNotResumable,
    commandableNow: commandable.commandableNow,
    commandableNowReason: commandable.reason,
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
  // `currentOn`/`binaryControl` live on the orthogonal `BinaryControlKind` cluster
  // (not on the `Partial<DevicePlanDevice>` base), so accept them here: the builder
  // resolves the producer-owned `currentOn`/`currentState` from whichever the
  // fixture supplies (mirroring `toPlanDevice`).
  overrides: Partial<DevicePlanDevice> & TemperatureDiscriminantProbe & {
    reason?: DevicePlanDevice['reason'] | string;
    evChargingState?: string;
    deviceType?: 'temperature' | 'onoff';
    currentOn?: boolean;
    binaryControl?: { on: boolean };
  } = {},
):
DevicePlanDevice => {
  const { reason, currentTarget, currentTemperature, ...rest } = overrides;
  const o = overrides as {
    currentOn?: boolean; currentState?: string; binaryControl?: { on: boolean };
    controlCapabilityId?: BinaryControlCapabilityId;
    steppedLoadProfile?: SteppedLoadProfile; selectedStepId?: string;
  };
  const currentOn = resolveFixtureCurrentOn(o);
  return {
    id: 'dev',
    name: 'Device',
    // Producer-resolved label (an explicit override in `...rest` still wins below).
    currentState: resolveFixtureCurrentState({ ...o, controlCapabilityId: o.controlCapabilityId ?? 'onoff' }),
    plannedState: 'keep',
    controlCapabilityId: 'onoff',
    reason: legacyDeviceReason('keep')!,
    ...withFixtureTemperatureKind({
      ...withMaterializedEvPlugState(rest),
      ...(currentTarget !== undefined ? { currentTarget } : {}),
      ...(currentTemperature !== undefined ? { currentTemperature } : {}),
    }),
    // Spread (not a direct property) so the `as DevicePlanDevice` cast accepts it:
    // `currentOn` lives on the orthogonal `BinaryControlKind`, reached via the guard.
    ...({ currentOn }),
    ...(reason !== undefined
      ? { reason: typeof reason === 'string' ? legacyDeviceReason(reason)! : reason }
      : {}),
  } as DevicePlanDevice;
};

export const buildPlanInputDevice = (
  // `currentOn`/`binaryControl` live on the orthogonal `BinaryPlanInputKind` cluster
  // (not on the `Partial<PlanInputDevice>` base), so accept them here: the builder
  // resolves the producer-owned `currentOn`/`currentState` from whichever the
  // fixture supplies (mirroring `toPlanDevice`).
  overrides: Partial<PlanInputDevice> & TemperatureDiscriminantProbe & {
    evChargingState?: string;
    deviceType?: 'temperature' | 'onoff';
    currentOn?: boolean;
    binaryControl?: { on: boolean };
  } = {},
): PlanInputDevice => {
  const { currentTarget: _currentTarget, currentTemperature, ...rest } = overrides;
  const o = overrides as {
    currentOn?: boolean; currentState?: string; binaryControl?: { on: boolean };
    controlCapabilityId?: BinaryControlCapabilityId;
    steppedLoadProfile?: SteppedLoadProfile; selectedStepId?: string;
  };
  const currentOn = resolveFixtureCurrentOn({ ...o, binaryControl: o.binaryControl ?? { on: true } });
  // Producer-resolved label (an explicit override in `...rest` still wins below).
  const currentState = resolveFixtureCurrentState({
    ...o,
    binaryControl: o.binaryControl ?? { on: true },
    controlCapabilityId: o.controlCapabilityId ?? 'onoff',
  });
  return withBinaryDiscriminant({
    id: 'dev',
    name: 'Device',
    targets: [],
    binaryControl: { on: true },
    controllable: true,
    controlCapabilityId: 'onoff',
    currentState,
    ...withFixtureTemperatureKind({
      ...withMaterializedEvPlugState(rest),
      ...(currentTemperature !== undefined ? { currentTemperature } : {}),
    }),
    currentOn,
  }) as PlanInputDevice;
};

export const steppedPlanDevice = (
  overrides: Partial<DevicePlanDevice> & SteppedDiscriminantProbe
    & { binaryControl?: { on: boolean }; currentOn?: boolean } = {},
): DevicePlanDevice => {
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
  overrides: Partial<PlanInputDevice> & SteppedDiscriminantProbe
    & { evChargingState?: string; binaryControl?: { on: boolean }; currentOn?: boolean } = {},
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
