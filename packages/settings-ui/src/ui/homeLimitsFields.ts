import {
  HOME_LIMITS_HARD_CAP_MAX,
  HOME_LIMITS_HARD_CAP_POSITIVE,
  HOME_LIMITS_MARGIN_NEGATIVE,
  HOME_LIMITS_MARGIN_TOO_HIGH,
  HOME_LIMITS_VALUE_PLACEHOLDER,
} from '../../../shared-domain/src/homeLimitsCopy.ts';
import { usableCapacityKw } from '../../../shared-domain/src/capacityAllowance.ts';
import { formatHomeLimitsKw } from '../../../shared-domain/src/homeLimitsStatus.ts';

// Value rules for the meter-area editor's two number fields, hard cap and
// safety margin: reading the typed text, the live margin alert, the derived
// reaction figure, save-time validation, and what a field shows when its area
// is read. Pure; the controller (`homeLimits.ts`) owns the state.

export const parseFiniteOrNull = (raw: string): number | null => {
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
};

// Mirrors powerLimitControls.ts getMarginVsLimitError: quiet until both numbers are valid
// so a partially-typed value never flashes an error mid-edit.
export const marginVsCapError = (hardCapKw: number | null, marginKw: number | null): string | null => {
  if (hardCapKw === null || hardCapKw <= 0) return null;
  if (marginKw === null || marginKw < 0) return null;
  return marginKw >= hardCapKw ? HOME_LIMITS_MARGIN_TOO_HIGH : null;
};

export const reactionKwLabel = (hardCapKw: number | null, marginKw: number | null): string => {
  if (hardCapKw === null || hardCapKw <= 0 || marginKw === null || marginKw < 0) {
    return HOME_LIMITS_VALUE_PLACEHOLDER;
  }
  return formatHomeLimitsKw(usableCapacityKw(hardCapKw, marginKw));
};

export const validateAreaCaps = (hardCapKw: number, marginKw: number): string | null => {
  if (!Number.isFinite(hardCapKw) || hardCapKw <= 0) return HOME_LIMITS_HARD_CAP_POSITIVE;
  if (hardCapKw > 1000) return HOME_LIMITS_HARD_CAP_MAX;
  if (!Number.isFinite(marginKw) || marginKw < 0) return HOME_LIMITS_MARGIN_NEGATIVE;
  if (marginKw >= hardCapKw) return HOME_LIMITS_MARGIN_TOO_HIGH;
  return null;
};

/**
 * Whether an open field follows a fresh read of the store. While it still holds
 * its baseline (the stored value it last showed, or the value last committed
 * from it) it follows; any other text is the user's edit, typed and not yet
 * committed, and stays. A kept edit keeps its baseline too: moving it to the
 * read value would make the edit look clean if the user later typed that same
 * value, and the next read would then overwrite it.
 */
export const capFieldFollowsRead = (text: string, baselineKw: number): boolean => (
  parseFiniteOrNull(text) === baselineKw
);
