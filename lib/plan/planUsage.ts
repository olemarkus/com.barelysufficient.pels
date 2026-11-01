import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import { getSteppedLoadLowestActiveStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import { getHighestKnownPowerKw } from '../observer/observedPower';
import { isPlanDeviceObservedOff } from './planSteppedLoad';
import { isMeteredPlanDevice } from './planMeteredDevice';
import type { MeteredKind } from './planTypes';

type UsageDevice = {
  budgetExempt: boolean;
  // Producer-resolved on/off truth, present iff the device is binary
  // (`binaryCapabilityId` set). A step-only stepper carries no `currentOn`; its
  // off-state is read from the step axis, so the stepped fields travel too.
  currentOn?: boolean;
  currentState?: string;
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
  currentDrawKw: number;
  expectedPowerKw: number;
  planningPowerKw?: number;
};

/**
 * Select the plan devices with a power axis without cloning them into a second
 * usage-shaped array. A device planned without a power reading has no draw to
 * attribute, so the whole-home meter counts it as background usage.
 */
export const toMeteredUsageDevices = <T extends { control: { commandAuthority: boolean } }>(
  devices: readonly T[],
): Array<T & MeteredKind> => (
  devices.filter((device): device is T & MeteredKind => isMeteredPlanDevice(device))
);

/**
 * `heldOffDeviceIds` is the previous plan's shed set
 * (`ShedDecisions.lastPlannedShedIds`): the devices PELS itself is keeping off.
 */
export const sumBudgetExemptProjectedUsageKw = <T extends UsageDevice & { id: string }>(
  devices: readonly T[],
  countsAsManaged: (device: T) => boolean,
  heldOffDeviceIds: ReadonlySet<string>,
): number => {
  let totalKw = 0;
  for (const dev of devices) {
    if (!dev.budgetExempt || !countsAsManaged(dev)) continue;
    totalKw += resolveBudgetExemptProjectedKw(dev, heldOffDeviceIds.has(dev.id));
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
 *
 * Two off devices claim less than their configured demand:
 * - One PELS is holding off claims only what it still draws. The plan is to
 *   keep its load away, so reserving its demand would only loosen daily-budget
 *   limiting for every other device while it waits (prod 2026-11-01: a boosted
 *   charger held off for the hard cap kept its 7 kW learned peak on this axis).
 * - A device with power steps claims the step it restarts at, its lowest active
 *   step, never its learned peak: a restart from off never jumps past that rung.
 */
const resolveBudgetExemptProjectedKw = (dev: UsageDevice, heldOffByPels: boolean): number => {
  if (heldOffByPels) return dev.currentDrawKw;
  if (dev.currentDrawKw > 0) return dev.currentDrawKw;
  if (!isPlanDeviceObservedOff(dev)) return dev.currentDrawKw;
  // Reached only when the draw is 0, so the fallback arm is 0 — not "the draw".
  if (dev.steppedLoadProfile) {
    const restartStep = getSteppedLoadLowestActiveStep(dev.steppedLoadProfile);
    return restartStep ? restartStep.planningPowerW / 1000 : 0;
  }
  return getHighestKnownPowerKw(dev).kw;
};
