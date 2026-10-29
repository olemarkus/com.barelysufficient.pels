import type { DevicePlanDevice, SteppedFairnessHold } from './planTypes';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { countShedDevices } from './restore/coordination';
import type { ShedDecisions } from './shedDecisions';
import {
  getSteppedLoadHighestStep,
  getSteppedLoadLowestActiveStep,
} from '../../packages/shared-domain/src/deviceControlProfiles';
import { PLAN_REASON_CODES, type PlanReasonCode } from '../../packages/shared-domain/src/planReasonSemantics';

// The reasons the fairness hold explains better than they do. Each is a power hold
// whose line states this device's own gap ("6.0 kW more needed": what it needs to
// reach its top step, not what the house is over by), or a timing step of the same
// hold ("Waiting after limiting a device"), or no line at all (`keep` on a device
// running at its low step). While the rule keeps the device from stepping up,
// other devices resuming is what lifts it, so the card says that for as long as it
// is true. `restoreNeed` is absent: at the lowest step it is a start from off, and
// the card says the device is turning on.
//
// Deliberately absent: holds whose remedy is something else. A spent period
// (`hourlyBudget`), the end-of-hour drain and a silent meter are not lifted by other
// devices resuming; the owner's own postures, smart tasks and charge targets are
// not power holds at all; a startup reservation names its holder. The restore
// lane's own timers and queue (`cooldownRestore`, `restorePending`,
// `waitingForOtherDevices`, `restoreThrottled`, `activationBackoff`) keep their
// lines too: while the restore cooldown runs, its countdown and the cohort queue
// line say what holds every device (notes/ui-terminology.md).
const FAIRNESS_EXPLAINS_REASON_CODES: ReadonlySet<PlanReasonCode> = new Set([
  PLAN_REASON_CODES.keep,
  PLAN_REASON_CODES.shedInvariant,
  PLAN_REASON_CODES.capacity,
  PLAN_REASON_CODES.gridImport,
  PLAN_REASON_CODES.dailyBudget,
  PLAN_REASON_CODES.insufficientHeadroom,
  PLAN_REASON_CODES.shortfall,
  PLAN_REASON_CODES.swapPending,
  PLAN_REASON_CODES.swappedOut,
  PLAN_REASON_CODES.cooldownShedding,
  PLAN_REASON_CODES.meterSettling,
]);

const resolveSteppedFairnessHold = (
  device: DevicePlanDevice,
  deviceMap: Map<string, DevicePlanDevice>,
  shedDecisions: ShedDecisions,
): SteppedFairnessHold | null => {
  if (!isSteppedLoadDevice(device)) return null;
  // Boost bypasses the rule; a non-capacity reduction is not the rule's doing; a
  // device tracking solar surplus is capped by its surplus ceiling, which the card
  // states on its own.
  if (device.boostActive || device.nonCapacityHoldShed === true || device.surplusTracking === true) return null;
  if (!device.control.commandAuthority || device.plannedState === 'inactive') return null;
  // An off device at its lowest step is starting, not being held there.
  if (device.currentState === 'off') return null;
  if (!FAIRNESS_EXPLAINS_REASON_CODES.has(device.reason.code)) return null;
  const lowest = getSteppedLoadLowestActiveStep(device.steppedLoadProfile);
  const highest = getSteppedLoadHighestStep(device.steppedLoadProfile);
  if (!lowest || !highest || lowest.id === highest.id || device.desiredStepId !== lowest.id) return null;
  // The count the restore side refuses step-ups on. A cycle whose restore was
  // refused already carries it in its reason; device detail formats that reason,
  // so the card states the same number.
  const limitedDeviceCount = device.reason.code === PLAN_REASON_CODES.shedInvariant
    ? device.reason.shedDeviceCount
    : countShedDevices(deviceMap, device.id, shedDecisions);
  return limitedDeviceCount > 0 ? { stepId: lowest.id, limitedDeviceCount } : null;
};

/**
 * Stamp the stepped fairness hold on the devices it holds this cycle, from the
 * final plan. While another device is limited, a stepped device may not step up
 * past its lowest active step (`blockSteppedRestoreForShedInvariant`), and a
 * `set_step` cut goes straight to that step while an on/off device is recovering
 * (`resolveSteppedShedTargetStep`). Neither side owns `reason` for long: a cut
 * writes the shed reason, then the shed cooldown and `keep` take over, and
 * `shedInvariant` appears only on a cycle where a restore was tried. So the
 * condition is resolved here, from state, and the card reads it instead of
 * whichever reason the cycle last wrote. Presentation only: actuation keeps
 * reading `reason`. Plan devices are rebuilt from input every cycle, so a device
 * the rule no longer holds simply carries no stamp.
 */
export function stampSteppedFairnessHolds(
  planDevices: DevicePlanDevice[],
  shedDecisions: ShedDecisions,
): DevicePlanDevice[] {
  const deviceMap = new Map(planDevices.map((device) => [device.id, device]));
  return planDevices.map((device) => {
    const hold = resolveSteppedFairnessHold(device, deviceMap, shedDecisions);
    return hold ? { ...device, steppedFairnessHold: hold } : device;
  });
}
