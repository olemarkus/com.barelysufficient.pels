import type { DevicePlanDevice } from './planTypes';
import {
  formatDeviceReason,
  PLAN_REASON_CODES,
  type PlanReasonCode,
} from '../../packages/shared-domain/src/planReasonSemantics';
import { sortByPriorityAsc } from './planSort';

export type PlanReasonPairValidationIssue = {
  deviceId: string;
  deviceName: string;
  plannedState: string;
  reason: string;
  allowedReasonKinds: string[];
};

type ReasonCodeRule = {
  code: PlanReasonCode;
  label: string;
};

const KEEP_REASON_RULES: readonly ReasonCodeRule[] = [
  { code: PLAN_REASON_CODES.keep, label: 'keep' },
  { code: PLAN_REASON_CODES.restoreNeed, label: 'stepped restore admission' },
  { code: PLAN_REASON_CODES.cooldownShedding, label: 'shedding cooldown' },
  { code: PLAN_REASON_CODES.cooldownRestore, label: 'restore cooldown' },
  { code: PLAN_REASON_CODES.meterSettling, label: 'meter settling' },
  { code: PLAN_REASON_CODES.restoreThrottled, label: 'restore throttle' },
  { code: PLAN_REASON_CODES.waitingForOtherDevices, label: 'recovery gate' },
  { code: PLAN_REASON_CODES.activationBackoff, label: 'activation backoff' },
  { code: PLAN_REASON_CODES.insufficientHeadroom, label: 'insufficient headroom' },
  { code: PLAN_REASON_CODES.restorePending, label: 'restore pending' },
  { code: PLAN_REASON_CODES.swapPending, label: 'swap pending' },
  { code: PLAN_REASON_CODES.shedInvariant, label: 'shed invariant' },
  { code: PLAN_REASON_CODES.reservedForStart, label: 'startup power reserved' },
  { code: PLAN_REASON_CODES.startupStabilization, label: 'startup stabilization' },
  { code: PLAN_REASON_CODES.capacityControlOff, label: 'capacity control off' },
] as const;

const SHED_REASON_RULES: readonly ReasonCodeRule[] = [
  { code: PLAN_REASON_CODES.capacity, label: 'capacity shed' },
  { code: PLAN_REASON_CODES.hourlyBudget, label: 'hourly budget shed' },
  { code: PLAN_REASON_CODES.dailyBudget, label: 'daily budget shed' },
  { code: PLAN_REASON_CODES.deferredObjectiveAvoid, label: 'deferred objective avoid' },
  { code: PLAN_REASON_CODES.awaitingSolarSurplus, label: 'awaiting solar surplus' },
  { code: PLAN_REASON_CODES.neutralStartupHold, label: 'neutral hold' },
  { code: PLAN_REASON_CODES.shortfall, label: 'shortfall shed' },
  { code: PLAN_REASON_CODES.cooldownShedding, label: 'shedding cooldown' },
  { code: PLAN_REASON_CODES.cooldownRestore, label: 'restore cooldown' },
  { code: PLAN_REASON_CODES.meterSettling, label: 'meter settling' },
  { code: PLAN_REASON_CODES.restoreThrottled, label: 'restore throttle' },
  { code: PLAN_REASON_CODES.restorePending, label: 'restore pending' },
  { code: PLAN_REASON_CODES.waitingForOtherDevices, label: 'recovery gate' },
  { code: PLAN_REASON_CODES.activationBackoff, label: 'activation backoff' },
  { code: PLAN_REASON_CODES.insufficientHeadroom, label: 'insufficient headroom' },
  { code: PLAN_REASON_CODES.swapPending, label: 'swap pending' },
  { code: PLAN_REASON_CODES.swappedOut, label: 'swapped out' },
  { code: PLAN_REASON_CODES.reservedForStart, label: 'startup power reserved' },
  { code: PLAN_REASON_CODES.startupStabilization, label: 'startup stabilization' },
] as const;

/**
 * Reasons that require a producer-resolved posture flag on the same device.
 * See the cross-field invariant in `findPlanReasonPairIssue`.
 */
const REASON_REQUIRED_FLAGS = [
  {
    code: PLAN_REASON_CODES.awaitingSolarSurplus,
    flag: 'surplusOnly',
    label: 'awaiting solar surplus requires surplusOnly',
  },
  {
    code: PLAN_REASON_CODES.externalOffHold,
    flag: 'externalOffHoldActive',
    label: 'external off hold requires externalOffHoldActive',
  },
] as const satisfies readonly {
  code: PlanReasonCode;
  flag: keyof DevicePlanDevice;
  label: string;
}[];

const INACTIVE_REASON_RULES: readonly ReasonCodeRule[] = [
  { code: PLAN_REASON_CODES.inactive, label: 'inactive' },
  { code: PLAN_REASON_CODES.externalOffHold, label: 'external off hold' },
] as const;

function stripCandidateReasons(dev: DevicePlanDevice): DevicePlanDevice {
  const { candidateReasons: _candidateReasons, ...snapshotDevice } = dev;
  return snapshotDevice;
}

function getAllowedReasonRules(plannedState: string): readonly ReasonCodeRule[] {
  switch (plannedState) {
    case 'keep':
      return KEEP_REASON_RULES;
    case 'shed':
      return SHED_REASON_RULES;
    case 'inactive':
      return INACTIVE_REASON_RULES;
    default:
      return [];
  }
}

function validatePlanReasonPair(dev: DevicePlanDevice): PlanReasonPairValidationIssue | null {
  const plannedState = typeof dev.plannedState === 'string' ? dev.plannedState.trim() : '';
  const reason = formatDeviceReason(dev.reason).trim();
  const reasonCode = dev.reason.code;
  const allowedReasonRules = getAllowedReasonRules(plannedState);
  const allowedReasonKinds = allowedReasonRules.map((rule) => rule.label);

  if (!plannedState || allowedReasonRules.length === 0) {
    return {
      deviceId: dev.id,
      deviceName: dev.name,
      plannedState: plannedState || '<empty>',
      reason: reason || '<empty>',
      allowedReasonKinds,
    };
  }

  if (!allowedReasonRules.some((rule) => rule.code === reasonCode)) {
    return {
      deviceId: dev.id,
      deviceName: dev.name,
      plannedState,
      reason,
      allowedReasonKinds,
    };
  }

  // Cross-field invariant: each of these reasons is meaningful ONLY on a device
  // the producer resolved into the matching posture. Attaching one elsewhere
  // mis-attributes the device's state to the user — `awaitingSolarSurplus` would
  // hide a real capacity/budget hold behind a deliberate-posture classification,
  // and `externalOffHold` would claim PELS is respecting an off action it never
  // observed. Cheap to check at finalization; a violation is a planner bug.
  const requiredFlag = REASON_REQUIRED_FLAGS.find((rule) => rule.code === reasonCode);
  if (requiredFlag && dev[requiredFlag.flag] !== true) {
    return {
      deviceId: dev.id,
      deviceName: dev.name,
      plannedState,
      reason,
      allowedReasonKinds: [requiredFlag.label],
    };
  }

  return null;
}

function formatPlanReasonPairIssue(issue: PlanReasonPairValidationIssue): string {
  const allowedKinds = issue.allowedReasonKinds.join(', ') || '<none>';
  return `Invalid plan reason pair for ${issue.deviceName} (${issue.deviceId}): `
    + `plannedState=${issue.plannedState}, reason=${issue.reason}, allowed=${allowedKinds}`;
}

export function finalizePlanDevices(
  planDevices: DevicePlanDevice[],
  options?: {
    onInvalidReasonPair?: (issue: PlanReasonPairValidationIssue) => void;
    throwOnInvalid?: boolean;
  },
): {
  planDevices: DevicePlanDevice[];
  lastPlannedShedIds: Set<string>;
} {
  const sorted = sortByPriorityAsc(planDevices).map(stripCandidateReasons);
  const issues = sorted
    .map(validatePlanReasonPair)
    .filter((issue): issue is PlanReasonPairValidationIssue => issue !== null);

  if (issues.length > 0) {
    for (const issue of issues) {
      options?.onInvalidReasonPair?.(issue);
    }
    if (options?.throwOnInvalid ?? process.env.NODE_ENV === 'test') {
      throw new Error(issues.map(formatPlanReasonPairIssue).join('\n'));
    }
  }

  const lastPlannedShedIds = new Set(sorted.filter((d) => d.plannedState === 'shed').map((d) => d.id));
  return { planDevices: sorted, lastPlannedShedIds };
}
