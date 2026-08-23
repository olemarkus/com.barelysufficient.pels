import type {
  DriftCommandRead,
  DriftObservationDeps,
  ObserverDeviceRead,
} from '../../lib/executor/driftObservedDevice';
import type {
  BinaryControlDiscriminantProbe,
  PlanInputDevice,
  SteppedDiscriminantProbe,
} from '../../lib/plan/planTypes';
import type { EvObservedProbe } from '../../packages/contracts/src/types';

/**
 * Fixtures physically carry the stepped and EV clusters before anything narrows
 * them, so this helper widens with the probes rather than narrowing per field —
 * the same pattern the production producer seams use.
 */
type PlanInputDeviceFixture = PlanInputDevice
  & SteppedDiscriminantProbe
  & EvObservedProbe
  // Fixtures still carry the RAW `binaryControl` that `toPlanDevice` strips in
  // production. Here that is the point: it is the observer's axis, and reading
  // it back out is what reconstitutes the observation the fixture describes.
  & BinaryControlDiscriminantProbe;

/**
 * Split a `PlanInputDevice` fixture into the two things the drift path actually
 * takes: an OBSERVATION from the observer, and the in-flight command state the
 * executor owns.
 *
 * Fixtures still describe a device as one plan-input bag, because that is the
 * shape the planner specs need. Production never hands that bag to the executor
 * — this helper is the seam that keeps the specs honest about it.
 *
 * Two translations are load-bearing:
 *  - `selectedStepId` becomes `reportedStepId`. A fixture states the rung as a
 *    settled fact; in production the device REPORTS a rung and the effective
 *    step is resolved from it. Feeding it as the report reproduces that
 *    resolution instead of smuggling the answer past it.
 *  - the BINARY command read is a separate argument, not a fixture field. It
 *    used to ride in on `binaryCommandPending`/`binaryCommandPendingDesired`,
 *    which the plan-input seam no longer carries precisely because in-flight
 *    command state is the executor's. Passing it here keeps the split explicit:
 *    a spec that dampens on a pending command says so, rather than describing
 *    it as a property of the observed device. (The STEP flag stays on the
 *    fixture — `stepCommandPending` is a real plan-input field with production
 *    readers.)
 */
const resolveFixtureBinaryAxis = (
  live: PlanInputDeviceFixture,
): { binaryControl?: { on: boolean } } => {
  if (live.binaryControl !== undefined) return { binaryControl: live.binaryControl };
  const currentOn = (live as { currentOn?: boolean }).currentOn;
  return typeof currentOn === 'boolean' ? { binaryControl: { on: currentOn } } : {};
};

export const splitPlanInputDevice = (
  live: PlanInputDeviceFixture,
  binaryCommand: DriftCommandRead['binary'],
): {
  observed: ObserverDeviceRead;
  command: DriftCommandRead;
  externalOffHeld: boolean;
} => ({
  observed: {
    id: live.id,
    name: live.name,
    available: live.available,
    targets: live.targets ?? [],
    // Fixtures come in both shapes. Some carry the RAW axis; ones built through
    // `withBinaryDiscriminant` are production-faithful and carry only the
    // producer-folded `currentOn`, the raw axis having been stripped. The
    // observer always has a raw axis, so reconstitute one from whichever the
    // fixture kept — otherwise an absent `binaryControl` reads as "no binary
    // evidence", which `resolveCurrentOn` answers ON, silently inverting every
    // observed-off case.
    ...resolveFixtureBinaryAxis(live),
    ...(live.selectedStepId !== undefined ? { reportedStepId: live.selectedStepId } : {}),
    ...(live.currentDrawKw !== undefined ? { measuredPowerKw: live.currentDrawKw } : {}),
    ...(live.evChargingState !== undefined ? { evChargingState: live.evChargingState } : {}),
  } as ObserverDeviceRead,
  command: {
    binary: binaryCommand,
    step: live.stepCommandPending === true ? { kind: 'pending' } : { kind: 'none' },
  },
  externalOffHeld: live.externalOffHoldActive === true,
});

/**
 * `DriftObservationDeps` backed by a plan-input fixture list.
 *
 * A device absent from the list has NO observation, which the predicate skips —
 * the same treatment production gives a device the observer has not seen yet.
 */
export const driftDepsFromPlanInputs = (
  getDevices: () => PlanInputDeviceFixture[],
  getBinaryCommand: (deviceId: string) => DriftCommandRead['binary'],
): DriftObservationDeps => ({
  getObservedState: (deviceId) => {
    const live = getDevices().find((device) => device.id === deviceId);
    return live ? splitPlanInputDevice(live, getBinaryCommand(deviceId)).observed : undefined;
  },
  getCommandState: (deviceId) => {
    const live = getDevices().find((device) => device.id === deviceId);
    return live
      ? splitPlanInputDevice(live, getBinaryCommand(deviceId)).command
      : { binary: { kind: 'none' }, step: { kind: 'none' } };
  },
  isExternalOffHeld: (deviceId) => {
    const live = getDevices().find((device) => device.id === deviceId);
    return live ? splitPlanInputDevice(live, getBinaryCommand(deviceId)).externalOffHeld : false;
  },
});
