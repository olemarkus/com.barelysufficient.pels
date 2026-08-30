/**
 * How long to wait before re-issuing a command the device has not confirmed.
 *
 * Executor-owned: this is command materialization — "my write has not landed,
 * when may I send it again?" — not a planner decision about desired state
 * (`lib/AGENTS.md` § Layer boundaries). Both schedules lived in
 * `lib/plan/planConstants.ts` and were imported ONLY from this layer; the
 * planner never read either one, so the edge was purely a matter of where the
 * file sat.
 *
 * The two are identical today and still declared separately, because they pace
 * different device conversations — a setpoint write and a step-limit command —
 * and there is no reason a change to one should silently move the other.
 *
 * `lib/plan/admission/surplusAbsorb.ts` cites the stepped schedule's first rung
 * in prose (it paces surplus climbs against it). That is a comment, not an
 * import; keep the citation pointing here if these numbers change.
 */

/** Backoff for an unconfirmed temperature-target write. */
export const TARGET_COMMAND_RETRY_DELAYS_MS = [
  30 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
] as const;

/** Backoff for an unconfirmed stepped-load step command. */
export const STEPPED_LOAD_COMMAND_RETRY_DELAYS_MS = [
  30 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
] as const;
