import {
  PLAN_REASON_CODES,
  type DeviceReason,
} from './planReasonSemanticsCore.js';

type DetailReason = Extract<
  DeviceReason,
  | { code: typeof PLAN_REASON_CODES.keep }
  | { code: typeof PLAN_REASON_CODES.hourlyBudget }
  | { code: typeof PLAN_REASON_CODES.dailyBudget }
  | { code: typeof PLAN_REASON_CODES.sheddingActive }
  | { code: typeof PLAN_REASON_CODES.inactive }
  | { code: typeof PLAN_REASON_CODES.capacity }
>;

type TimedReason = Extract<
  DeviceReason,
  | { code: typeof PLAN_REASON_CODES.cooldownShedding }
  | { code: typeof PLAN_REASON_CODES.cooldownRestore }
  | { code: typeof PLAN_REASON_CODES.meterSettling }
  | { code: typeof PLAN_REASON_CODES.activationBackoff }
  | { code: typeof PLAN_REASON_CODES.restorePending }
>;

type StaticReason = Extract<
  DeviceReason,
  | { code: typeof PLAN_REASON_CODES.none }
  | { code: typeof PLAN_REASON_CODES.restoreThrottled }
  | { code: typeof PLAN_REASON_CODES.waitingForOtherDevices }
  | { code: typeof PLAN_REASON_CODES.neutralStartupHold }
  | { code: typeof PLAN_REASON_CODES.startupStabilization }
  | { code: typeof PLAN_REASON_CODES.capacityControlOff }
>;

function formatSignedKw(value: number, digits: number): string {
  const factor = 10 ** digits;
  const epsilonAdjusted = value >= 0 ? value + Number.EPSILON : value - Number.EPSILON;
  return (Math.round(epsilonAdjusted * factor) / factor).toFixed(digits);
}

function formatRemainingSec(remainingSec: number): number {
  return Math.max(0, Math.trunc(remainingSec));
}

function formatShedReason(base: string, detail: string | null): string {
  return detail ? `${base} ${detail}` : base;
}

function isStaticReason(reason: DeviceReason): reason is StaticReason {
  return reason.code === PLAN_REASON_CODES.none
    || reason.code === PLAN_REASON_CODES.restoreThrottled
    || reason.code === PLAN_REASON_CODES.waitingForOtherDevices
    || reason.code === PLAN_REASON_CODES.neutralStartupHold
    || reason.code === PLAN_REASON_CODES.startupStabilization
    || reason.code === PLAN_REASON_CODES.capacityControlOff;
}

function formatStaticReason(reason: StaticReason): string {
  switch (reason.code) {
    case PLAN_REASON_CODES.none:
      return '';
    case PLAN_REASON_CODES.restoreThrottled:
      return 'restore throttled';
    case PLAN_REASON_CODES.waitingForOtherDevices:
      return 'waiting for other devices to recover';
    case PLAN_REASON_CODES.neutralStartupHold:
      return 'left off';
    case PLAN_REASON_CODES.startupStabilization:
      return 'startup stabilization';
    case PLAN_REASON_CODES.capacityControlOff:
      return 'capacity control off';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function isDetailReason(reason: DeviceReason): reason is DetailReason {
  return reason.code === PLAN_REASON_CODES.keep
    || reason.code === PLAN_REASON_CODES.hourlyBudget
    || reason.code === PLAN_REASON_CODES.dailyBudget
    || reason.code === PLAN_REASON_CODES.sheddingActive
    || reason.code === PLAN_REASON_CODES.inactive
    || reason.code === PLAN_REASON_CODES.capacity;
}

function formatDetailReason(reason: DetailReason): string {
  switch (reason.code) {
    case PLAN_REASON_CODES.keep:
      return reason.detail ? `keep (${reason.detail})` : 'keep';
    case PLAN_REASON_CODES.hourlyBudget:
      return formatShedReason('shed due to hourly budget', reason.detail);
    case PLAN_REASON_CODES.dailyBudget:
      return formatShedReason('shed due to daily budget', reason.detail);
    case PLAN_REASON_CODES.sheddingActive:
      return formatShedReason('shedding active', reason.detail);
    case PLAN_REASON_CODES.inactive:
      return reason.detail ? `inactive (${reason.detail})` : 'inactive';
    case PLAN_REASON_CODES.capacity:
      return formatShedReason('shed due to capacity', reason.detail);
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function isTimedReason(reason: DeviceReason): reason is TimedReason {
  return reason.code === PLAN_REASON_CODES.cooldownShedding
    || reason.code === PLAN_REASON_CODES.cooldownRestore
    || reason.code === PLAN_REASON_CODES.meterSettling
    || reason.code === PLAN_REASON_CODES.activationBackoff
    || reason.code === PLAN_REASON_CODES.restorePending;
}

function formatTimedReason(reason: TimedReason): string {
  const remainingSec = formatRemainingSec(reason.remainingSec);
  switch (reason.code) {
    case PLAN_REASON_CODES.cooldownShedding:
      return `cooldown (shedding, ${remainingSec}s remaining)`;
    case PLAN_REASON_CODES.cooldownRestore:
      return `cooldown (restore, ${remainingSec}s remaining)`;
    case PLAN_REASON_CODES.meterSettling:
      return `meter settling (${remainingSec}s remaining)`;
    case PLAN_REASON_CODES.activationBackoff:
      return `activation backoff (${remainingSec}s remaining)`;
    case PLAN_REASON_CODES.restorePending:
      return `restore pending (${remainingSec}s remaining)`;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function formatRestoreNeed(reason: Extract<DeviceReason, { code: typeof PLAN_REASON_CODES.restoreNeed }>): string {
  if (reason.fromTarget !== null && reason.toTarget !== null) {
    return `restore ${reason.fromTarget} -> ${reason.toTarget} (need ${formatSignedKw(reason.needKw, 2)}kW)`;
  }
  const headroom = reason.headroomKw === null ? 'unknown' : formatSignedKw(reason.headroomKw, 2);
  return `restore (need ${formatSignedKw(reason.needKw, 2)}kW, headroom ${headroom}kW)`;
}

function formatShortfall(reason: Extract<DeviceReason, { code: typeof PLAN_REASON_CODES.shortfall }>): string {
  if (reason.needKw === null && reason.headroomKw === null) return 'shortfall';
  const headroom = reason.headroomKw === null ? 'unknown' : formatSignedKw(reason.headroomKw, 2);
  return `shortfall (need ${formatSignedKw(reason.needKw ?? 0, 2)}kW, headroom ${headroom}kW)`;
}

function formatHeadroomCooldown(
  reason: Extract<DeviceReason, { code: typeof PLAN_REASON_CODES.headroomCooldown }>,
): string {
  const remainingSec = formatRemainingSec(reason.remainingSec);
  if (reason.kind === 'recent_pels_shed') {
    return `headroom cooldown (${remainingSec}s remaining; recent PELS shed)`;
  }
  if (reason.kind === 'recent_pels_restore') {
    return `headroom cooldown (${remainingSec}s remaining; recent PELS restore)`;
  }
  const fromKw = reason.fromKw === null ? 'unknown' : formatSignedKw(reason.fromKw, 2);
  const toKw = reason.toKw === null ? 'unknown' : formatSignedKw(reason.toKw, 2);
  return `headroom cooldown (${remainingSec}s remaining; usage step down from ${fromKw}kW to ${toKw}kW)`;
}

function formatNeedSummary(
  reason: Extract<DeviceReason, { code: typeof PLAN_REASON_CODES.insufficientHeadroom }>,
): string {
  const penaltyExtraKw = reason.penaltyExtraKw ?? 0;
  if (penaltyExtraKw > 0) {
    const baseNeedKw = reason.needKw - penaltyExtraKw;
    return `effective need ${formatSignedKw(reason.needKw, 2)}kW `
      + `(base ${formatSignedKw(baseNeedKw, 2)}kW + penalty ${formatSignedKw(penaltyExtraKw, 2)}kW)`;
  }
  return `need ${formatSignedKw(reason.needKw, 2)}kW`;
}

function formatAvailableSummary(
  reason: Extract<DeviceReason, { code: typeof PLAN_REASON_CODES.insufficientHeadroom }>,
): string {
  return reason.availableKw === null
    ? 'headroom unknown'
    : `available ${formatSignedKw(reason.availableKw, 2)}kW`;
}

function formatEffectiveSummary(
  reason: Extract<DeviceReason, { code: typeof PLAN_REASON_CODES.insufficientHeadroom }>,
): string | null {
  if (reason.effectiveAvailableKw === null || reason.swapReserveKw === null) return null;
  return `effective ${formatSignedKw(reason.effectiveAvailableKw, 2)}kW after `
    + `${formatSignedKw(reason.swapReserveKw, 2)}kW swap reserve`;
}

function formatPostReserveMarginSummary(
  reason: Extract<DeviceReason, { code: typeof PLAN_REASON_CODES.insufficientHeadroom }>,
): string | null {
  if (reason.postReserveMarginKw === null || reason.minimumRequiredPostReserveMarginKw === null) {
    return null;
  }
  return `post-reserve margin ${formatSignedKw(reason.postReserveMarginKw, 3)}kW < `
    + `${formatSignedKw(reason.minimumRequiredPostReserveMarginKw, 3)}kW`;
}

function formatInsufficientHeadroom(
  reason: Extract<DeviceReason, { code: typeof PLAN_REASON_CODES.insufficientHeadroom }>,
): string {
  const prefix = reason.swapTargetName
    ? `insufficient headroom to swap for ${reason.swapTargetName}`
    : 'insufficient headroom to restore';
  const needSummary = formatNeedSummary(reason);
  const availableSummary = formatAvailableSummary(reason);
  const effectiveSummary = formatEffectiveSummary(reason);
  const postReserveMarginSummary = formatPostReserveMarginSummary(reason);

  if (reason.availableKw === null) {
    return `${prefix} (${needSummary}, ${availableSummary})`;
  }
  if (effectiveSummary && reason.effectiveAvailableKw !== null && reason.effectiveAvailableKw < reason.needKw) {
    return `${prefix} (${needSummary}, ${availableSummary}, ${effectiveSummary})`;
  }
  if (reason.availableKw < reason.needKw || !postReserveMarginSummary) {
    return `${prefix} (${needSummary}, ${availableSummary})`;
  }
  const reserveSummary = effectiveSummary ? `${effectiveSummary}, ` : '';
  return `${prefix} after reserves (${needSummary}, ${availableSummary}, ${reserveSummary}${postReserveMarginSummary})`;
}

export function formatDeviceReason(reason: DeviceReason): string {
  if (isStaticReason(reason)) return formatStaticReason(reason);
  if (isDetailReason(reason)) return formatDetailReason(reason);
  if (isTimedReason(reason)) return formatTimedReason(reason);

  switch (reason.code) {
    case PLAN_REASON_CODES.restoreNeed:
      return formatRestoreNeed(reason);
    case PLAN_REASON_CODES.setTarget:
      return `set to ${reason.targetText}`;
    case PLAN_REASON_CODES.swapPending:
      return reason.targetName ? `swap pending (${reason.targetName})` : 'swap pending';
    case PLAN_REASON_CODES.swappedOut:
      return `swapped out for ${reason.targetName ?? 'unknown'}`;
    case PLAN_REASON_CODES.shortfall:
      return formatShortfall(reason);
    case PLAN_REASON_CODES.headroomCooldown:
      return formatHeadroomCooldown(reason);
    case PLAN_REASON_CODES.insufficientHeadroom:
      return formatInsufficientHeadroom(reason);
    case PLAN_REASON_CODES.shedInvariant:
      return `shed invariant: ${reason.fromStep} -> ${reason.toStep} blocked `
        + `(${reason.shedDeviceCount} device(s) shed, max step: ${reason.maxStep})`;
    case PLAN_REASON_CODES.other:
      return reason.text;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
