export const SHED_COOLDOWN_MS = 60000; // Wait 60s after shedding before considering restores
export const RESTORE_COOLDOWN_MS = 60000; // Base cooldown after restore for power to stabilize
export const RESTORE_COOLDOWN_MAX_MS = 5 * 60 * 1000; // Cap restore backoff at 5 minutes
export const RESTORE_COOLDOWN_BACKOFF_MULTIPLIER = 2; // Exponential backoff multiplier
export const RESTORE_STABLE_RESET_MS = 5 * 60 * 1000; // Reset backoff after 5 minutes of stability
export const RECENT_SHED_RESTORE_BACKOFF_MS = 5 * 60 * 1000; // Wait up to 5 minutes after a shed before retrying restore
export const RECENT_SHED_RESTORE_MULTIPLIER = 1.15; // Require ~15% more headroom if device was just shed
export const RECENT_SHED_EXTRA_BUFFER_KW = 0.15; // Or at least an extra 0.15 kW cushion when re-restoring
export const RECENT_RESTORE_SHED_GRACE_MS = 3 * 60 * 1000; // Avoid re-shedding a freshly restored device for 3 minutes unless overshoot is large
export const RECENT_RESTORE_OVERSHOOT_BYPASS_KW = 0.5; // Allow immediate re-shed if overshoot is >= 0.5 kW
export const SWAP_TIMEOUT_MS = 60000; // Clear pending swaps after 60s if they couldn't complete
