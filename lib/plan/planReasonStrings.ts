import {
  formatDeviceReason,
  PLAN_REASON_CODES,
  type DeviceReason,
  type PlanReasonCode,
} from '../../packages/shared-domain/src/planReasonSemantics';

export type ClassifiedPlanReason = {
  code: PlanReasonCode;
  reason: DeviceReason | undefined;
  text: string | undefined;
};

export type PlanReasonDecision =
  | { code: 'existing'; reason: DeviceReason }
  | { code: 'activation_backoff'; remainingMs: number }
  | { code: 'cooldown_shedding'; remainingSec: number | null }
  | { code: 'meter_settling'; remainingSec: number | null }
  | { code: 'restore_headroom'; params: {
    neededKw: number;
    availableKw: number | null;
    postReserveMarginKw: number;
    minimumRequiredPostReserveMarginKw: number;
    penaltyExtraKw?: number;
    swapReserveKw?: number;
    effectiveAvailableKw?: number;
    swapTargetName?: string;
  } }
  | { code: 'restore_pending'; remainingSec: number }
  | { code: 'shortfall'; neededKw: number; headroomKw: number | null };

function assertNever(value: never): never {
  throw new Error(`Unhandled plan reason decision: ${String((value as { code?: string }).code)}`);
}

export function classifyPlanReason(reason: DeviceReason | undefined): ClassifiedPlanReason {
  const text = reason ? formatDeviceReason(reason) : undefined;
  return {
    code: reason?.code ?? PLAN_REASON_CODES.none,
    reason,
    text: text || undefined,
  };
}

export function buildActivationBackoffReason(remainingMs: number): DeviceReason {
  return {
    code: PLAN_REASON_CODES.activationBackoff,
    remainingSec: Math.max(1, Math.ceil(remainingMs / 1000)),
  };
}

export function buildCooldownReason(kind: 'shedding' | 'restore', remainingSec: number | null): DeviceReason {
  const normalizedRemainingSec = remainingSec ?? 0;
  return kind === 'shedding'
    ? { code: PLAN_REASON_CODES.cooldownShedding, remainingSec: normalizedRemainingSec }
    : { code: PLAN_REASON_CODES.cooldownRestore, remainingSec: normalizedRemainingSec };
}

export function buildMeterSettlingReason(remainingSec: number | null): DeviceReason {
  return { code: PLAN_REASON_CODES.meterSettling, remainingSec: remainingSec ?? 0 };
}

export function buildRestoreNeedReason(neededKw: number, headroomKw: number | null): DeviceReason {
  return {
    code: PLAN_REASON_CODES.restoreNeed,
    fromTarget: null,
    toTarget: null,
    needKw: neededKw,
    headroomKw,
  };
}

export function buildRestoreHeadroomReason(params: {
  neededKw: number;
  availableKw: number | null;
  postReserveMarginKw: number;
  minimumRequiredPostReserveMarginKw: number;
  penaltyExtraKw?: number;
  swapReserveKw?: number;
  effectiveAvailableKw?: number;
  swapTargetName?: string;
}): DeviceReason {
  return {
    code: PLAN_REASON_CODES.insufficientHeadroom,
    needKw: params.neededKw,
    availableKw: params.availableKw,
    postReserveMarginKw: params.postReserveMarginKw,
    minimumRequiredPostReserveMarginKw: params.minimumRequiredPostReserveMarginKw,
    penaltyExtraKw: params.penaltyExtraKw ?? null,
    swapReserveKw: params.swapReserveKw ?? null,
    effectiveAvailableKw: params.effectiveAvailableKw ?? null,
    swapTargetName: params.swapTargetName ?? null,
  };
}

export function buildRestorePendingReason(remainingSec: number): DeviceReason {
  return { code: PLAN_REASON_CODES.restorePending, remainingSec };
}

export function buildShortfallReason(neededKw: number, headroomKw: number | null): DeviceReason {
  return { code: PLAN_REASON_CODES.shortfall, needKw: neededKw, headroomKw };
}

export function renderPlanReasonDecision(reason: PlanReasonDecision): DeviceReason {
  switch (reason.code) {
    case 'existing':
      return reason.reason;
    case 'activation_backoff':
      return buildActivationBackoffReason(reason.remainingMs);
    case 'cooldown_shedding':
      return buildCooldownReason('shedding', reason.remainingSec);
    case 'meter_settling':
      return buildMeterSettlingReason(reason.remainingSec);
    case 'restore_headroom':
      return buildRestoreHeadroomReason(reason.params);
    case 'restore_pending':
      return buildRestorePendingReason(reason.remainingSec);
    case 'shortfall':
      return buildShortfallReason(reason.neededKw, reason.headroomKw);
    default:
      return assertNever(reason);
  }
}
