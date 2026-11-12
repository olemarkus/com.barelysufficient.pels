/**
 * The battery control owner's records still owed a hand-back that is not
 * running right now (`batteryControlOwner.ts`): due for an attempt after a
 * per-battery back-off, or stopped by a terminal failure until the battery's
 * control surface lifts it. Each failure is logged here, a terminal one once.
 */
import { getLogger } from '../logging/logger';
import type { StorageReleaseReason } from '../ports/batteryControlOwner';
import { normalizeError } from '../utils/errorUtils';
import { HAND_BACK_REPORT_WINDOW_MS, type TerminalReleaseFailure } from './batteryClaimStanding';
import { backoffDelayMs } from './retryBackoff';

const logger = getLogger('battery');

/** Wait before the next hand-back attempt after the 1st, 2nd, 3rd and every later failure. */
export const BATTERY_RELEASE_RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

/**
 * Why the owner hands a battery back: a plan decision, or one of its own
 * (`homey_api_key_removed`: before the key its hand-back runs on goes).
 */
export type ReleaseReason = 'opted_out' | 'boot_recovery' | 'retry' | 'homey_api_key_removed' | StorageReleaseReason;

/** Why this hand-back attempt failed; a later one may succeed. */
export type RetryableReleaseFailure =
  | { kind: 'unobserved' }
  | { kind: 'claim_contested' }
  | { kind: 'not_requested' }
  | { kind: 'write_failed'; error: unknown };

/**
 * A record still owed a hand-back: due for an attempt, or stopped by a terminal
 * failure. `awaitingReport`: the hand-back was written to a battery that
 * confirms it only by reporting the restored mode, and the attempt is due if
 * that report has not come by `nextAttemptAtMs`.
 */
export type PendingHandBack =
  | { state: 'due'; reason: ReleaseReason; failures: number; nextAttemptAtMs: number; awaitingReport: boolean }
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
    this.entries.set(deviceId, {
      state: 'due', reason: 'boot_recovery', failures: 0, nextAttemptAtMs: 0, awaitingReport: false,
    });
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
      awaitingReport: false,
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
   * A hand-back written to a battery that confirms it only by reporting the
   * restored mode: its record stays until that report. Without one, the
   * hand-back is due again after the report window, or after the back-off
   * once an earlier attempt went unreported.
   */
  awaitReport(deviceId: string, reason: ReleaseReason, nowMs: number, restoredClaimValue: string): true {
    const previous = this.entries.get(deviceId);
    const failures = previous?.state === 'due' ? previous.failures : 0;
    const waitMs = failures === 0 ? HAND_BACK_REPORT_WINDOW_MS
      : Math.max(HAND_BACK_REPORT_WINDOW_MS, backoffDelayMs(BATTERY_RELEASE_RETRY_BACKOFF_MS, failures));
    this.entries.set(deviceId, {
      state: 'due',
      reason: reason === 'boot_recovery' ? reason : 'retry',
      failures,
      nextAttemptAtMs: nowMs + waitMs,
      awaitingReport: true,
    });
    logger.info({ event: 'battery_control_release_awaiting_report', deviceId, reason, restoredClaimValue });
    return true;
  }

  /**
   * Whether a hand-back keeps the battery from a new claim: one waiting out
   * its back-off, or stopped for good. One that only waits for its report does
   * not: a new claim adopts its record, which still names the battery's own
   * mode.
   */
  holdsClaim(deviceId: string, nowMs: number): boolean {
    return this.isWaiting(deviceId, nowMs) && !this.isAwaitingReport(deviceId);
  }

  /** Whether the battery's last hand-back write is still waiting for its report. */
  isAwaitingReport(deviceId: string): boolean {
    const pending = this.entries.get(deviceId);
    return pending?.state === 'due' && pending.awaitingReport;
  }

  /**
   * The hand-back written last went unreported past its window: a failure
   * that counts toward the back-off, logged like any other, before it is
   * written again.
   */
  noteRestoreUnreported(deviceId: string, reason: ReleaseReason): void {
    const previous = this.entries.get(deviceId);
    if (previous?.state !== 'due' || !previous.awaitingReport) return;
    const failures = previous.failures + 1;
    this.entries.set(deviceId, { ...previous, failures, awaitingReport: false });
    logger.warn({
      event: 'battery_control_release_failed',
      deviceId,
      reason,
      failure: 'restore_unreported',
      terminal: false,
      failures,
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
