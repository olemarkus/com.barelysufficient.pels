export const SHED_COOLDOWN_MS = 60000; // Wait 60s after shedding before considering restores
export const RESTORE_COOLDOWN_MS = 60000; // Base cooldown after restore for power to stabilize

/**
 * Headroom a build must see before it releases the shedding latch
 * (`PlanEngineState.sheddingActive`): the restore margin plus hysteresis, so a
 * plan hovering at the threshold cannot flap the latch between rebuilds. Both
 * terms are fixed — the restore margin was a `CapacityGuard` option neither
 * factory ever supplied, so it was always 0.2.
 */
export const SHEDDING_CLEAR_THRESHOLD_KW = 0.4;
export const RESTORE_COOLDOWN_MAX_MS = 5 * 60 * 1000; // Cap restore backoff at 5 minutes
export const RESTORE_COOLDOWN_BACKOFF_MULTIPLIER = 2; // Exponential backoff multiplier
export const RESTORE_STABLE_RESET_MS = 5 * 60 * 1000; // Reset backoff after 5 minutes of stability
export const RESTORE_CONFIRM_RETRY_MS = 5 * 60 * 1000; // Retry unconfirmed temperature restores after 5 minutes
// Wait up to 5 minutes after a shed before retrying restore.
export const RECENT_SHED_RESTORE_BACKOFF_MS = 5 * 60 * 1000;
export const RECENT_SHED_RESTORE_MULTIPLIER = 1.15; // Require ~15% more headroom if device was just shed
export const RECENT_SHED_EXTRA_BUFFER_KW = 0.15; // Or at least an extra 0.15 kW cushion when re-restoring
// Avoid re-shedding a freshly restored device for 3 minutes unless overshoot is large.
export const RECENT_RESTORE_SHED_GRACE_MS = 3 * 60 * 1000;
export const RECENT_RESTORE_OVERSHOOT_BYPASS_KW = 0.5; // Allow immediate re-shed if overshoot is >= 0.5 kW
// Block restore of a device that was restored right before an overshoot event.
export const OVERSHOOT_RESTORE_ATTRIBUTION_WINDOW_MS = 2 * 60 * 1000;
// Ignore rounding-scale soft-limit deficits unless they persist long enough to look real.
export const SOFT_OVERSHOOT_DEADBAND_KW = 0.05;
export const SOFT_OVERSHOOT_PERSIST_MS = 20 * 1000;
// How much of the hour's REMAINING budget we are willing to spend while waiting to
// see whether a deficit is real, before shedding. The hard cap is an hourly mean
// (`notes/safe-pace-two-constraints.md`), so a deficit is a rate, not yet a fact
// about the hour: a transient that self-corrects costs a few Wh, while shedding
// costs comfort now, 1-5 min of device downtime, and — because deferring a load
// inside the same hour does not lower the hourly mean — saves no energy at all.
// The asymmetry is the whole argument for waiting; 2% keeps the wager small.
export const SHED_GRACE_HEADROOM_FRACTION = 0.02;
// Ceiling on that wait regardless of how cheap it looks, so a tiny deficit in a
// wide-open hour cannot defer shedding indefinitely. Sized from the measured
// transients: a charger overshoot resolved to its commanded step, or was shed,
// within ~30 s (bounded by its 30 s post-command report), so 60 s covers one with
// margin while staying far below the 2-minute activation attribution window.
// Deliberately NOT justified by any existing 60 s constant: the nearest one,
// `CapacityGuard.SHORTFALL_CLEAR_SUSTAIN_MS`, is the shortfall *clear* timer and
// requires sustained POSITIVE headroom — the opposite condition — and the
// sustained-shortfall alert's threshold is per-Flow user configuration, not a
// fixed deadline. There is no precedent here to match, only evidence to fit.
export const SHED_GRACE_MAX_MS = 60 * 1000;
export const SWAP_TIMEOUT_MS = 60000; // Clear pending swaps after 60s if they couldn't complete
export const RESTORE_ADMISSION_RESERVE_KW = 0.25; // Final slack required after restore admission
export const RESTORE_ADMISSION_FLOOR_KW = 0.25; // Minimum postReserveMarginKw for any restore to be admitted
// When power is fresh and headroom is abundant, allow a small restore batch instead of draining
// large shed backlogs one device per cooldown window.
export const RESTORE_BATCH_MAX_DEVICES = 3;
export const RESTORE_BATCH_HEADROOM_FRACTION = 0.5;
// Swaps cannot rely on shed capacity becoming fully effective immediately; reserve some headroom.
export const SWAP_RESTORE_RESERVE_KW = 0.3;
// How long a device may hold a startup reservation before it lapses. Bounds the case where the
// reserve can never be satisfied — a priority-2 device waiting behind an immovable priority-1 load
// — so lower-priority devices are not held out of admission indefinitely for a start that will not
// happen. Long enough for a genuine block to assemble as cycling loads finish their duty cycle.
export const HEADROOM_RESERVE_MAX_MS = 15 * 60 * 1000;
// `BINARY_COMMAND_PENDING_MS` moved to
// `lib/observer/pendingBinaryCommandTypes.ts` in PR #4 of the
// observer/transport split (see
// `notes/state-management/observer-transport-split.md`); the constant is no
// longer surfaced from plan because observer is the only consumer.
export const TARGET_COMMAND_RETRY_DELAYS_MS = [
  30 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
] as const;
export const STEPPED_LOAD_COMMAND_RETRY_DELAYS_MS = [
  30 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
] as const;
export const TARGET_CONFIRMATION_STUCK_POLL_MS = 60 * 1000;
export const TARGET_WAITING_LOG_REPEAT_MS = 60 * 1000;
