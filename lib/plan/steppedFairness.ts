import type { PlanInputDevice } from './planTypes';
import { PLAN_REASON_CODES, type PlanReasonCode } from '../../packages/shared-domain/src/planReasonSemantics';

type FairnessDevice = Pick<PlanInputDevice, 'id' | 'priority'>;

const POWER_HOLD_REASON_CODES: ReadonlySet<PlanReasonCode> = new Set([
  PLAN_REASON_CODES.capacity,
  PLAN_REASON_CODES.gridImport,
  PLAN_REASON_CODES.phaseLimit,
  PLAN_REASON_CODES.dailyBudget,
  PLAN_REASON_CODES.insufficientHeadroom,
  PLAN_REASON_CODES.shortfall,
  PLAN_REASON_CODES.swapPending,
  PLAN_REASON_CODES.swappedOut,
]);

/** A lack of power, rather than a restore timer or queue, holds this device. */
export function isSteppedFairnessPowerHoldReason(code: PlanReasonCode): boolean {
  return POWER_HOLD_REASON_CODES.has(code);
}

/**
 * The priority rule shared by stepped selection, keep, restore and hold copy.
 * Callers establish which peers are limited or recovering from their stage's
 * facts. An active boost yields only to a peer ranked above it; otherwise any
 * limited peer counts. Priority 1 ranks highest. Power limits are independent.
 */
export function yieldsToLimitedDevice(
  device: FairnessDevice,
  boostActive: boolean,
  limitedDevice: FairnessDevice,
): boolean {
  return limitedDevice.id !== device.id
    && (!boostActive || limitedDevice.priority < device.priority);
}
