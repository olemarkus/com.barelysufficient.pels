import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import { getHighestKnownPowerKw } from '../observer/observedPower';
import { isPlanDeviceObservedOff } from './planSteppedLoad';

type UsageDevice = {
  controllable?: boolean;
  budgetExempt?: boolean;
  // Producer-resolved on/off truth, present iff the device is binary
  // (`binaryCapabilityId` set). A step-only stepper carries no `currentOn`; its
  // off-state is read from the step axis, so the stepped fields travel too.
  currentOn?: boolean;
  currentState?: string;
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
  plannedState?: string;
  currentDrawKw: number;
  expectedPowerKw: number;
  planningPowerKw?: number;
};

/**
 * Managed usage: the sum of what the managed devices are drawing.
 *
 * The per-device rule is now just the producer's `currentDrawKw`. Three
 * plan-state-dependent ladders used to live here (shed / observed-off /
 * observed-on), each deciding for itself what an absent reading meant. The
 * observed-off arm answered with `getHighestKnownPowerKw`, i.e. RATED power, so
 * a device measuring a true 0 W was credited its nameplate — and this sum is
 * what `sampleIngest` persists into `controlledBuckets`. `0` is an answer, not a
 * gap: a device drawing nothing contributes nothing.
 *
 * No longer `number | null`. The null meant "a controllable device has no usable
 * reading, so the managed total cannot be attributed" — a state that no longer
 * exists, because the producer always has an answer for every planned device.
 */
export const sumControlledUsageKw = (devices: UsageDevice[]): number => {
  let totalKw = 0;
  for (const dev of devices) {
    if (dev.controllable === false) continue;
    totalKw += dev.currentDrawKw;
  }
  return totalKw;
};

export const sumBudgetExemptProjectedUsageKw = (devices: UsageDevice[]): number => {
  let totalKw = 0;
  for (const dev of devices) {
    if (dev.budgetExempt !== true || dev.controllable === false) continue;
    totalKw += resolveBudgetExemptProjectedKw(dev);
  }
  return totalKw;
};

// Measured-only sibling of `sumBudgetExemptProjectedUsageKw`. The live sum PROJECTS an
// observed-off exempt device's draw (via `getHighestKnownPowerKw`) — correct for
// the daily-pace add-back, where the reservation must exist while the device is
// off. This sum counts only actually-measured draw and is the budget-axis input
// for restore admission (`notes/safe-pace-two-constraints.md` § "It needs to land
// twice"): a non-exempt restore candidate must not spend headroom that exists
// only as an off exempt device's projection. Missing/unknown measurements count
// as 0 — an off exempt device reserves nothing on this axis.
export const sumBudgetExemptMeasuredUsageKw = (devices: UsageDevice[]): number => {
  let totalKw = 0;
  for (const dev of devices) {
    if (dev.budgetExempt !== true || dev.controllable === false) continue;
    totalKw += dev.currentDrawKw;
  }
  return totalKw;
};

export function splitControlledUsageKw(params: {
  devices: UsageDevice[];
  totalKw: number;
}): { controlledKw: number; uncontrolledKw: number } {
  const { devices, totalKw } = params;
  const controlledKw = sumControlledUsageKw(devices);
  const boundedControlledKw = Math.max(0, Math.min(totalKw, controlledKw));
  return {
    controlledKw: boundedControlledKw,
    uncontrolledKw: Math.max(0, totalKw - boundedControlledKw),
  };
}

/**
 * The exempt device's claim on the daily budget, which is NOT the same question
 * as what it is drawing.
 *
 * A deliberate RESERVATION, and the one place a configured demand still stands in
 * for a device that is off. The daily-pace add-back has to keep an exempt
 * device's claim alive across its duty cycle, or the pace ceiling would jump the
 * moment a thermostat finished a burn (`notes/safe-pace-two-constraints.md`).
 *
 * This is not the substitution that caused the defect. That one lived on the
 * current-draw axis, in `sumControlledUsageKw`, where a device measuring a true
 * 0 W was booked at nameplate into the persisted managed/background split. Here
 * the projection is the answer to a different question, it is gated on the
 * device being observed OFF, and its measured sibling
 * (`sumBudgetExemptMeasuredUsageKw`) is what restore admission spends.
 */
const resolveBudgetExemptProjectedKw = (dev: UsageDevice): number => {
  // Kept from the pre-refactor ladder, and currently INERT: both callers sum
  // shapes that carry no `plannedState` (`planBuilder` over `PlanInputDevice[]`,
  // `powerSamplePipeline` over `withHeadroomCurrentOn(snapshot)`), so this never
  // fires today — see `notes/safe-pace-two-constraints.md`. It stays because the
  // rule it encodes is right: a device PELS decided to shed has no claim to
  // project, since the plan is to take its load away.
  if (dev.plannedState === 'shed') return dev.currentDrawKw;
  if (dev.currentDrawKw > 0) return dev.currentDrawKw;
  if (!isPlanDeviceObservedOff(dev)) return dev.currentDrawKw;
  // Reached only when the draw is 0, so the fallback arm is 0 — not "the draw".
  return getHighestKnownPowerKw(dev).kw;
};
