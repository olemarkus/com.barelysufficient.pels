import { SHED_COOLDOWN_MS } from './planConstants';

export function getShedCooldownState(params: {
  lastInstabilityMs?: number | null;
  lastRecoveryMs?: number | null;
  nowTs?: number;
  cooldownMs?: number;
}): { cooldownRemainingMs: number | null; inCooldown: boolean } {
  const nowTs = params.nowTs ?? Date.now();
  const cooldownMs = params.cooldownMs ?? SHED_COOLDOWN_MS;
  const sinceInstability = typeof params.lastInstabilityMs === 'number' ? nowTs - params.lastInstabilityMs : null;
  const sinceRecovery = typeof params.lastRecoveryMs === 'number' ? nowTs - params.lastRecoveryMs : null;
  const parts = [sinceInstability, sinceRecovery].filter((v) => v !== null) as number[];
  if (parts.length === 0) return { cooldownRemainingMs: null, inCooldown: false };
  const min = Math.min(...parts);
  const cooldownRemainingMs = Math.max(0, cooldownMs - min);
  return { cooldownRemainingMs, inCooldown: cooldownRemainingMs > 0 };
}
