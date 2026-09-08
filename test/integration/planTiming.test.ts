import { getShedCooldownState } from '../../lib/plan/restore/timing';
import { RestoreBackoff } from '../../lib/plan/restoreBackoff';
import { SHED_COOLDOWN_MS } from '../../lib/plan/planConstants';

/** A back-off carrying just the two clocks this cooldown reads. */
const backoffWith = (clocks: { lastInstabilityMs?: number; lastRecoveryMs?: number }): RestoreBackoff => {
  const backoff = new RestoreBackoff();
  if (clocks.lastInstabilityMs !== undefined) backoff.noteInstability(clocks.lastInstabilityMs);
  if (clocks.lastRecoveryMs !== undefined) backoff.noteRecovery(clocks.lastRecoveryMs);
  return backoff;
};

describe('getShedCooldownState', () => {
  it('returns no cooldown when no timestamps are set', () => {
    const result = getShedCooldownState(backoffWith({}), 0, SHED_COOLDOWN_MS);
    expect(result.inCooldown).toBe(false);
    expect(result.cooldownRemainingMs).toBeNull();
  });

  it('returns cooldown based on lastInstabilityMs', () => {
    const now = 100_000;
    const result = getShedCooldownState(backoffWith({ lastInstabilityMs: now - 30_000 }), now, SHED_COOLDOWN_MS);
    expect(result.inCooldown).toBe(true);
    expect(result.cooldownRemainingMs).toBe(SHED_COOLDOWN_MS - 30_000);
  });

  it('returns cooldown based on lastRecoveryMs when it is the most recent event', () => {
    const now = 200_000;
    const result = getShedCooldownState(backoffWith({ lastInstabilityMs: now - 90_000, lastRecoveryMs: now - 10_000 }), now, SHED_COOLDOWN_MS);
    expect(result.inCooldown).toBe(true);
    expect(result.cooldownRemainingMs).toBe(SHED_COOLDOWN_MS - 10_000);
  });

  it('does not extend cooldown when lastRecoveryMs is older than lastInstabilityMs', () => {
    const now = 200_000;
    const result = getShedCooldownState(backoffWith({ lastInstabilityMs: now - 10_000, lastRecoveryMs: now - 90_000 }), now, SHED_COOLDOWN_MS);
    expect(result.inCooldown).toBe(true);
    expect(result.cooldownRemainingMs).toBe(SHED_COOLDOWN_MS - 10_000);
  });

  it('reports no cooldown when all timestamps are older than the cooldown window', () => {
    const now = 200_000;
    const result = getShedCooldownState(backoffWith({ lastInstabilityMs: now - SHED_COOLDOWN_MS - 1, lastRecoveryMs: now - SHED_COOLDOWN_MS - 1 }), now, SHED_COOLDOWN_MS);
    expect(result.inCooldown).toBe(false);
    expect(result.cooldownRemainingMs).toBe(0);
  });

  it('uses lastRecoveryMs as the sole cooldown source when lastInstabilityMs is null', () => {
    const now = 100_000;
    const result = getShedCooldownState(backoffWith({ lastRecoveryMs: now - 5_000 }), now, SHED_COOLDOWN_MS);
    expect(result.inCooldown).toBe(true);
    expect(result.cooldownRemainingMs).toBe(SHED_COOLDOWN_MS - 5_000);
  });
});
