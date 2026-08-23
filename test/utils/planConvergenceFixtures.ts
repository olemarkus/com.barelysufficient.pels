import type {
  DevicePlan,
  PlanInputDevice,
  BinaryControlDiscriminantProbe,
  SteppedDiscriminantProbe,
  TemperatureDiscriminantProbe,
} from '../../lib/plan/planTypes';
import {
  withBinaryDiscriminant,
  withTemperatureDiscriminant,
} from '../../lib/plan/planTypes';
import { resolvePlannedShedTargetKind } from '../../lib/plan/planActionMaterialization';
import { buildPlanMeta, resolveFixtureCurrentOn, withMaterializedEvPlugState } from './planTestUtils';
import type { BinaryControlObservation } from '../../packages/contracts/src/types';

export type LooseOutputDevice = Partial<DevicePlan['devices'][number]>
  & TemperatureDiscriminantProbe
  & BinaryControlDiscriminantProbe
  & { binaryCapabilityId?: string; evChargingState?: string };

// Regroup a loose output-device override bag (temperature fields flat on the
// base) onto the discriminated `DevicePlanDevice` shape.
export const asOutputDevice = (
  loose: LooseOutputDevice,
): DevicePlan['devices'][number] => {
  const materialized = withMaterializedEvPlugState(loose);
  const {
    binaryCapabilityId, binaryControl, currentOn,
    // Plan-INPUT bits. `withMaterializedEvPlugState` stamps them for the input
    // builder; an output device carries none of them, and `confirmedNotDrawing`
    // in particular is the evidence `planTypes.ts` says must not travel onto the
    // plan output. Letting them ride made every fixture from this family a
    // second answer to a question the plan already decided.
    boostSupported: _boostSupported, boostRequested: _boostRequested,
    confirmedNotDrawing: _confirmedNotDrawing,
    ...semantic
  } = materialized;
  return withBinaryDiscriminant(withTemperatureDiscriminant({
    ...semantic,
    // Required on `DevicePlanDevice` precisely so absence is never a state.
    // Every fixture here shipped it undefined, so the two restore-admission
    // readers answered from absence and a dropped `boostActive` in production
    // would have passed these suites unnoticed.
    boostActive: loose.boostActive ?? false,
    // Mirrors production's ONE stamp site (`finalizePlanDevices`), through the
    // same resolver: the plan's shed END STATE, derived from the device's final
    // `plannedState` + shed triple. The convergence predicates read this and not
    // the shed policy, so a fixture without it would arrive as "not shed".
    plannedShedTargetKind: loose.plannedShedTargetKind
      ?? resolvePlannedShedTargetKind({
        plannedState: loose.plannedState ?? 'keep',
        shedAction: loose.shedAction,
        steppedLoadProfile: (loose as SteppedDiscriminantProbe).steppedLoadProfile,
        plannedShedStepId: loose.plannedShedStepId,
      }),
    ...(binaryCapabilityId !== undefined ? {
      currentOn: currentOn ?? resolveFixtureCurrentOn({ ...materialized, binaryControl }),
    } : {}),
  })) as DevicePlan['devices'][number];
};

export type LooseInputDevice = Partial<PlanInputDevice>
  & BinaryControlDiscriminantProbe
  & {
    evChargingState?: string;
    binaryCapabilityId?: string;
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
    controllable: materialized.controllable ?? true,
    available: materialized.available ?? true,
    ...(materialized.binaryCapabilityId !== undefined
      ? { currentOn: materialized.currentOn ?? resolveFixtureCurrentOn(materialized) }
      : {}),
  } as unknown as PlanInputDevice;
};

export const steppedProfile = {
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
    controllable: true,
    binaryCapabilityId: 'onoff' as const,
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
    binaryCapabilityId: 'onoff' as const,
    ...overrides,
  };
  return asOutputDevice({ ...merged, currentOn: resolveFixtureCurrentOn(merged) });
};

export const buildEvDevice = (
  overrides: LooseOutputDevice = {},
): DevicePlan['devices'][number] => buildBinaryDevice({
  id: 'ev-1',
  name: 'EV Charger',
  plannedTarget: undefined,
  deviceClass: 'evcharger',
  binaryCapabilityId: 'evcharger_charging',
  evChargingState: 'plugged_in_paused',
  deferredReleaseIntent: 'binary_restore',
  ...overrides,
});

export const buildPlan = (devices: DevicePlan['devices']): DevicePlan => ({
  meta: buildPlanMeta({ totalKw: 1, softLimitKw: 5, headroomKw: 4}),
  devices,
});
