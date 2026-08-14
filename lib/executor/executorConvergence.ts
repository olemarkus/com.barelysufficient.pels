/**
 * Convergence predicates: does observed device state still disagree with the
 * plan's intent, and has a dispatched actuation settled?
 *
 * Owned by the executor because converging observed onto desired is this
 * layer's charter — the planner decides desired state from its own inputs and
 * knows nothing about drift (`lib/plan/AGENTS.md`, `lib/AGENTS.md` § Layer
 * boundaries). These functions take a `DevicePlan` and live `PlanInputDevice`s
 * only to read them; they make no planning decision and never mutate a plan.
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
import { isSteppedLoadDevice } from '../plan/planSteppedLoad';
import { isBinaryPlanDevice } from '../plan/planBinaryDevice';
import { isTemperaturePlanDevice } from '../plan/planTemperatureDevice';
import { hasPlanDeviceExecutionDrift } from './planExecutionDrift';

export function hasPlanExecutionDrift(previousPlan: DevicePlan, livePlan: DevicePlan): boolean {
  if (previousPlan.devices.length !== livePlan.devices.length) return true;
  for (let index = 0; index < previousPlan.devices.length; index += 1) {
    const previous = previousPlan.devices[index];
    const live = livePlan.devices[index];
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
    const baseDevice = basePlan.devices[index];
    const liveDevice = livePlan.devices[index];
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
// the live device reads on (`currentOn`), a planned binary shed only once it reads
// off. On/off is binary-only, so a non-binary live device is never confirmed
// on/off and the corresponding restore/shed never reads settled here.
function hasSettledBinaryActuation(
  baseDevice: DevicePlan['devices'][number],
  liveDevice: DevicePlan['devices'][number],
): boolean {
  if (requiresBinaryRestore(baseDevice) && !(isBinaryPlanDevice(liveDevice) && liveDevice.currentOn)) return false;
  if (requiresBinaryShed(baseDevice) && !(isBinaryPlanDevice(liveDevice) && !liveDevice.currentOn)) return false;
  return true;
}

function hasSettledPostActuationState(
  baseDevice: DevicePlan['devices'][number],
  liveDevice: DevicePlan['devices'][number],
): boolean {
  if (baseDevice.available === false || liveDevice.available === false) return true;
  if (
    isSteppedLoadDevice(baseDevice)
    && baseDevice.desiredStepId
    && liveDevice.selectedStepId !== baseDevice.desiredStepId
  ) {
    return false;
  }
  if (!hasSettledBinaryActuation(baseDevice, liveDevice)) return false;
  if (requiresTargetUpdate(baseDevice)) {
    // A pending target update settles only when the LIVE device still carries
    // the temperature facet and its setpoint reads at the planned value. A live
    // device that lost the facet has no setpoint to confirm — not settled.
    const settled = isTemperaturePlanDevice(baseDevice)
      && isTemperaturePlanDevice(liveDevice)
      && liveDevice.currentTarget === baseDevice.plannedTarget;
    if (!settled) return false;
  }
  return true;
}

function requiresBinaryRestore(device: DevicePlan['devices'][number]): boolean {
  return device.controllable
    && device.plannedState === 'keep'
    && isBinaryPlanDevice(device) && !device.currentOn;
}

function requiresBinaryShed(device: DevicePlan['devices'][number]): boolean {
  // Only a `turn_off` shed settles on the binary axis. `set_step` and
  // `set_temperature` sheds settle on the step / target axis — a step-only
  // stepper (no binary handle) sheds via `set_step` and must NOT be held for a
  // binary-off read it can never produce. (An already-off binary device's
  // `turn_off` still settles immediately via the live binary-off read.)
  return device.plannedState === 'shed' && device.shedAction === 'turn_off';
}

function requiresTargetUpdate(device: DevicePlan['devices'][number]): boolean {
  if (device.plannedState === 'shed' && device.shedAction !== 'set_temperature') {
    return false;
  }
  if (!isTemperaturePlanDevice(device)) return false;
  return device.plannedTarget !== device.currentTarget;
}

function hasRelevantBinaryExecutionDrift(
  previousDevice: DevicePlan['devices'][number],
  liveDevice: DevicePlan['devices'][number],
): boolean {
  if (isSteppedLoadDevice(previousDevice)) {
    return previousDevice.selectedStepId !== liveDevice.selectedStepId
      || previousDevice.currentState !== liveDevice.currentState
      || hasSteppedEvidenceChanged(previousDevice, liveDevice);
  }
  return previousDevice.currentState !== liveDevice.currentState;
}

function hasSteppedEvidenceChanged(
  previousDevice: DevicePlan['devices'][number],
  liveDevice: DevicePlan['devices'][number],
): boolean {
  return previousDevice.reportedStepId !== liveDevice.reportedStepId;
}

function hasRelevantTargetExecutionDrift(
  previousDevice: DevicePlan['devices'][number],
  liveDevice: DevicePlan['devices'][number],
): boolean {
  if (!tracksTargetForExecution(previousDevice) || !isTemperaturePlanDevice(previousDevice)) return false;
  // A live device that lost the temperature facet counts as drift: the tracked
  // setpoint can no longer be read at its previous value.
  return !isTemperaturePlanDevice(liveDevice) || liveDevice.currentTarget !== previousDevice.currentTarget;
}

function tracksTargetForExecution(device: DevicePlan['devices'][number]): boolean {
  if (device.plannedState === 'shed' && device.shedAction !== 'set_temperature') {
    return false;
  }
  return isTemperaturePlanDevice(device);
}
