export const PLAN_REASON_CODES = {
  none: 'none',
  keep: 'keep',
  restoreNeed: 'restore_need',
  setTarget: 'set_target',
  swapPending: 'swap_pending',
  swappedOut: 'swapped_out',
  hourlyBudget: 'hourly_budget',
  dailyBudget: 'daily_budget',
  shortfall: 'shortfall',
  cooldownShedding: 'cooldown_shedding',
  cooldownRestore: 'cooldown_restore',
  meterSettling: 'meter_settling',
  activationBackoff: 'activation_backoff',
  restorePending: 'restore_pending',
  headroomCooldown: 'headroom_cooldown',
  restoreThrottled: 'restore_throttled',
  waitingForOtherDevices: 'waiting_for_other_devices',
  insufficientHeadroom: 'insufficient_headroom',
  sheddingActive: 'shedding_active',
  inactive: 'inactive',
  capacity: 'capacity',
  other: 'other',
} as const;

export type PlanReasonCode = typeof PLAN_REASON_CODES[keyof typeof PLAN_REASON_CODES];

type ComparablePlanReasonBase = {
  code: PlanReasonCode;
};

type ComparableKeepReason = ComparablePlanReasonBase & {
  code: typeof PLAN_REASON_CODES.keep;
  detail: string | null;
};

type ComparableInactiveReason = ComparablePlanReasonBase & {
  code: typeof PLAN_REASON_CODES.inactive;
  detail: string | null;
};

type ComparableSwapPendingReason = ComparablePlanReasonBase & {
  code: typeof PLAN_REASON_CODES.swapPending;
  targetName: string | null;
};

type ComparableSwappedOutReason = ComparablePlanReasonBase & {
  code: typeof PLAN_REASON_CODES.swappedOut;
  targetName: string | null;
};

type ComparableHeadroomCooldownReason = ComparablePlanReasonBase & {
  code: typeof PLAN_REASON_CODES.headroomCooldown;
  kind: 'recent_pels_shed' | 'recent_pels_restore';
};

type ComparableTextReason = ComparablePlanReasonBase & {
  text: string;
};

export type ComparablePlanReason =
  | ComparablePlanReasonBase
  | ComparableKeepReason
  | ComparableInactiveReason
  | ComparableSwapPendingReason
  | ComparableSwappedOutReason
  | ComparableHeadroomCooldownReason
  | ComparableTextReason;

const COOLDOWN_SHEDDING_REASON = /^cooldown \(shedding, \d+s remaining\)$/;
const COOLDOWN_RESTORE_REASON = /^cooldown \(restore, \d+s remaining\)$/;
const METER_SETTLING_REASON = /^meter settling \(\d+s remaining\)$/;
const ACTIVATION_BACKOFF_REASON = /^activation backoff \(\d+s remaining\)$/;
const RESTORE_PENDING_REASON = /^restore pending \(\d+s remaining\)$/;
const HEADROOM_COOLDOWN_RECENT_REASON = /^headroom cooldown \(\d+s remaining; recent PELS (shed|restore)\)$/;

function normalizeReasonText(reason: string | undefined): string | null {
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function matchKeepReason(trimmed: string): ComparablePlanReason | null {
  if (trimmed === 'keep') {
    return { code: PLAN_REASON_CODES.keep, detail: null };
  }
  if (trimmed.startsWith('keep (') && trimmed.endsWith(')')) {
    return {
      code: PLAN_REASON_CODES.keep,
      detail: trimmed.slice('keep ('.length, -1),
    };
  }
  return null;
}

function matchCountdownReason(trimmed: string): ComparablePlanReason | null {
  if (COOLDOWN_SHEDDING_REASON.test(trimmed)) {
    return { code: PLAN_REASON_CODES.cooldownShedding };
  }
  if (COOLDOWN_RESTORE_REASON.test(trimmed)) {
    return { code: PLAN_REASON_CODES.cooldownRestore };
  }
  if (METER_SETTLING_REASON.test(trimmed)) {
    return { code: PLAN_REASON_CODES.meterSettling };
  }
  if (ACTIVATION_BACKOFF_REASON.test(trimmed)) {
    return { code: PLAN_REASON_CODES.activationBackoff };
  }
  if (RESTORE_PENDING_REASON.test(trimmed)) {
    return { code: PLAN_REASON_CODES.restorePending };
  }
  return null;
}

function matchHeadroomCooldownReason(trimmed: string): ComparablePlanReason | null {
  const headroomRecentMatch = HEADROOM_COOLDOWN_RECENT_REASON.exec(trimmed);
  if (headroomRecentMatch) {
    return {
      code: PLAN_REASON_CODES.headroomCooldown,
      kind: headroomRecentMatch[1] === 'shed' ? 'recent_pels_shed' : 'recent_pels_restore',
    };
  }
  return null;
}

function matchStateReason(trimmed: string): ComparablePlanReason | null {
  if (trimmed === 'restore throttled') {
    return { code: PLAN_REASON_CODES.restoreThrottled };
  }
  if (trimmed === 'waiting for other devices to recover') {
    return { code: PLAN_REASON_CODES.waitingForOtherDevices };
  }

  if (trimmed === 'inactive') {
    return { code: PLAN_REASON_CODES.inactive, detail: null };
  }
  if (trimmed.startsWith('inactive (') && trimmed.endsWith(')')) {
    return {
      code: PLAN_REASON_CODES.inactive,
      detail: trimmed.slice('inactive ('.length, -1),
    };
  }

  if (trimmed === 'swap pending') {
    return { code: PLAN_REASON_CODES.swapPending, targetName: null };
  }
  if (trimmed.startsWith('swap pending (') && trimmed.endsWith(')')) {
    return {
      code: PLAN_REASON_CODES.swapPending,
      targetName: trimmed.slice('swap pending ('.length, -1),
    };
  }

  if (trimmed.startsWith('swapped out for ')) {
    return {
      code: PLAN_REASON_CODES.swappedOut,
      targetName: trimmed.slice('swapped out for '.length) || null,
    };
  }
  return null;
}

function matchTextReason(trimmed: string): ComparablePlanReason | null {
  if (trimmed.startsWith('restore (need')) {
    return { code: PLAN_REASON_CODES.restoreNeed, text: trimmed };
  }
  if (trimmed.startsWith('set to ')) {
    return { code: PLAN_REASON_CODES.setTarget, text: trimmed };
  }
  if (trimmed.startsWith('shed due to hourly budget')) {
    return { code: PLAN_REASON_CODES.hourlyBudget, text: trimmed };
  }
  if (trimmed.startsWith('shed due to daily budget')) {
    return { code: PLAN_REASON_CODES.dailyBudget, text: trimmed };
  }
  if (trimmed === 'shortfall' || trimmed.startsWith('shortfall (')) {
    return { code: PLAN_REASON_CODES.shortfall, text: trimmed };
  }
  if (trimmed.startsWith('insufficient headroom')) {
    return { code: PLAN_REASON_CODES.insufficientHeadroom, text: trimmed };
  }
  if (trimmed === 'shedding active' || trimmed.startsWith('shedding active ')) {
    return { code: PLAN_REASON_CODES.sheddingActive, text: trimmed };
  }
  if (trimmed.startsWith('shed due to capacity')) {
    return { code: PLAN_REASON_CODES.capacity, text: trimmed };
  }
  return null;
}

export function buildComparablePlanReason(reason: string | undefined): ComparablePlanReason {
  const trimmed = normalizeReasonText(reason);
  if (!trimmed) {
    return { code: PLAN_REASON_CODES.none };
  }

  return matchKeepReason(trimmed)
    ?? matchCountdownReason(trimmed)
    ?? matchHeadroomCooldownReason(trimmed)
    ?? matchStateReason(trimmed)
    ?? matchTextReason(trimmed)
    ?? { code: PLAN_REASON_CODES.other, text: trimmed };
}
