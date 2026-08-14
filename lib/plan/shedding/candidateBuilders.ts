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
import { isPendingBinaryCommandActive } from '../planObservationPolicy';
import { normalizeTargetCapabilityValue } from '../../utils/targetCapabilities';
import type { ShedCandidateSkipRecorder } from './candidateSkipLog';
import {
  type BinaryShedCandidate,
  type ShedCandidate,
  type TemperatureShedCandidate,
} from './types';

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
  // Raw read: activeness is evaluated here with the device's
  // communication model, so `peek` (not `get`) keeps the prior
  // field-read behaviour without store eviction at this site.
  const pendingEntry = pendingBinaryCommandStore.peek(device.id);
  const pendingBinary = isPendingBinaryCommandActive({
    pending: pendingEntry,
  }) ? pendingEntry : undefined;
  return {
    ...device,
    kind: 'binary',
    priority,
    recentlyRestored,
    effectivePower: power,
    unconfirmedRelief: pendingBinary?.desired === false,
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
  shedTemperature: number;
  targetCapabilityId: string;
  targetCapability?: Partial<{ min?: number; max?: number; step?: number }> | null;
  pendingTargetCommands: PlanEngineState['pendingTargetCommands'];
  recorder?: ShedCandidateSkipRecorder;
}): TemperatureShedCandidate | null {
  const {
    device, priority, recentlyRestored, targetCapabilityId, targetCapability, pendingTargetCommands, recorder,
  } = params;
  const shedTemperature = normalizeTargetCapabilityValue({ target: targetCapability, value: params.shedTemperature });
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

export function isNotAtShedTemperature(device: ShedCandidate): boolean {
  if (device.kind !== 'temperature') return true;
  // The setpoint truth is the narrowed `currentTarget` (atomic facet), not a
  // re-derivation from the raw `targets` metadata list.
  return !(isTemperaturePlanDevice(device) && device.currentTarget === device.shedTemperature);
}
