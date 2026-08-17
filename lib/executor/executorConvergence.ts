/**
 * Convergence predicates: does observed device state still disagree with the
 * plan's intent, and has a dispatched actuation settled?
 *
 * Owned by the executor because converging observed onto desired is this
 * layer's charter — the planner decides desired state from its own inputs and
 * knows nothing about drift (`lib/plan/AGENTS.md`, `lib/AGENTS.md` § Layer
 * boundaries). The plan snapshots and live `PlanInputDevice`s arriving here are
 * projected onto the narrow `ExecutableConvergenceDevice` view before any
 * predicate reads them, so the comparisons see the decided end state per axis
 * and never the planner's shed policy; they make no planning decision and never
 * mutate a plan.
 *
 * Callers can rely on:
 * - `hasPlanExecutionDriftAgainstIntent` compares live observations against
 *   planner INTENT, per device, via `hasPlanDeviceExecutionDrift`. This is the
 *   predicate that answers "does the executor have work to do?".
 * - `hasPlanExecutionDrift` compares two plan snapshots positionally and is the
 *   cheaper snapshot-to-snapshot form used by the settle path below.
 * - `canRefreshPlanSnapshotFromLiveState` is a SETTLE question, not a drift
 *   question: it reports whether every dispatched actuation in `basePlan` has
 *   materialized in `livePlan`, so the caller may safely adopt the live merge
 *   as its new base snapshot.
 *
 * Governing reference: `notes/state-management/README.md`.
 */
import type { DevicePlan, PlanInputDevice } from '../plan/planTypes';
import type { ExecutableConvergenceDevice } from './executablePlan';
import { buildExecutableConvergenceDevice } from './executablePlanProjection';
import { hasPlanDeviceExecutionDrift } from './planExecutionDrift';

export function hasPlanExecutionDrift(previousPlan: DevicePlan, livePlan: DevicePlan): boolean {
  if (previousPlan.devices.length !== livePlan.devices.length) return true;
  for (let index = 0; index < previousPlan.devices.length; index += 1) {
    const previous = buildExecutableConvergenceDevice(previousPlan.devices[index]);
    const live = buildExecutableConvergenceDevice(livePlan.devices[index]);
    if (previous.id !== live.id) return true;
    if (hasRelevantBinaryExecutionDrift(previous, live)) return true;
    if (hasRelevantTargetExecutionDrift(previous, live)) return true;
  }
  return false;
}

export function canRefreshPlanSnapshotFromLiveState(
  basePlan: DevicePlan,
  livePlan: DevicePlan,
): boolean {
  if (!hasPlanExecutionDrift(basePlan, livePlan)) return false;
  if (basePlan.devices.length !== livePlan.devices.length) return false;

  for (let index = 0; index < basePlan.devices.length; index += 1) {
    const baseDevice = buildExecutableConvergenceDevice(basePlan.devices[index]);
    const liveDevice = livePlan.devices[index]
      ? buildExecutableConvergenceDevice(livePlan.devices[index])
      : undefined;
    if (!liveDevice || baseDevice.id !== liveDevice.id) return false;
    if (!hasSettledPostActuationState(baseDevice, liveDevice)) return false;
  }
  return true;
}
export function hasPlanExecutionDriftAgainstIntent(
  previousPlan: DevicePlan,
  liveDevices: PlanInputDevice[],
): boolean {
  const liveById = new Map(liveDevices.map((device) => [device.id, device]));
  for (const previous of previousPlan.devices) {
    const live = liveById.get(previous.id);
    if (!live) continue;
    if (hasPlanDeviceExecutionDrift({ planDevice: previous, liveDevice: live })) return true;
  }
  return false;
}

// The binary on/off settle check: a planned binary restore is settled only once
// the live device reads on, a planned binary shed only once it reads off. On/off
// is binary-only, so a non-binary live device (`observedBinaryOn === null`) is
// never confirmed on/off and the corresponding restore/shed never reads settled
// here.
function hasSettledBinaryActuation(
  baseDevice: ExecutableConvergenceDevice,
  liveDevice: ExecutableConvergenceDevice,
): boolean {
  if (requiresBinaryRestore(baseDevice) && liveDevice.observedBinaryOn !== true) return false;
  if (requiresBinaryShed(baseDevice) && liveDevice.observedBinaryOn !== false) return false;
  return true;
}

function hasSettledPostActuationState(
  baseDevice: ExecutableConvergenceDevice,
  liveDevice: ExecutableConvergenceDevice,
): boolean {
  if (baseDevice.available === false || liveDevice.available === false) return true;
  if (
    baseDevice.observedStep
    && baseDevice.desiredStepId
    && liveDevice.observedStep?.selectedStepId !== baseDevice.desiredStepId
  ) {
    return false;
  }
  if (!hasSettledBinaryActuation(baseDevice, liveDevice)) return false;
  if (requiresTargetUpdate(baseDevice)) {
    // A pending target update settles only when the LIVE device still carries
    // the temperature facet and its setpoint reads at the planned value. A live
    // device that lost the facet has no setpoint to confirm — not settled.
    if (liveDevice.observedTarget !== baseDevice.desiredTarget) return false;
  }
  return true;
}

// A restore is outstanding only while the device the plan wants on still reads
// off — an already-on device has nothing to settle.
function requiresBinaryRestore(device: ExecutableConvergenceDevice): boolean {
  return device.desiredBinaryState === 'on' && device.observedBinaryOn === false;
}

// Only a shed the plan decided ends with the device OFF settles on the binary
// axis. A shed that ends at a step, or at a setpoint, settles on that axis
// instead — a step-only stepper (no binary handle) must NOT be held for a
// binary-off read it can never produce. (An already-off device's binary shed
// still settles immediately via the live binary-off read.)
function requiresBinaryShed(device: ExecutableConvergenceDevice): boolean {
  return device.desiredBinaryState === 'off';
}

function requiresTargetUpdate(device: ExecutableConvergenceDevice): boolean {
  return device.desiredTarget !== null && device.observedTarget !== device.desiredTarget;
}

function hasRelevantBinaryExecutionDrift(
  previousDevice: ExecutableConvergenceDevice,
  liveDevice: ExecutableConvergenceDevice,
): boolean {
  const previousStep = previousDevice.observedStep;
  if (previousStep) {
    // A live device that lost its stepped cluster counts as drift: the tracked
    // step can no longer be read at its previous value.
    const liveStep = liveDevice.observedStep;
    return !liveStep
      || previousStep.selectedStepId !== liveStep.selectedStepId
      || previousDevice.observedState !== liveDevice.observedState
      || previousStep.reportedStepId !== liveStep.reportedStepId;
  }
  return previousDevice.observedState !== liveDevice.observedState;
}

function hasRelevantTargetExecutionDrift(
  previousDevice: ExecutableConvergenceDevice,
  liveDevice: ExecutableConvergenceDevice,
): boolean {
  // No setpoint is being converged on, so a setpoint change is not drift the
  // executor owes work for.
  if (previousDevice.desiredTarget === null) return false;
  // A live device that lost the temperature facet counts as drift: the tracked
  // setpoint can no longer be read at its previous value.
  return liveDevice.observedTarget === null
    || liveDevice.observedTarget !== previousDevice.observedTarget;
}
