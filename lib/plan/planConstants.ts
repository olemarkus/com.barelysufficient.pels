export const SHED_COOLDOWN_MS = 60000; // Wait 60s after shedding before considering restores
export const RESTORE_COOLDOWN_MS = 60000; // Base cooldown after restore for power to stabilize
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
// Reserve headroom for recently restored devices whose elements have not yet fired.
// Elements typically fire within 1-2 minutes; 3 minutes covers slower thermal responses.
export const PENDING_RESTORE_WINDOW_MS = 3 * 60 * 1000;
// A device is considered to have confirmed its draw once it reaches this fraction of expected power.
export const PENDING_RESTORE_CONFIRMED_FRACTION = 0.5;
export const SWAP_TIMEOUT_MS = 60000; // Clear pending swaps after 60s if they couldn't complete
export const RESTORE_ADMISSION_RESERVE_KW = 0.25; // Final slack required after restore admission
export const RESTORE_ADMISSION_FLOOR_KW = 0.25; // Minimum postReserveMarginKw for any restore to be admitted
// Swaps cannot rely on shed capacity becoming fully effective immediately; reserve some headroom.
export const SWAP_RESTORE_RESERVE_KW = 0.3;
export const BINARY_COMMAND_PENDING_MS = 15000;
export const TARGET_COMMAND_RETRY_DELAYS_MS = [
  30 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
] as const;
export const TARGET_CONFIRMATION_STUCK_POLL_MS = 60 * 1000;
export const TARGET_WAITING_LOG_REPEAT_MS = 60 * 1000;
