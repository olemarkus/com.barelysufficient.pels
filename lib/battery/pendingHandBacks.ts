/**
 * The battery control owner's records still owed a hand-back that is not
 * running right now (`batteryControlOwner.ts`): due for an attempt after a
 * per-battery back-off, or stopped by a terminal failure until the battery's
 * control surface lifts it. Each failure is logged here, a terminal one once.
 */
import { getLogger } from '../logging/logger';
import type { StorageReleaseReason } from '../ports/batteryControlOwner';
import { normalizeError } from '../utils/errorUtils';
import type { TerminalReleaseFailure } from './batteryClaimStanding';
import { backoffDelayMs } from './retryBackoff';

const logger = getLogger('battery');

/** Wait before the next hand-back attempt after the 1st, 2nd, 3rd and every later failure. */
export const BATTERY_RELEASE_RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

export type ReleaseReason = 'opted_out' | 'boot_recovery' | 'retry' | StorageReleaseReason;

/** Why this hand-back attempt failed; a later one may succeed. */
export type RetryableReleaseFailure =
  | { kind: 'unobserved' }
  | { kind: 'claim_contested' }
  | { kind: 'not_requested' }
  | { kind: 'write_failed'; error: unknown };

/** A record still owed a hand-back: due for an attempt, or stopped by a terminal failure. */
export type PendingHandBack =
  | { state: 'due'; reason: ReleaseReason; failures: number; nextAttemptAtMs: number }
  | { state: 'terminal'; reason: ReleaseReason; failure: TerminalReleaseFailure };

export class PendingHandBacks {
  private readonly entries = new Map<string, PendingHandBack>();

  get(deviceId: string): PendingHandBack | undefined {
    return this.entries.get(deviceId);
  }

  has(deviceId: string): boolean {
    return this.entries.has(deviceId);
  }

  delete(deviceId: string): void {
    this.entries.delete(deviceId);
  }

  [Symbol.iterator](): IterableIterator<[string, PendingHandBack]> {
    return this.entries.entries();
  }

  /** A record a previous run left, or one that read cleanly only now: its hand-back is due at once. */
  markBootRecovery(deviceId: string): void {
    this.entries.set(deviceId, { state: 'due', reason: 'boot_recovery', failures: 0, nextAttemptAtMs: 0 });
  }

  /**
   * A hand-back waiting out its retry back-off, or stopped for good: the plan
   * asking again changes nothing, and must not turn the back-off into a retry
   * on every rebuild.
   */
  isWaiting(deviceId: string, nowMs: number): boolean {
    const pending = this.entries.get(deviceId);
    return pending !== undefined && (pending.state === 'terminal' || pending.nextAttemptAtMs > nowMs);
  }

  scheduleRetry(deviceId: string, reason: ReleaseReason, failure: RetryableReleaseFailure): void {
    const previous = this.entries.get(deviceId);
    const failures = (previous?.state === 'due' ? previous.failures : 0) + 1;
    const nextAttemptAtMs = Date.now() + backoffDelayMs(BATTERY_RELEASE_RETRY_BACKOFF_MS, failures);
    this.entries.set(deviceId, {
      state: 'due',
      reason: reason === 'boot_recovery' ? reason : 'retry',
      failures,
      nextAttemptAtMs,
    });
    logger.warn({
      event: 'battery_control_release_failed',
      deviceId,
      reason,
      failure: failure.kind,
      terminal: false,
      nextAttemptAtMs,
      ...(failure.kind === 'write_failed' ? { err: normalizeError(failure.error) } : {}),
    });
  }

  /**
   * A hand-back that cannot succeed: logged once, the record kept, no retry
   * until the battery's control surface lifts the failure.
   */
  stopRetrying(deviceId: string, reason: ReleaseReason, failure: TerminalReleaseFailure): void {
    const previous = this.entries.get(deviceId);
    this.entries.set(deviceId, { state: 'terminal', reason, failure });
    if (previous?.state === 'terminal' && previous.failure === failure) return;
    logger.warn({ event: 'battery_control_release_failed', deviceId, reason, failure, terminal: true });
  }
}
