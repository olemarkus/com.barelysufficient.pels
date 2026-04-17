export type PlanReasonCode =
  | 'none'
  | 'keep'
  | 'restore_need'
  | 'set_target'
  | 'swap_pending'
  | 'swapped_out'
  | 'hourly_budget'
  | 'daily_budget'
  | 'shortfall'
  | 'cooldown_shedding'
  | 'cooldown_restore'
  | 'activation_backoff'
  | 'restore_pending'
  | 'headroom_cooldown'
  | 'restore_throttled'
  | 'waiting_for_other_devices'
  | 'insufficient_headroom'
  | 'shedding_active'
  | 'inactive'
  | 'capacity'
  | 'other';

export type ClassifiedPlanReason = {
  code: PlanReasonCode;
  text: string | undefined;
};

export type PlanReasonDecision =
  | { code: 'existing'; text: string }
  | { code: 'activation_backoff'; remainingMs: number }
  | { code: 'cooldown_shedding'; remainingSec: number | null }
  | { code: 'cooldown_restore'; remainingSec: number | null }
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

type ReasonMatcher = {
  code: PlanReasonCode;
  matches: (reason: string) => boolean;
};

function assertNever(value: never): never {
  throw new Error(`Unhandled plan reason decision: ${String((value as { code?: string }).code)}`);
}

function formatKw(value: number, digits: number): string {
  const scale = 10 ** digits;
  const roundedMagnitude = Math.round((Math.abs(value) + Number.EPSILON) * scale) / scale;
  return (Math.sign(value) * roundedMagnitude).toFixed(digits);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function buildRestoreNeedSummary(neededKw: number, penaltyExtraKw: number): string {
  return penaltyExtraKw > 0
    ? `effective need ${formatKw(neededKw, 2)}kW (base ${formatKw(neededKw - penaltyExtraKw, 2)}kW`
      + ` + penalty ${formatKw(penaltyExtraKw, 2)}kW)`
    : `need ${formatKw(neededKw, 2)}kW`;
}

function buildRestorePrefix(swapTargetName: string | undefined): string {
  return swapTargetName
    ? `insufficient headroom to swap for ${swapTargetName}`
    : 'insufficient headroom to restore';
}

function buildAvailableSummary(availableKw: number | null): string {
  return availableKw === null ? 'available unknown' : `available ${formatKw(availableKw, 2)}kW`;
}

function buildEffectiveSummary(
  effectiveAvailableKw: number | undefined,
  swapReserveKw: number | undefined,
): string | null {
  if (!isFiniteNumber(effectiveAvailableKw) || !isFiniteNumber(swapReserveKw)) return null;
  return `effective ${formatKw(effectiveAvailableKw, 2)}kW after ${formatKw(swapReserveKw, 2)}kW swap reserve`;
}

function buildPostReserveMarginSummary(
  postReserveMarginKw: number,
  minimumRequiredPostReserveMarginKw: number,
): string {
  return `post-reserve margin ${formatKw(postReserveMarginKw, 3)}kW < `
    + `${formatKw(minimumRequiredPostReserveMarginKw, 3)}kW`;
}

const reasonMatchers: readonly ReasonMatcher[] = [
  {
    code: 'keep',
    matches: reason => reason === 'keep' || reason.startsWith('keep ('),
  },
  {
    code: 'restore_need',
    matches: reason => reason.startsWith('restore (need'),
  },
  {
    code: 'set_target',
    matches: reason => reason.startsWith('set to '),
  },
  {
    code: 'swap_pending',
    matches: reason => reason === 'swap pending' || reason.startsWith('swap pending ('),
  },
  {
    code: 'swapped_out',
    matches: reason => reason.startsWith('swapped out for '),
  },
  {
    code: 'hourly_budget',
    matches: reason => reason.startsWith('shed due to hourly budget'),
  },
  {
    code: 'daily_budget',
    matches: reason => reason.startsWith('shed due to daily budget'),
  },
  {
    code: 'shortfall',
    matches: reason => reason === 'shortfall' || reason.startsWith('shortfall ('),
  },
  {
    code: 'cooldown_shedding',
    matches: reason => /^cooldown \(shedding, \d+s remaining\)$/.test(reason),
  },
  {
    code: 'cooldown_restore',
    matches: reason => /^cooldown \(restore, \d+s remaining\)$/.test(reason),
  },
  {
    code: 'activation_backoff',
    matches: reason => reason.startsWith('activation backoff ('),
  },
  {
    code: 'restore_pending',
    matches: reason => reason.startsWith('restore pending ('),
  },
  {
    code: 'headroom_cooldown',
    matches: reason => reason.startsWith('headroom cooldown ('),
  },
  {
    code: 'restore_throttled',
    matches: reason => reason === 'restore throttled',
  },
  {
    code: 'waiting_for_other_devices',
    matches: reason => reason === 'waiting for other devices to recover',
  },
  {
    code: 'insufficient_headroom',
    matches: reason => reason.startsWith('insufficient headroom'),
  },
  {
    code: 'shedding_active',
    matches: reason => reason === 'shedding active' || reason.startsWith('shedding active '),
  },
  {
    code: 'inactive',
    matches: reason => reason === 'inactive' || reason.startsWith('inactive ('),
  },
  {
    code: 'capacity',
    matches: reason => reason.startsWith('shed due to capacity'),
  },
] as const;

export function classifyPlanReason(reason: string | undefined): ClassifiedPlanReason {
  if (!reason) return { code: 'none', text: reason };
  const trimmed = reason.trim();
  const match = reasonMatchers.find(candidate => candidate.matches(trimmed));
  if (match) return { code: match.code, text: trimmed };
  return { code: 'other', text: trimmed };
}

export function buildActivationBackoffReason(remainingMs: number): string {
  return `activation backoff (${Math.max(1, Math.ceil(remainingMs / 1000))}s remaining)`;
}

export function buildCooldownReason(kind: 'shedding' | 'restore', remainingSec: number | null): string {
  return `cooldown (${kind}, ${remainingSec ?? 0}s remaining)`;
}

export function buildRestoreNeedReason(neededKw: number, headroomKw: number | null): string {
  return `restore (need ${neededKw.toFixed(2)}kW, headroom `
    + `${headroomKw === null ? 'unknown' : headroomKw.toFixed(2)}kW)`;
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
}): string {
  const {
    neededKw,
    availableKw,
    postReserveMarginKw,
    minimumRequiredPostReserveMarginKw,
    penaltyExtraKw = 0,
    swapReserveKw,
    effectiveAvailableKw,
    swapTargetName,
  } = params;
  const prefix = buildRestorePrefix(swapTargetName);
  const needSummary = buildRestoreNeedSummary(neededKw, penaltyExtraKw);
  const availableSummary = buildAvailableSummary(availableKw);
  const effectiveSummary = buildEffectiveSummary(effectiveAvailableKw, swapReserveKw);
  const postReserveMarginSummary = buildPostReserveMarginSummary(
    postReserveMarginKw,
    minimumRequiredPostReserveMarginKw,
  );

  if (availableKw === null) return `${prefix} (${needSummary}, ${availableSummary})`;

  if (effectiveSummary && isFiniteNumber(effectiveAvailableKw) && effectiveAvailableKw < neededKw) {
    return `${prefix} (${needSummary}, ${availableSummary}, ${effectiveSummary})`;
  }

  if (availableKw < neededKw) return `${prefix} (${needSummary}, ${availableSummary})`;

  const reserveDetails = effectiveSummary ? `${effectiveSummary}, ` : '';
  return `${prefix} after reserves (${needSummary}, ${availableSummary}, `
    + `${reserveDetails}${postReserveMarginSummary})`;
}

export function buildRestorePendingReason(remainingSec: number): string {
  return `restore pending (${remainingSec}s remaining)`;
}

export function buildShortfallReason(neededKw: number, headroomKw: number | null): string {
  return `shortfall (need ${neededKw.toFixed(2)}kW, headroom `
    + `${headroomKw === null ? 'unknown' : headroomKw.toFixed(2)}kW)`;
}

export function renderPlanReasonDecision(reason: PlanReasonDecision): string {
  switch (reason.code) {
    case 'existing':
      return reason.text;
    case 'activation_backoff':
      return buildActivationBackoffReason(reason.remainingMs);
    case 'cooldown_shedding':
      return buildCooldownReason('shedding', reason.remainingSec);
    case 'cooldown_restore':
      return buildCooldownReason('restore', reason.remainingSec);
    case 'restore_headroom':
      return buildRestoreHeadroomReason(reason.params);
    case 'restore_pending':
      return buildRestorePendingReason(reason.remainingSec);
    case 'shortfall':
      return buildShortfallReason(reason.neededKw, reason.headroomKw);
  }
  return assertNever(reason);
}
