import type { DevicePlanDevice } from './planTypes';
import type { ShedDecisions } from './shedDecisions';
import {
  clampToLowestActiveWhenFairnessLimited, isPlanDeviceObservedOff, isSteppedLoadDevice,
} from './planSteppedLoad';
import { countFinalFairnessLimitedDevices } from './restore/coordination';
import { getSteppedLoadLowestActiveStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';

/**
 * Restore can keep a previously limited peer off after the initial keep clamp
 * has run. Reconcile that final posture without spending the planned relief:
 * the next measured cycle, not this pass's admission ledger, sees the lower draw.
 */
export function reconcileSteppedKeepFairness(
  planDevices: readonly DevicePlanDevice[],
  shedDecisions: ShedDecisions,
): DevicePlanDevice[] {
  const deviceMap = new Map(planDevices.map((device) => [device.id, device]));
  return planDevices.map((device) => {
    if (!isSteppedLoadDevice(device) || device.plannedState !== 'keep'
      || !device.control.commandAuthority || isPlanDeviceObservedOff(device)
      // This admission was priced at its named rung; do not rewrite it after the pass.
      || device.reason.code === PLAN_REASON_CODES.restoreNeed) return device;
    const lowest = getSteppedLoadLowestActiveStep(device.steppedLoadProfile);
    if (!lowest) return device;
    const desiredStepId = clampToLowestActiveWhenFairnessLimited(
      device.steppedLoadProfile, device.desiredStepId, lowest,
      countFinalFairnessLimitedDevices(deviceMap, device, shedDecisions) > 0,
    );
    if (desiredStepId === device.desiredStepId) return device;
    // Fairness now owns this reduction, even if the solar ceiling lowered it first.
    const { nonCapacityHoldShed: _solarOnlyReduction, ...capacityLimited } = device;
    return { ...capacityLimited, desiredStepId };
  });
}
