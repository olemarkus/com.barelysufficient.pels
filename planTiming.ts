import { SHED_COOLDOWN_MS } from './planConstants';

export function getShedCooldownState(params: {
  lastSheddingMs?: number | null;
  lastOvershootMs?: number | null;
  nowTs?: number;
  cooldownMs?: number;
}): { cooldownRemainingMs: number | null; inCooldown: boolean } {
  const nowTs = params.nowTs ?? Date.now();
  const cooldownMs = params.cooldownMs ?? SHED_COOLDOWN_MS;
  const sinceShedding = typeof params.lastSheddingMs === 'number' ? nowTs - params.lastSheddingMs : null;
  const sinceOvershoot = typeof params.lastOvershootMs === 'number' ? nowTs - params.lastOvershootMs : null;
  const parts = [sinceShedding, sinceOvershoot].filter((v) => v !== null) as number[];
  if (parts.length === 0) return { cooldownRemainingMs: null, inCooldown: false };
  const min = Math.min(...parts);
  const cooldownRemainingMs = Math.max(0, cooldownMs - min);
  return { cooldownRemainingMs, inCooldown: cooldownRemainingMs > 0 };
}
