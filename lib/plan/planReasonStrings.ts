export function buildActivationBackoffReason(remainingMs: number): string {
  return `activation backoff (${Math.max(1, Math.ceil(remainingMs / 1000))}s remaining)`;
}

export function buildCooldownReason(kind: 'shedding' | 'restore', remainingSec: number | null): string {
  return `cooldown (${kind}, ${remainingSec ?? 0}s remaining)`;
}

export function buildInsufficientHeadroomReason(neededKw: number, headroomKw: number | null): string {
  return `insufficient headroom (need ${neededKw.toFixed(2)}kW, headroom `
    + `${headroomKw === null ? 'unknown' : headroomKw.toFixed(2)}kW)`;
}

export function buildRestorePendingReason(remainingSec: number): string {
  return `restore pending (${remainingSec}s remaining)`;
}

export function buildShortfallReason(neededKw: number, headroomKw: number | null): string {
  return `shortfall (need ${neededKw.toFixed(2)}kW, headroom `
    + `${headroomKw === null ? 'unknown' : headroomKw.toFixed(2)}kW)`;
}
