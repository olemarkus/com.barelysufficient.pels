import { PLAN_REASON_CODES, type DeviceReason } from './planReasonSemanticsCore.js';

const KEEP_REASON = /^keep(?: \((.+)\))?$/;
const RESTORE_NEED_REASON = (
  /^restore(?: ([^(]+?) -> ([^(]+?))? \(need (-?\d+(?:\.\d+)?)kW(?:, headroom (unknown|-?\d+(?:\.\d+)?)kW)?\)$/
);
const SET_TARGET_REASON = /^set to (.+)$/;
const SWAP_PENDING_REASON = /^swap pending(?: \((.+)\))?$/;
const SWAPPED_OUT_REASON = /^swapped out for (.+)$/;
const HOURLY_BUDGET_REASON = /^shed due to hourly budget(?: (.+))?$/;
const DAILY_BUDGET_REASON = /^shed due to daily budget(?: (.+))?$/;
const SHORTFALL_REASON = (
  /^shortfall(?: \(need (-?\d+(?:\.\d+)?)kW, headroom (unknown|-?\d+(?:\.\d+)?)kW\))?$/
);
const COOLDOWN_SHEDDING_REASON = /^cooldown \(shedding, (\d+)s remaining\)$/;
const COOLDOWN_RESTORE_REASON = /^cooldown \(restore, (\d+)s remaining\)$/;
const METER_SETTLING_REASON = /^meter settling \((\d+)s remaining\)$/;
const ACTIVATION_BACKOFF_REASON = /^activation backoff \((\d+)s remaining\)$/;
const RESTORE_PENDING_REASON = /^restore pending \((\d+)s remaining\)$/;
const HEADROOM_COOLDOWN_RECENT_REASON = /^headroom cooldown \((\d+)s remaining; recent PELS (shed|restore)\)$/;
const HEADROOM_COOLDOWN_STEP_DOWN_REASON = new RegExp(
  '^headroom cooldown \\((\\d+)s remaining; '
    + 'usage step down from (unknown|-?\\d+(?:\\.\\d+)?)kW to '
    + '(unknown|-?\\d+(?:\\.\\d+)?)kW\\)$',
);
const INSUFFICIENT_HEADROOM_REASON = (
  /^insufficient headroom(?: to swap for (.+?)| to restore)?( after reserves)? \((.+)\)$/
);
const SHEDDING_ACTIVE_REASON = /^shedding active(?: (.+))?$/;
const INACTIVE_REASON = /^inactive(?: \((.+)\))?$/;
const CAPACITY_REASON = /^shed due to capacity(?: (.+))?$/;
const SHED_INVARIANT_REASON = (
  /^shed invariant: (.+) -> (.+) blocked \((\d+) device\(s\) shed, max step: (.+)\)$/
);

type ReasonParser = (trimmed: string) => DeviceReason | null;

function normalizeReasonText(reason: string | undefined): string | null {
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseNumber(value: string | undefined): number | null {
  if (!value || value === 'unknown') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseKeepReason(trimmed: string): DeviceReason | null {
  const match = KEEP_REASON.exec(trimmed);
  if (!match) return null;
  return { code: PLAN_REASON_CODES.keep, detail: match[1] ?? null };
}

function parseRestoreNeedReason(trimmed: string): DeviceReason | null {
  const match = RESTORE_NEED_REASON.exec(trimmed);
  if (!match) return null;
  return {
    code: PLAN_REASON_CODES.restoreNeed,
    fromTarget: match[1] ?? null,
    toTarget: match[2] ?? null,
    needKw: Number(match[3]),
    headroomKw: parseNumber(match[4]),
  };
}

function parseShortfallReason(trimmed: string): DeviceReason | null {
  const match = SHORTFALL_REASON.exec(trimmed);
  if (!match) return null;
  return {
    code: PLAN_REASON_CODES.shortfall,
    needKw: parseNumber(match[1]),
    headroomKw: parseNumber(match[2]),
  };
}

function parseNeedMatch(section: string | undefined): RegExpExecArray | null {
  return /^need (-?\d+(?:\.\d+)?)kW$/.exec(section ?? '')
    ?? /^effective need (-?\d+(?:\.\d+)?)kW \(base -?\d+(?:\.\d+)?kW \+ penalty (-?\d+(?:\.\d+)?)kW\)$/.exec(
      section ?? '',
    );
}

function parseInsufficientHeadroomReason(trimmed: string): DeviceReason | null {
  const match = INSUFFICIENT_HEADROOM_REASON.exec(trimmed);
  if (!match) return null;

  const detailParts = match[3].split(', ');
  const needMatch = parseNeedMatch(detailParts[0]);
  if (!needMatch) return null;

  const availableMatch = /^(?:available|headroom) (unknown|-?\d+(?:\.\d+)?)kW?$/.exec(detailParts[1] ?? '');
  const effectiveMatch = /^effective (-?\d+(?:\.\d+)?)kW after (-?\d+(?:\.\d+)?)kW swap reserve$/.exec(
    detailParts[2] ?? '',
  );
  const postReserveIndex = effectiveMatch ? 3 : 2;
  const postReserveMatch = /^post-reserve margin (-?\d+(?:\.\d+)?)kW < (-?\d+(?:\.\d+)?)kW$/.exec(
    detailParts[postReserveIndex] ?? '',
  );

  return {
    code: PLAN_REASON_CODES.insufficientHeadroom,
    needKw: Number(needMatch[1]),
    availableKw: parseNumber(availableMatch?.[1]),
    postReserveMarginKw: parseNumber(postReserveMatch?.[1]),
    minimumRequiredPostReserveMarginKw: parseNumber(postReserveMatch?.[2]),
    penaltyExtraKw: needMatch.length > 2 ? parseNumber(needMatch[2]) : null,
    swapReserveKw: parseNumber(effectiveMatch?.[2]),
    effectiveAvailableKw: parseNumber(effectiveMatch?.[1]),
    swapTargetName: match[1] ?? null,
  };
}

const REGEX_REASON_PARSERS: ReasonParser[] = [
  parseKeepReason,
  parseRestoreNeedReason,
  parseShortfallReason,
  parseInsufficientHeadroomReason,
  (trimmed) => {
    const match = SET_TARGET_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.setTarget, targetText: match[1] } : null;
  },
  (trimmed) => {
    const match = SWAP_PENDING_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.swapPending, targetName: match[1] ?? null } : null;
  },
  (trimmed) => {
    const match = SWAPPED_OUT_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.swappedOut, targetName: match[1] } : null;
  },
  (trimmed) => {
    const match = HOURLY_BUDGET_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.hourlyBudget, detail: match[1] ?? null } : null;
  },
  (trimmed) => {
    const match = DAILY_BUDGET_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.dailyBudget, detail: match[1] ?? null } : null;
  },
  (trimmed) => {
    const match = COOLDOWN_SHEDDING_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.cooldownShedding, remainingSec: Number(match[1]) } : null;
  },
  (trimmed) => {
    const match = COOLDOWN_RESTORE_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.cooldownRestore, remainingSec: Number(match[1]) } : null;
  },
  (trimmed) => {
    const match = METER_SETTLING_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.meterSettling, remainingSec: Number(match[1]) } : null;
  },
  (trimmed) => {
    const match = ACTIVATION_BACKOFF_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.activationBackoff, remainingSec: Number(match[1]) } : null;
  },
  (trimmed) => {
    const match = RESTORE_PENDING_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.restorePending, remainingSec: Number(match[1]) } : null;
  },
  (trimmed) => {
    const match = HEADROOM_COOLDOWN_RECENT_REASON.exec(trimmed);
    if (!match) return null;
    return {
      code: PLAN_REASON_CODES.headroomCooldown,
      kind: match[2] === 'shed' ? 'recent_pels_shed' : 'recent_pels_restore',
      remainingSec: Number(match[1]),
      fromKw: null,
      toKw: null,
    };
  },
  (trimmed) => {
    const match = HEADROOM_COOLDOWN_STEP_DOWN_REASON.exec(trimmed);
    if (!match) return null;
    return {
      code: PLAN_REASON_CODES.headroomCooldown,
      kind: 'usage_step_down',
      remainingSec: Number(match[1]),
      fromKw: parseNumber(match[2]),
      toKw: parseNumber(match[3]),
    };
  },
  (trimmed) => {
    const match = SHEDDING_ACTIVE_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.sheddingActive, detail: match[1] ?? null } : null;
  },
  (trimmed) => {
    const match = INACTIVE_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.inactive, detail: match[1] ?? null } : null;
  },
  (trimmed) => {
    const match = CAPACITY_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.capacity, detail: match[1] ?? null } : null;
  },
  (trimmed) => {
    const match = SHED_INVARIANT_REASON.exec(trimmed);
    if (!match) return null;
    return {
      code: PLAN_REASON_CODES.shedInvariant,
      fromStep: match[1],
      toStep: match[2],
      shedDeviceCount: Number(match[3]),
      maxStep: match[4],
    };
  },
];

const EXACT_REASON_PARSERS: Record<string, DeviceReason> = {
  'restore throttled': { code: PLAN_REASON_CODES.restoreThrottled },
  'waiting for other devices to recover': { code: PLAN_REASON_CODES.waitingForOtherDevices },
  'left off': { code: PLAN_REASON_CODES.neutralStartupHold },
  'startup stabilization': { code: PLAN_REASON_CODES.startupStabilization },
  'capacity control off': { code: PLAN_REASON_CODES.capacityControlOff },
};

function parseKnownReason(trimmed: string): DeviceReason | null {
  const exactReason = EXACT_REASON_PARSERS[trimmed];
  if (exactReason) return exactReason;

  for (const parser of REGEX_REASON_PARSERS) {
    const parsed = parser(trimmed);
    if (parsed) return parsed;
  }
  return null;
}

// Legacy storage bridge for old persisted plan snapshots that still store reason text.
export function buildComparablePlanReason(reason: string | undefined): DeviceReason {
  const trimmed = normalizeReasonText(reason);
  if (!trimmed) return { code: PLAN_REASON_CODES.none };
  return parseKnownReason(trimmed) ?? { code: PLAN_REASON_CODES.other, text: trimmed };
}
