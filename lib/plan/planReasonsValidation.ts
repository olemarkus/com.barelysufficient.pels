import { isTemperaturePlanDevice } from './planTemperatureDevice';
import type { DevicePlanDevice } from './planTypes';
import {
  PLAN_REASON_CODES,
  type PlanReasonCode,
} from '../../packages/shared-domain/src/planReasonSemantics';
import { sortByPriorityAsc } from './planSort';
import { resolvePlannedShedTargetKind } from './planActionMaterialization';

export type PlanReasonPairValidationIssue = {
  deviceId: string;
  deviceName: string;
  plannedState: string;
  reasonCode: string;
  allowedReasonCodes: string[];
  // Set instead of a prose label when the code IS allowed for the state but the
  // device lacks the posture flag the code asserts. Naming the flags is the fact;
  // the sentence that used to sit here restated them.
  requiredFlags?: readonly string[];
};

type ReasonCodeRule = {
  code: PlanReasonCode;
};

const KEEP_REASON_RULES: readonly ReasonCodeRule[] = [
  { code: PLAN_REASON_CODES.keep },
  { code: PLAN_REASON_CODES.restoreNeed },
  { code: PLAN_REASON_CODES.cooldownShedding },
  { code: PLAN_REASON_CODES.cooldownRestore },
  { code: PLAN_REASON_CODES.meterSettling },
  { code: PLAN_REASON_CODES.restoreThrottled },
  { code: PLAN_REASON_CODES.waitingForOtherDevices },
  { code: PLAN_REASON_CODES.activationBackoff },
  { code: PLAN_REASON_CODES.insufficientHeadroom },
  { code: PLAN_REASON_CODES.restorePending },
  { code: PLAN_REASON_CODES.swapPending },
  { code: PLAN_REASON_CODES.shedInvariant },
  { code: PLAN_REASON_CODES.reservedForStart },
  { code: PLAN_REASON_CODES.startupStabilization },
  { code: PLAN_REASON_CODES.capacityControlOff },
] as const;

const SHED_REASON_RULES: readonly ReasonCodeRule[] = [
  { code: PLAN_REASON_CODES.capacity },
  { code: PLAN_REASON_CODES.hourlyBudget },
  { code: PLAN_REASON_CODES.dailyBudget },
  { code: PLAN_REASON_CODES.deferredObjectiveAvoid },
  { code: PLAN_REASON_CODES.awaitingSolarSurplus },
  // The "Only PELS starts this device" hold. Legal for `shed` and nothing else:
  // the posture's whole expression IS a standing shed intent, and it is
  // PERMANENT by design — a device with no smart task carries it on every build,
  // forever. An earlier draft of this feature shipped the hold without this
  // line, so every affected device logged `plan_reason_pair_invalid` on every
  // rebuild; the lesson is that a new reason is not landed until a full build
  // has produced it (`test/integration/startPolicyPlanBuild.test.ts`).
  { code: PLAN_REASON_CODES.awaitingPelsStart },
  { code: PLAN_REASON_CODES.neutralStartupHold },
  { code: PLAN_REASON_CODES.shortfall },
  { code: PLAN_REASON_CODES.cooldownShedding },
  { code: PLAN_REASON_CODES.cooldownRestore },
  { code: PLAN_REASON_CODES.meterSettling },
  { code: PLAN_REASON_CODES.restoreThrottled },
  { code: PLAN_REASON_CODES.restorePending },
  { code: PLAN_REASON_CODES.waitingForOtherDevices },
  { code: PLAN_REASON_CODES.activationBackoff },
  { code: PLAN_REASON_CODES.insufficientHeadroom },
  { code: PLAN_REASON_CODES.swapPending },
  { code: PLAN_REASON_CODES.swappedOut },
  { code: PLAN_REASON_CODES.reservedForStart },
  { code: PLAN_REASON_CODES.startupStabilization },
] as const;

/**
 * Reasons that require a producer-resolved posture flag on the same device.
 * See the cross-field invariant in `validatePlanReasonPair`.
 */
const REASON_REQUIRED_FLAGS = [
  {
    code: PLAN_REASON_CODES.awaitingSolarSurplus,
    // Either surplus posture that can hold a device OFF earns the reason: the
    // binary dump load, and a tracking device whose allocation clamped it to an
    // off rung. A tracking device under the `'minimum'` floor is limited rather
    // than held, so it never carries this code in the first place.
    flags: ['surplusOnly', 'surplusTracking'],
  },
  {
    code: PLAN_REASON_CODES.externalOffHold,
    flags: ['externalOffHoldActive'],
  },
] as const satisfies readonly {
  code: PlanReasonCode;
  flags: readonly (keyof DevicePlanDevice)[];
}[];

// `awaitingPelsStart` has no entry here on purpose. The posture it implies is
// `startPolicy === 'pels_only'`, which lives on the plan INPUT and is not copied
// onto the plan device — this table can only test a boolean flag on the output.
// Adding the field to `DevicePlanDevice` to satisfy the table would put a second
// copy of an owner setting on the wire for one assertion's sake; the reason has
// exactly one producer (`resolveStartPolicyHold`), which is keyed on that
// policy, so there is no second path for the pair to come apart on.

const INACTIVE_REASON_RULES: readonly ReasonCodeRule[] = [
  { code: PLAN_REASON_CODES.inactive },
  { code: PLAN_REASON_CODES.externalOffHold },
  // The start-policy hold is legal in BOTH states, and the pair is the whole
  // lifecycle: `shed` while the device is still running (which is what actuates
  // the turn-off), `inactive` once it is off (which is what makes the card read
  // `Off`). See `getInactiveReason`.
  { code: PLAN_REASON_CODES.awaitingPelsStart },
] as const;

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

// Listed only on a failure: every device on every build passes through the
// validator, and building the list (or a closure that would) for the passing
// case was an allocation for nobody.
const listReasonCodes = (rules: readonly ReasonCodeRule[]): string[] => rules.map((rule) => rule.code);

/**
 * The rule whose reason `dev` carries without the posture flag it requires, or
 * null when the reason needs no flag or the flag is set. Plain loops, not
 * `find`/`some`: this runs for every device on every build, and each closure was
 * an allocation for a lookup over two rules.
 */
function resolveUnsatisfiedRequiredFlag(
  dev: DevicePlanDevice,
  reasonCode: string,
): (typeof REASON_REQUIRED_FLAGS)[number] | null {
  for (const rule of REASON_REQUIRED_FLAGS) {
    if (rule.code !== reasonCode) continue;
    for (const flag of rule.flags) {
      if (dev[flag] === true) return null;
    }
    return rule;
  }
  return null;
}

function validatePlanReasonPair(dev: DevicePlanDevice): PlanReasonPairValidationIssue | null {
  const plannedState = typeof dev.plannedState === 'string' ? dev.plannedState.trim() : '';
  const reasonCode = dev.reason.code;
  const allowedReasonRules = getAllowedReasonRules(plannedState);

  if (!plannedState || allowedReasonRules.length === 0) {
    return {
      deviceId: dev.id,
      deviceName: dev.name,
      plannedState: plannedState || '<empty>',
      reasonCode,
      allowedReasonCodes: listReasonCodes(allowedReasonRules),
    };
  }

  // Plain loops, not `some`/`find`: this runs for every device on every build,
  // and each closure was an allocation for a lookup over a handful of rules.
  let allowed = false;
  for (const rule of allowedReasonRules) {
    if (rule.code === reasonCode) { allowed = true; break; }
  }
  if (!allowed) {
    return {
      deviceId: dev.id,
      deviceName: dev.name,
      plannedState,
      reasonCode,
      allowedReasonCodes: listReasonCodes(allowedReasonRules),
    };
  }

  // Cross-field invariant: each of these reasons is meaningful ONLY on a device
  // the producer resolved into the matching posture. Attaching one elsewhere
  // mis-attributes the device's state to the user — `awaitingSolarSurplus` would
  // hide a real capacity/budget hold behind a deliberate-posture classification,
  // and `externalOffHold` would claim PELS is respecting an off action it never
  // observed. Cheap to check at finalization; a violation is a planner bug.
  const requiredFlag = resolveUnsatisfiedRequiredFlag(dev, reasonCode);
  if (requiredFlag) {
    return {
      deviceId: dev.id,
      deviceName: dev.name,
      plannedState,
      reasonCode,
      allowedReasonCodes: listReasonCodes(allowedReasonRules),
      requiredFlags: requiredFlag.flags,
    };
  }

  return null;
}

// The message of a thrown developer error, not a log field — it is read by a
// human reading a stack trace, and carries codes rather than rendered labels so
// it says the same thing the structured `plan_reason_pair_invalid` event does.
function formatPlanReasonPairIssue(issue: PlanReasonPairValidationIssue): string {
  const allowed = issue.allowedReasonCodes.join(', ') || '<none>';
  const required = issue.requiredFlags ? `, requiredFlags=${issue.requiredFlags.join('|')}` : '';
  return `Invalid plan reason pair for ${issue.deviceName} (${issue.deviceId}): `
    + `plannedState=${issue.plannedState}, reasonCode=${issue.reasonCode}, allowed=${allowed}${required}`;
}

export function finalizePlanDevices(
  planDevices: DevicePlanDevice[],
  /** This build's capability-normalized configured shed floor per device
   * (`resolveNormalizedShedFloors`) — the restore classification below reads
   * it, never raw config. */
  normalizedShedFloorCByDevice: ReadonlyMap<string, number>,
  /** The PREVIOUS build's final shed set: the restore classification counts a
   * raise off it even when the device no longer sits at the configured floor,
   * which is how a mid-hold floor edit still classifies as a restore. */
  wasShedLastBuild: ReadonlySet<string>,
  options?: {
    onInvalidReasonPair?: (issue: PlanReasonPairValidationIssue) => void;
    throwOnInvalid?: boolean;
  },
): {
  planDevices: DevicePlanDevice[];
  lastPlannedShedIds: Set<string>;
} {
  // Stamp the shed END STATE here and nowhere else. The restore, swap, and hold
  // stages each revise `plannedState` through their own paths, so a kind derived
  // at device-build time would be stale by the time the plan leaves the builder;
  // this is the last transform before `DevicePlan.devices`, so what it sees is
  // the decision. See `PlannedShedTargetKind`. The restore classification
  // (`recordRestoreOnTargetApply`) is stamped here for the same reason, from
  // the same decision-of-record view.
  const stamped = planDevices.map((dev): DevicePlanDevice => ({
    ...dev,
    plannedShedTargetKind: resolvePlannedShedTargetKind(dev),
    recordRestoreOnTargetApply: resolveRecordRestoreOnTargetApply(dev, normalizedShedFloorCByDevice, wasShedLastBuild),
  }));
  const sorted = sortByPriorityAsc(stamped);
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

/**
 * Planner-resolved restore classification for the executor's target lane
 * (semantics on the `DevicePlanDevice.recordRestoreOnTargetApply` docblock):
 * the device's observed setpoint sits AT a shed floor and this plan RAISES
 * it — applying that write is a restore, and the executor stamps the restore
 * clocks when it lands.
 *
 * Two independent signals, either of which makes the raise a restore, because
 * each covers the case the other misses:
 *
 * - The device sits at this build's capability-normalized configured floor.
 *   Survives a restart, where nothing in memory remembers the shed.
 * - PELS had it in the shed set on the previous build. Survives a mid-hold
 *   floor edit, where the device is still parked at the OLD floor and comparing
 *   against the configured one finds nothing.
 *
 * Comparing the RAW configured floor missed every off-step floor, which is why
 * the normalized map exists.
 */
function resolveRecordRestoreOnTargetApply(
  dev: DevicePlanDevice,
  normalizedShedFloorCByDevice: ReadonlyMap<string, number>,
  wasShedLastBuild: ReadonlySet<string>,
): boolean {
  if (!isTemperaturePlanDevice(dev)) return false;
  if (dev.plannedTarget <= dev.currentTarget) return false;
  return normalizedShedFloorCByDevice.get(dev.id) === dev.currentTarget
    || wasShedLastBuild.has(dev.id);
}
