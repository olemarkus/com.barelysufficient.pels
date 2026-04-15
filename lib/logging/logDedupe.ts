export type LogDedupeEntry = {
  signature: string;
  emittedAt: number;
};

export function roundLogValue(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function shouldEmitOnChange(params: {
  state: Map<string, LogDedupeEntry>;
  key: string;
  signature: string;
  now: number;
  repeatAfterMs?: number;
  pruneOlderThanMs?: number;
}): boolean {
  const {
    state,
    key,
    signature,
    now,
    repeatAfterMs,
    pruneOlderThanMs,
  } = params;
  pruneWindowedEntries(state, now, pruneOlderThanMs);
  const previous = state.get(key);
  if (!previous || previous.signature !== signature) {
    state.set(key, { signature, emittedAt: now });
    return true;
  }
  if (typeof repeatAfterMs === 'number' && now - previous.emittedAt >= repeatAfterMs) {
    state.set(key, { signature, emittedAt: now });
    return true;
  }
  return false;
}

export function shouldEmitWindowed(params: {
  state: Map<string, number>;
  key: string;
  now: number;
  windowMs: number;
  pruneOlderThanMs?: number;
}): boolean {
  const {
    state,
    key,
    now,
    windowMs,
    pruneOlderThanMs,
  } = params;
  pruneWindowedEntries(state, now, pruneOlderThanMs);
  const previous = state.get(key);
  if (typeof previous === 'number' && now - previous < windowMs) {
    return false;
  }
  state.set(key, now);
  return true;
}

function pruneWindowedEntries<T extends number | LogDedupeEntry>(
  state: Map<string, T>,
  now: number,
  pruneOlderThanMs = 10 * 60 * 1000,
): void {
  for (const [key, value] of state.entries()) {
    const ts = typeof value === 'number' ? value : value.emittedAt;
    if (now - ts <= pruneOlderThanMs) continue;
    state.delete(key);
  }
}
