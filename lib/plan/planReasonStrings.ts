import {
  formatDeviceReason,
  PLAN_REASON_CODES,
  type CountdownReasonTiming,
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
  | { code: 'activation_backoff'; remainingMs: number; countdownTiming?: CountdownReasonTiming }
  | { code: 'cooldown_shedding'; remainingSec: number | null; countdownTiming?: CountdownReasonTiming }
  | { code: 'meter_settling'; remainingSec: number | null; countdownTiming?: CountdownReasonTiming }
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
  | { code: 'restore_pending'; remainingSec: number; countdownTiming?: CountdownReasonTiming }
  | { code: 'shortfall'; neededKw: number; headroomKw: number };

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

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

function normalizeCountdownTiming(timing?: CountdownReasonTiming): CountdownReasonTiming {
  return {
    ...(isFiniteNumber(timing?.countdownStartedAtMs) ? { countdownStartedAtMs: timing.countdownStartedAtMs } : {}),
    ...(isFiniteNumber(timing?.countdownTotalSec) && timing.countdownTotalSec > 0
      ? { countdownTotalSec: Math.ceil(timing.countdownTotalSec) }
      : {}),
  };
}

function withCountdownTiming<Reason extends DeviceReason>(
  reason: Reason,
  timing?: CountdownReasonTiming,
): Reason {
  const countdownTiming = normalizeCountdownTiming(timing);
  return Object.keys(countdownTiming).length > 0
    ? { ...reason, ...countdownTiming }
    : reason;
}

export function buildActivationBackoffReason(
  remainingMs: number,
  countdownTiming?: CountdownReasonTiming,
): DeviceReason {
  return {
    code: PLAN_REASON_CODES.activationBackoff,
    remainingSec: Math.max(1, Math.ceil(remainingMs / 1000)),
    ...normalizeCountdownTiming(countdownTiming),
  };
}

export function buildCooldownReason(
  kind: 'shedding' | 'restore',
  remainingSec: number | null,
  countdownTiming?: CountdownReasonTiming,
): DeviceReason {
  const normalizedRemainingSec = remainingSec ?? 0;
  return kind === 'shedding'
    ? withCountdownTiming(
      { code: PLAN_REASON_CODES.cooldownShedding, remainingSec: normalizedRemainingSec },
      countdownTiming,
    )
    : withCountdownTiming(
      { code: PLAN_REASON_CODES.cooldownRestore, remainingSec: normalizedRemainingSec },
      countdownTiming,
    );
}

export function buildMeterSettlingReason(
  remainingSec: number | null,
  countdownTiming?: CountdownReasonTiming,
): DeviceReason {
  return withCountdownTiming(
    { code: PLAN_REASON_CODES.meterSettling, remainingSec: remainingSec ?? 0 },
    countdownTiming,
  );
}

export function buildRestoreNeedReason(neededKw: number, headroomKw: number): DeviceReason {
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

export function buildRestorePendingReason(
  remainingSec: number,
  countdownTiming?: CountdownReasonTiming,
): DeviceReason {
  return withCountdownTiming(
    { code: PLAN_REASON_CODES.restorePending, remainingSec },
    countdownTiming,
  );
}

export function buildShortfallReason(neededKw: number, headroomKw: number): DeviceReason {
  return { code: PLAN_REASON_CODES.shortfall, needKw: neededKw, headroomKw };
}

export function renderPlanReasonDecision(reason: PlanReasonDecision): DeviceReason {
  switch (reason.code) {
    case 'existing':
      return reason.reason;
    case 'activation_backoff':
      return buildActivationBackoffReason(reason.remainingMs, reason.countdownTiming);
    case 'cooldown_shedding':
      return buildCooldownReason('shedding', reason.remainingSec, reason.countdownTiming);
    case 'meter_settling':
      return buildMeterSettlingReason(reason.remainingSec, reason.countdownTiming);
    case 'restore_headroom':
      return buildRestoreHeadroomReason(reason.params);
    case 'restore_pending':
      return buildRestorePendingReason(reason.remainingSec, reason.countdownTiming);
    case 'shortfall':
      return buildShortfallReason(reason.neededKw, reason.headroomKw);
    default:
      return assertNever(reason);
  }
}
