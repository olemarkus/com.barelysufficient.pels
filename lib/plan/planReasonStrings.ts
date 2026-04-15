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

export function buildActivationBackoffReason(remainingMs: number): string {
  return `activation backoff (${Math.max(1, Math.ceil(remainingMs / 1000))}s remaining)`;
}

export function buildCooldownReason(kind: 'shedding' | 'restore', remainingSec: number | null): string {
  return `cooldown (${kind}, ${remainingSec ?? 0}s remaining)`;
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
