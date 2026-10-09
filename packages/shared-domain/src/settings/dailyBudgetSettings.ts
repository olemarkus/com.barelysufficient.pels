// The daily-budget settings both the runtime and the settings UI read: their
// bounds and option values, and the read policy for the two option settings, so
// a stored value plans and displays the same on both sides. This is their one
// copy: `lib/dailyBudget/dailyBudgetConstants.ts` re-exports the values beside
// the runtime-only tuning constants. They cannot live in `packages/contracts`,
// which the packaged app does not ship.
import { isFiniteNumber } from '../numberGuards';

export const MIN_DAILY_BUDGET_KWH = 20;
export const MAX_DAILY_BUDGET_KWH = 360;
export const UNMANAGED_RESERVE_BALANCED_MODE = 0;
export const UNMANAGED_RESERVE_CONSERVATIVE_MODE = 1;
export const UNMANAGED_RESERVE_MODE = UNMANAGED_RESERVE_BALANCED_MODE;
export const PRICE_FLEX_LOW = 0.3;
export const PRICE_FLEX_MEDIUM = 0.6;
export const PRICE_FLEX_HIGH = 0.85;
export const PRICE_FLEX_HIGH_THRESHOLD = 0.7;
export const PRICE_SHAPING_FLEX_SHARE = PRICE_FLEX_MEDIUM;

/**
 * Read policy for the stored unmanaged-reserve mode: anything but a finite number
 * reads as the default mode, and a number snaps to the nearer of the two modes.
 */
export const normalizeUnmanagedReserveMode = (value: unknown): number => {
  if (!isFiniteNumber(value)) return UNMANAGED_RESERVE_MODE;
  return value >= 0.5 ? UNMANAGED_RESERVE_CONSERVATIVE_MODE : UNMANAGED_RESERVE_MODE;
};

/**
 * Read policy for the stored price-flex share: anything but a finite number reads
 * as the default share, and a number snaps to Low, Medium or High. Exactly
 * PRICE_FLEX_HIGH_THRESHOLD is Medium.
 */
export const normalizePriceFlexShare = (value: unknown): number => {
  if (!isFiniteNumber(value)) return PRICE_SHAPING_FLEX_SHARE;
  const bounded = Math.min(1, Math.max(0, value));
  if (bounded <= PRICE_FLEX_LOW) return PRICE_FLEX_LOW;
  if (bounded > PRICE_FLEX_HIGH_THRESHOLD) return PRICE_FLEX_HIGH;
  return PRICE_FLEX_MEDIUM;
};
