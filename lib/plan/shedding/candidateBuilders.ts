/**
 * Binary and temperature shed-candidate construction, plus the two eligibility
 * predicates the collect loop applies before either runs.
 *
 * Split out of `candidates.ts` so the stepped builders (`steppedCandidates.ts`)
 * can reuse `buildTemperatureCandidate` — a stepped device configured to shed by
 * setpoint takes that path — without importing the collect loop and creating a
 * cycle.
 *
 * Every builder here enforces the module rule from `lib/plan/shedding/AGENTS.md`:
 * a device may only be selected when limiting it releases power.
 */
import type { PlanEngineState } from '../planState';
import type { PlanInputDevice } from '../planTypes';
import type { PendingBinaryCommandStore } from '../../observer/pendingBinaryCommands';
import { isBinaryPlanDevice } from '../planBinaryDevice';
import { isTemperaturePlanDevice } from '../planTemperatureDevice';
import { isCanSetControl } from '../../device/deviceActionProjection';
import type { ShedCandidateSkipRecorder } from './candidateSkipLog';
import {
  type BinaryShedCandidate,
  type ShedCandidate,
  type TemperatureShedCandidate,
} from './types';
import { temperatureSetpointsFor } from '../planTemperatureSetpoints';
import type { TemperatureSetpointsByDevice } from '../../../packages/planner-types/src/temperatureSetpoints';

export function buildBinaryCandidate(
  device: PlanInputDevice,
  priority: number,
  recentlyRestored: boolean,
  pendingBinaryCommandStore: PendingBinaryCommandStore,
  recorder?: ShedCandidateSkipRecorder,
): BinaryShedCandidate | null {
  // Only offer a binary shed candidate when PELS can actually write the device's
  // on/off control. `isCanSetControl` reads the producer-resolved writability bit
  // (the same one the executor's restore/stepped paths gate on via
  // `canTurnOnDevice`), so a device that lost its binary capability — e.g. a
  // thermostat that dropped `onoff` and can now only shed via its target — is
  // excluded here instead of being credited in the cascade and then no-oped at
  // the executor (`getBinaryControlPlan === null`), which would waste the shed
  // slot and leave the overshoot unrelieved while a writable device goes unshed.
  if (!isCanSetControl(device)) {
    recorder?.record({ device, reasonCode: 'control_not_writable' });
    return null;
  }
  const power = device.currentDrawKw;
  if (power <= 0) {
    recorder?.record({ device, reasonCode: 'zero_current_draw' });
    return null;
  }
  return {
    ...device,
    kind: 'binary',
    priority,
    recentlyRestored,
    effectivePower: power,
    // "Relief already on its way": an unconfirmed turn-OFF. The store answers
    // it — non-evicting, which is why this site used to `peek` by hand.
    unconfirmedRelief: pendingBinaryCommandStore.hasActiveTurnOff(device.id),
  };
}

export function isEligibleForShedding(device: PlanInputDevice): boolean {
  // Eligible unless a binary device is confirmed off; non-binary devices
  // (setpoint/step shed) have no on/off truth and stay eligible.
  return !isBinaryPlanDevice(device) || device.currentOn;
}

export function buildTemperatureCandidate(params: {
  device: PlanInputDevice;
  priority: number;
  recentlyRestored: boolean;
  /** The capability-normalized limit, resolved before the planner (`ResolvedShedBehavior`). */
  shedTemperature: number;
  targetCapabilityId: string;
  pendingTargetCommands: PlanEngineState['pendingTargetCommands'];
  recorder?: ShedCandidateSkipRecorder;
}): TemperatureShedCandidate | null {
  const {
    device, priority, recentlyRestored, shedTemperature, targetCapabilityId, pendingTargetCommands, recorder,
  } = params;
  const power = device.currentDrawKw;
  if (power <= 0) {
    recorder?.record({ device, reasonCode: 'zero_current_draw' });
    return null;
  }
  const pending = pendingTargetCommands[device.id];
  const unconfirmedRelief = pending !== undefined
    && pending.status === 'waiting_confirmation'
    && pending.target === 'temperature'
    && pending.desired === shedTemperature;
  return {
    ...device,
    kind: 'temperature',
    priority,
    recentlyRestored,
    effectivePower: power,
    unconfirmedRelief,
    targetCapabilityId,
    shedTemperature,
  };
}

function isNotAtShedTemperature(device: ShedCandidate): boolean {
  if (device.kind !== 'temperature') return true;
  // The setpoint truth is the narrowed `currentTarget` (atomic facet), not a
  // re-derivation from the raw `targets` metadata list.
  return !(isTemperaturePlanDevice(device) && device.currentTarget === device.shedTemperature);
}

/**
 * A limit on the DEMAND side of the current target: a floor above the heating
 * target, or a cooling ceiling below the cooling target. Writing it would make
 * the device work harder — the one outcome a shed must never have — so the
 * candidate is skipped rather than clamped: a clamped write is a no-op the
 * executor would still issue and wait to confirm. The owner can configure such
 * a limit (the fields only bound the range), and a mode target can move past a
 * limit that was fine when it was set. Which side is the demand side is
 * resolved before the planner (`ResolvedShedBehavior.releasesDemand`); the
 * at-limit case is recorded as its own skip first.
 */
function limitWouldAddDemand(device: ShedCandidate, temperatureSetpoints: TemperatureSetpointsByDevice): boolean {
  if (device.kind !== 'temperature' || !isTemperaturePlanDevice(device)) return false;
  const { shed } = temperatureSetpointsFor(temperatureSetpoints, device.id);
  return shed.action === 'set_temperature' && !shed.releasesDemand;
}

/**
 * The two setpoint checks the collect loop applies to a built candidate, each
 * recorded as its own skip so the counters say which. True when skipped.
 */
export function recordSetpointShedSkip(
  candidate: ShedCandidate,
  device: PlanInputDevice,
  temperatureSetpoints: TemperatureSetpointsByDevice,
  recorder: ShedCandidateSkipRecorder,
): boolean {
  if (!isNotAtShedTemperature(candidate)) {
    recorder.record({ device, reasonCode: 'already_at_shed_temperature' });
    return true;
  }
  if (limitWouldAddDemand(candidate, temperatureSetpoints)) {
    recorder.record({ device, reasonCode: 'limit_would_add_demand' });
    return true;
  }
  return false;
}
