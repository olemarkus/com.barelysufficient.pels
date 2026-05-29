import {
  PLAN_REASON_CODES,
  type DeviceReason,
} from './planReasonSemanticsCore';
import {
  PLAN_STATE_DAILY_BUDGET_STATUS,
  PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS,
  PLAN_STATE_HELD_FALLBACK_STATUS,
  PLAN_STATE_HOURLY_BUDGET_STATUS,
} from './planStateLabels';

type DetailReason = Extract<
  DeviceReason,
  | { code: typeof PLAN_REASON_CODES.keep }
  | { code: typeof PLAN_REASON_CODES.hourlyBudget }
  | { code: typeof PLAN_REASON_CODES.dailyBudget }
  | { code: typeof PLAN_REASON_CODES.sheddingActive }
  | { code: typeof PLAN_REASON_CODES.inactive }
  | { code: typeof PLAN_REASON_CODES.capacity }
  | { code: typeof PLAN_REASON_CODES.deferredObjectiveAvoid }
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
    || reason.code === PLAN_REASON_CODES.capacity
    || reason.code === PLAN_REASON_CODES.deferredObjectiveAvoid;
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
    case PLAN_REASON_CODES.deferredObjectiveAvoid:
      return formatShedReason('waiting for cheaper hours', reason.detail);
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

// ─── User-facing reason text ─────────────────────────────────────────────────
//
// `formatDeviceReason` above is the diagnostic/log format. The helpers below
// produce user-facing text per `notes/ui-terminology.md`. They never expose
// internal planner terms (`shed`, `restore`, `headroom`, `shortfall`,
// `backoff`, `invariant`, `soft limit`) and translate the `(need X kW,
// headroom Y kW)` template to `needs X kW, Y kW available`.

function normalizeDetailSentence(detail: string): string {
  return detail.length > 0 ? `${detail.charAt(0).toUpperCase()}${detail.slice(1)}` : detail;
}

function appendUserDetail(text: string, detail: string | null | undefined): string {
  return detail ? `${text}. ${normalizeDetailSentence(detail)}` : text;
}

function formatNeedAvailableSuffix(needKw: number, availableKw: number | null): string | null {
  if (!Number.isFinite(needKw)) return null;
  if (availableKw === null || !Number.isFinite(availableKw)) return null;
  // Clamp negative headroom to 0 kW so users do not see confusing minus signs;
  // negative values mean the system is already over the limit.
  const safeAvailable = Math.max(0, availableKw);
  return `needs ${needKw.toFixed(1)} kW, ${safeAvailable.toFixed(1)} kW available`;
}

export function formatShortfallReason(opts: {
  needKw: number | null;
  headroomKw: number | null;
}): string {
  const base = 'Manual action needed. Hard cap may be exceeded.';
  if (opts.needKw === null || opts.headroomKw === null) return base;
  const suffix = formatNeedAvailableSuffix(opts.needKw, opts.headroomKw);
  return suffix ? `Manual action needed. ${suffix.charAt(0).toUpperCase()}${suffix.slice(1)}.` : base;
}

// Reads the loosely-typed `detail` slot off a `DeviceReason`-shaped value
// without an `as` cast. The snapshot boundary serialises some reason variants
// with a `detail` field (`keep`, `hourlyBudget`, `dailyBudget`,
// `sheddingActive`, `inactive`, `capacity`) and others without one; callers
// often hold the value as `unknown` after crossing the IPC boundary. This
// helper accepts `unknown`, returns `unknown`, and centralises the narrowing
// so the published contract between settings-ui and the shared-domain
// reason helpers stays typed at the boundary.
export type DeviceReasonWithDetail = { readonly detail?: unknown };
export function readDeviceReasonDetail(reason: unknown): unknown {
  if (typeof reason !== 'object' || reason === null || !('detail' in reason)) return undefined;
  return (reason as DeviceReasonWithDetail).detail;
}

// "Still reporting load after pause" sentence used by the Overview device
// card when a held device is still drawing power — e.g. an EV charger that
// ignored the pause. Lives in shared-domain so logs and UI produce the same
// wording (`feedback_ui_text_shared_with_logs`). The `detail` slot accepts
// `unknown` because the upstream `DeviceReason.detail` field is loosely typed
// at the snapshot boundary; non-string values are dropped silently rather
// than rendered as `[object Object]`.
export function resolveReportedLoadAfterPauseText(params: {
  measuredPowerKw: number | undefined;
  detail: unknown;
}): string {
  const measured = typeof params.measuredPowerKw === 'number' && Number.isFinite(params.measuredPowerKw)
    ? params.measuredPowerKw.toFixed(1)
    : '–';
  const detail = typeof params.detail === 'string' && params.detail.trim().length > 0
    ? params.detail.trim()
    : null;
  return detail
    ? `Still reporting ${measured} kW after pause — ${detail}`
    : `Still reporting ${measured} kW after pause`;
}

function formatRestoreNeedUserFacing(
  reason: Extract<DeviceReason, { code: typeof PLAN_REASON_CODES.restoreNeed }>,
): string {
  if (reason.fromTarget !== null && reason.toTarget !== null) {
    return `Raising target ${reason.fromTarget} to ${reason.toTarget}`;
  }
  const suffix = formatNeedAvailableSuffix(reason.needKw, reason.headroomKw);
  return suffix ? `Waiting to resume — ${suffix}` : 'Waiting for available power';
}

function formatInsufficientHeadroomUserFacing(
  reason: Extract<DeviceReason, { code: typeof PLAN_REASON_CODES.insufficientHeadroom }>,
): string {
  const available = reason.effectiveAvailableKw ?? reason.availableKw;
  const suffix = formatNeedAvailableSuffix(reason.needKw, available);
  if (reason.swapTargetName) {
    const base = `Not enough available power to make room for ${reason.swapTargetName}`;
    return suffix ? `${base} — ${suffix}` : base;
  }
  return suffix ? `Not enough available power to resume — ${suffix}` : 'Not enough available power to resume';
}

const TIMED_REASON_LABELS = {
  [PLAN_REASON_CODES.cooldownShedding]: 'Waiting after limiting device',
  [PLAN_REASON_CODES.cooldownRestore]: 'Waiting before resuming',
  [PLAN_REASON_CODES.meterSettling]: 'Waiting for power meter to stabilise',
  [PLAN_REASON_CODES.activationBackoff]: 'Delaying restart after recent failed attempt',
  [PLAN_REASON_CODES.restorePending]: 'Resume pending',
} as const;

function formatStaticReasonUserFacing(reason: StaticReason): string {
  switch (reason.code) {
    case PLAN_REASON_CODES.none:
      return '';
    case PLAN_REASON_CODES.restoreThrottled:
      return 'Delaying restart to avoid rapid cycling';
    case PLAN_REASON_CODES.waitingForOtherDevices:
      return 'Waiting for other devices to settle';
    case PLAN_REASON_CODES.neutralStartupHold:
      return 'Left off after startup';
    case PLAN_REASON_CODES.startupStabilization:
      return 'Waiting after startup';
    case PLAN_REASON_CODES.capacityControlOff:
      return 'Power-limit control off';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function formatDetailReasonUserFacing(reason: DetailReason): string {
  switch (reason.code) {
    case PLAN_REASON_CODES.keep:
      return reason.detail ? normalizeDetailSentence(reason.detail) : '';
    case PLAN_REASON_CODES.hourlyBudget:
      return appendUserDetail(PLAN_STATE_HOURLY_BUDGET_STATUS, reason.detail);
    case PLAN_REASON_CODES.dailyBudget:
      return appendUserDetail(PLAN_STATE_DAILY_BUDGET_STATUS, reason.detail);
    case PLAN_REASON_CODES.sheddingActive:
      return appendUserDetail('Currently limiting devices', reason.detail);
    case PLAN_REASON_CODES.inactive:
      return reason.detail ? `Off for now (${reason.detail})` : 'Off for now';
    case PLAN_REASON_CODES.capacity:
      return appendUserDetail(PLAN_STATE_HELD_FALLBACK_STATUS, reason.detail);
    case PLAN_REASON_CODES.deferredObjectiveAvoid:
      return appendUserDetail(PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS, reason.detail);
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function formatTimedReasonUserFacing(reason: TimedReason): string {
  return `${TIMED_REASON_LABELS[reason.code]} (${formatRemainingSec(reason.remainingSec)}s)`;
}

export function formatDeviceReasonUserFacing(reason: DeviceReason): string {
  if (isStaticReason(reason)) return formatStaticReasonUserFacing(reason);
  if (isDetailReason(reason)) return formatDetailReasonUserFacing(reason);
  if (isTimedReason(reason)) return formatTimedReasonUserFacing(reason);

  switch (reason.code) {
    case PLAN_REASON_CODES.restoreNeed:
      return formatRestoreNeedUserFacing(reason);
    case PLAN_REASON_CODES.setTarget:
      return `Changing target to ${reason.targetText}`;
    case PLAN_REASON_CODES.swapPending:
      return reason.targetName
        ? `Making room for higher-priority device (${reason.targetName})`
        : 'Making room for higher-priority device';
    case PLAN_REASON_CODES.swappedOut:
      return reason.targetName
        ? `Limited so ${reason.targetName} can run`
        : 'Limited so another device can run';
    case PLAN_REASON_CODES.shortfall:
      return formatShortfallReason({ needKw: reason.needKw, headroomKw: reason.headroomKw });
    case PLAN_REASON_CODES.headroomCooldown:
      return 'Waiting for power reading to stabilise';
    case PLAN_REASON_CODES.insufficientHeadroom:
      return formatInsufficientHeadroomUserFacing(reason);
    case PLAN_REASON_CODES.shedInvariant:
      return 'Blocked by safety rule';
    case PLAN_REASON_CODES.other:
      return reason.text;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
