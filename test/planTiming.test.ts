import { getShedCooldownState } from '../lib/plan/planTiming';
import { SHED_COOLDOWN_MS } from '../lib/plan/planConstants';

describe('getShedCooldownState', () => {
  it('returns no cooldown when no timestamps are set', () => {
    const result = getShedCooldownState({});
    expect(result.inCooldown).toBe(false);
    expect(result.cooldownRemainingMs).toBeNull();
  });

  it('returns cooldown based on lastInstabilityMs', () => {
    const now = 100_000;
    const result = getShedCooldownState({
      lastInstabilityMs: now - 30_000,
      nowTs: now,
    });
    expect(result.inCooldown).toBe(true);
    expect(result.cooldownRemainingMs).toBe(SHED_COOLDOWN_MS - 30_000);
  });

  it('returns cooldown based on lastRecoveryMs when it is the most recent event', () => {
    const now = 200_000;
    const result = getShedCooldownState({
      lastInstabilityMs: now - 90_000,
      lastRecoveryMs: now - 10_000,
      nowTs: now,
    });
    expect(result.inCooldown).toBe(true);
    expect(result.cooldownRemainingMs).toBe(SHED_COOLDOWN_MS - 10_000);
  });

  it('does not extend cooldown when lastRecoveryMs is older than lastInstabilityMs', () => {
    const now = 200_000;
    const result = getShedCooldownState({
      lastInstabilityMs: now - 10_000,
      lastRecoveryMs: now - 90_000,
      nowTs: now,
    });
    expect(result.inCooldown).toBe(true);
    expect(result.cooldownRemainingMs).toBe(SHED_COOLDOWN_MS - 10_000);
  });

  it('reports no cooldown when all timestamps are older than the cooldown window', () => {
    const now = 200_000;
    const result = getShedCooldownState({
      lastInstabilityMs: now - SHED_COOLDOWN_MS - 1,
      lastRecoveryMs: now - SHED_COOLDOWN_MS - 1,
      nowTs: now,
    });
    expect(result.inCooldown).toBe(false);
    expect(result.cooldownRemainingMs).toBe(0);
  });

  it('uses lastRecoveryMs as the sole cooldown source when lastInstabilityMs is null', () => {
    const now = 100_000;
    const result = getShedCooldownState({
      lastInstabilityMs: null,
      lastRecoveryMs: now - 5_000,
      nowTs: now,
    });
    expect(result.inCooldown).toBe(true);
    expect(result.cooldownRemainingMs).toBe(SHED_COOLDOWN_MS - 5_000);
  });
});
