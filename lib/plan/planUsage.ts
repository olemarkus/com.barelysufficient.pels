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

export const sumBudgetExemptProjectedUsageKw = (devices: UsageDevice[]): number => {
  let totalKw = 0;
  for (const dev of devices) {
    if (dev.budgetExempt !== true || dev.controllable === false) continue;
    totalKw += resolveBudgetExemptProjectedKw(dev);
  }
  return totalKw;
};

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
 * (`sumBudgetExemptMeasuredUsageKw` in `lib/power/usageAttribution.ts`) is what
 * restore admission spends.
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
