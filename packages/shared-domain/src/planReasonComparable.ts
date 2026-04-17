import {
  PLAN_REASON_CODES,
  type DeviceReason,
  type PlanReasonCode,
} from './planReasonSemanticsCore.js';

type ComparablePlanReasonBase = {
  code: PlanReasonCode;
};

type ComparableTextReason = ComparablePlanReasonBase & {
  text: string;
};

export type ComparablePlanReason =
  | ComparablePlanReasonBase
  | (ComparablePlanReasonBase & { detail: string | null })
  | (ComparablePlanReasonBase & { targetName: string | null })
  | (ComparablePlanReasonBase & {
    kind: 'recent_pels_shed' | 'recent_pels_restore' | 'usage_step_down';
  })
  | (ComparablePlanReasonBase & {
    fromTarget: string | null;
    toTarget: string | null;
    needKw: number;
    headroomKw: number | null;
  })
  | (ComparablePlanReasonBase & { needKw: number | null; headroomKw: number | null })
  | (ComparablePlanReasonBase & {
    needKw: number;
    availableKw: number | null;
    postReserveMarginKw: number | null;
    minimumRequiredPostReserveMarginKw: number | null;
    penaltyExtraKw: number | null;
    swapReserveKw: number | null;
    effectiveAvailableKw: number | null;
    swapTargetName: string | null;
  })
  | (ComparablePlanReasonBase & {
    fromStep: string;
    toStep: string;
    shedDeviceCount: number;
    maxStep: string;
  })
  | ComparableTextReason;

type DetailComparableReason = Extract<
  DeviceReason,
  | { code: typeof PLAN_REASON_CODES.keep }
  | { code: typeof PLAN_REASON_CODES.inactive }
  | { code: typeof PLAN_REASON_CODES.hourlyBudget }
  | { code: typeof PLAN_REASON_CODES.dailyBudget }
  | { code: typeof PLAN_REASON_CODES.sheddingActive }
  | { code: typeof PLAN_REASON_CODES.capacity }
>;

const CODE_ONLY_REASONS = new Set<PlanReasonCode>([
  PLAN_REASON_CODES.none,
  PLAN_REASON_CODES.restoreThrottled,
  PLAN_REASON_CODES.waitingForOtherDevices,
  PLAN_REASON_CODES.cooldownShedding,
  PLAN_REASON_CODES.cooldownRestore,
  PLAN_REASON_CODES.meterSettling,
  PLAN_REASON_CODES.activationBackoff,
  PLAN_REASON_CODES.restorePending,
  PLAN_REASON_CODES.neutralStartupHold,
  PLAN_REASON_CODES.startupStabilization,
  PLAN_REASON_CODES.capacityControlOff,
]);

type CodeOnlyReason = Extract<
  DeviceReason,
  | { code: typeof PLAN_REASON_CODES.none }
  | { code: typeof PLAN_REASON_CODES.restoreThrottled }
  | { code: typeof PLAN_REASON_CODES.waitingForOtherDevices }
  | { code: typeof PLAN_REASON_CODES.cooldownShedding }
  | { code: typeof PLAN_REASON_CODES.cooldownRestore }
  | { code: typeof PLAN_REASON_CODES.meterSettling }
  | { code: typeof PLAN_REASON_CODES.activationBackoff }
  | { code: typeof PLAN_REASON_CODES.restorePending }
  | { code: typeof PLAN_REASON_CODES.neutralStartupHold }
  | { code: typeof PLAN_REASON_CODES.startupStabilization }
  | { code: typeof PLAN_REASON_CODES.capacityControlOff }
>;

function isCodeOnlyReason(reason: DeviceReason): reason is CodeOnlyReason {
  return CODE_ONLY_REASONS.has(reason.code);
}

function isDetailComparableReason(reason: DeviceReason): reason is DetailComparableReason {
  return reason.code === PLAN_REASON_CODES.keep
    || reason.code === PLAN_REASON_CODES.inactive
    || reason.code === PLAN_REASON_CODES.hourlyBudget
    || reason.code === PLAN_REASON_CODES.dailyBudget
    || reason.code === PLAN_REASON_CODES.sheddingActive
    || reason.code === PLAN_REASON_CODES.capacity;
}

export function buildComparableDeviceReason(reason: DeviceReason | undefined): ComparablePlanReason {
  if (!reason) return { code: PLAN_REASON_CODES.none };
  if (isCodeOnlyReason(reason)) return { code: reason.code };
  if (isDetailComparableReason(reason)) return { code: reason.code, detail: reason.detail };

  switch (reason.code) {
    case PLAN_REASON_CODES.swapPending:
    case PLAN_REASON_CODES.swappedOut:
      return { code: reason.code, targetName: reason.targetName };
    case PLAN_REASON_CODES.headroomCooldown:
      return { code: reason.code, kind: reason.kind };
    case PLAN_REASON_CODES.restoreNeed:
      return {
        code: reason.code,
        fromTarget: reason.fromTarget,
        toTarget: reason.toTarget,
        needKw: reason.needKw,
        headroomKw: reason.headroomKw,
      };
    case PLAN_REASON_CODES.shortfall:
      return { code: reason.code, needKw: reason.needKw, headroomKw: reason.headroomKw };
    case PLAN_REASON_CODES.insufficientHeadroom:
      return {
        code: reason.code,
        needKw: reason.needKw,
        availableKw: reason.availableKw,
        postReserveMarginKw: reason.postReserveMarginKw,
        minimumRequiredPostReserveMarginKw: reason.minimumRequiredPostReserveMarginKw,
        penaltyExtraKw: reason.penaltyExtraKw,
        swapReserveKw: reason.swapReserveKw,
        effectiveAvailableKw: reason.effectiveAvailableKw,
        swapTargetName: reason.swapTargetName,
      };
    case PLAN_REASON_CODES.setTarget:
      return { code: reason.code, text: reason.targetText };
    case PLAN_REASON_CODES.shedInvariant:
      return {
        code: reason.code,
        fromStep: reason.fromStep,
        toStep: reason.toStep,
        shedDeviceCount: reason.shedDeviceCount,
        maxStep: reason.maxStep,
      };
    case PLAN_REASON_CODES.other:
      return { code: reason.code, text: reason.text };
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
