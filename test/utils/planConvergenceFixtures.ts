import type {
  DevicePlan,
  PlanInputDevice,
  BinaryControlDiscriminantProbe,
  TemperatureDiscriminantProbe,
  EvDiscriminantProbe,
} from '../../lib/plan/planTypes';
import {
  withTemperatureDiscriminant,
  withEvDiscriminant,
} from '../../lib/plan/planTypes';
import { withMaterializedEvPlugState, resolveFixtureCurrentOn } from './planTestUtils';
import type { BinaryControlObservation } from '../../packages/contracts/src/types';

export type LooseOutputDevice = Partial<DevicePlan['devices'][number]>
  & TemperatureDiscriminantProbe
  & EvDiscriminantProbe
  & BinaryControlDiscriminantProbe;

// Regroup a loose output-device override bag (temperature/EV fields flat on the
// base) onto the discriminated `DevicePlanDevice` shape.
export const asOutputDevice = (
  loose: LooseOutputDevice,
): DevicePlan['devices'][number] =>
  withTemperatureDiscriminant(withEvDiscriminant(loose)) as DevicePlan['devices'][number];

export type LooseInputDevice = Partial<PlanInputDevice>
  & BinaryControlDiscriminantProbe
  & {
    evChargingState?: string;
    controlCapabilityId?: string;
    // `binaryControlObservation` is a transport/observer snapshot field, not a
    // `PlanInputDevice` field; the production drift path reads only
    // `binaryControl`. Several fixtures still carry it as inert evidence — accept
    // it on the loose bag so it is forwarded byte-identically (no runtime change)
    // rather than dropped.
    binaryControlObservation?: BinaryControlObservation;
  };

// Regroup a loose live-input override bag (binaryControl flat on the base,
// optional readable `evChargingState`) onto the discriminated `PlanInputDevice`
// shape: materialize the EV plug-state flat fields (mirroring the producer) and
// resolve the producer-owned `currentOn` for binary devices from the fixture's
// observed binary + stepped signals — production live devices always carry it
// (`toPlanDevice`), and the convergence path now reads `currentOn`, not the raw
// `binaryControl`. The fixtures still carry `binaryControl` verbatim (kept by the
// cast) so the loose `evChargingState`/observation evidence stays inert; the cast
// is the fixture-constructor boundary, not a per-test smuggle.
export const inputDevice = (
  loose: LooseInputDevice,
): PlanInputDevice => {
  const materialized = withMaterializedEvPlugState(loose);
  return {
    ...materialized,
    ...(materialized.controlCapabilityId !== undefined
      ? { currentOn: materialized.currentOn ?? resolveFixtureCurrentOn(materialized) }
      : {}),
  } as unknown as PlanInputDevice;
};

export const steppedProfile = {
  model: 'stepped_load' as const,
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

export const buildSteppedDevice = (
  overrides: LooseOutputDevice = {},
): DevicePlan['devices'][number] => {
  const merged = {
    id: 'dev-1',
    name: 'Tank',
    currentState: 'on',
    plannedState: 'keep' as const,
    currentTarget: null,
    controllable: true,
    controlCapabilityId: 'onoff' as const,
    steppedLoadProfile: steppedProfile,
    selectedStepId: 'low',
    desiredStepId: 'low',
    ...overrides,
  };
  return asOutputDevice({ ...merged, currentOn: resolveFixtureCurrentOn(merged) });
};

export const buildBinaryDevice = (
  overrides: LooseOutputDevice = {},
): DevicePlan['devices'][number] => {
  const merged = {
    id: 'dev-2',
    name: 'Heater',
    currentState: 'on',
    plannedState: 'keep' as const,
    currentTarget: 21,
    plannedTarget: 21,
    controllable: true,
    controlCapabilityId: 'onoff' as const,
    ...overrides,
  };
  return asOutputDevice({ ...merged, currentOn: resolveFixtureCurrentOn(merged) });
};

export const buildEvDevice = (
  overrides: LooseOutputDevice = {},
): DevicePlan['devices'][number] => buildBinaryDevice({
  id: 'ev-1',
  name: 'EV Charger',
  currentTarget: null,
  plannedTarget: undefined,
  deviceClass: 'evcharger',
  controlCapabilityId: 'evcharger_charging',
  evChargingState: 'plugged_in_paused',
  deferredReleaseIntent: 'binary_restore',
  ...overrides,
});

export const buildPlan = (devices: DevicePlan['devices']): DevicePlan => ({
  meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
  devices,
});
