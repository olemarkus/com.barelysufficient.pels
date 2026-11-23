import type { PendingObservationSource } from './controlCommandConfirmation';

export type PendingTargetObservationSource = PendingObservationSource;
export type PendingTargetCommandStatus = 'waiting_confirmation' | 'temporary_unavailable';

/** Execution's pending target facts, exposed read-only to planning and presentation. */
export type PendingTargetCommandRead = {
  readonly desired: number;
  readonly startedMs: number;
  readonly lastAttemptMs: number;
  readonly retryCount: number;
  readonly nextRetryAtMs: number;
  readonly status: PendingTargetCommandStatus;
  readonly lastObservedValue?: unknown;
  readonly lastObservedSource?: PendingTargetObservationSource;
  readonly lastObservedAtMs?: number;
};

/** A current decision's desired target, used to retire superseded ordinary retries. */
export type WantedTargetCommand =
  | { readonly kind: 'target'; readonly desired: number; readonly name: string }
  | { readonly kind: 'none'; readonly name: string };
