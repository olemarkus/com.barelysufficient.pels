/**
 * `hardCapKw - safetyMarginKw`, floored at zero: the hour's allowance read as
 * energy (`hourlyAllowanceKWh`) or as the steady rate that spends it
 * (`sustainableRateKw`) — one owner, two named readings
 * (`notes/safe-pace-two-constraints.md` § "Canonical names").
 *
 * **Why the subtraction lives in shared-domain and not in `lib/power`.** The
 * runtime owner is still `resolveUsableCapacityKw` (`lib/power/capacityModel.ts`)
 * and everything derived from PERSISTED settings goes through it. But one
 * consumer computes over values the owner has never seen: the meter-area editor
 * renders the resulting pace while the owner is mid-keystroke, from unsaved form
 * text (`reactionKwLabel`, `packages/settings-ui/src/ui/homeLimits.ts`). No
 * resolved scalar on the contract can answer that, because the number does not
 * exist anywhere but in the input box. Putting the arithmetic here is what lets
 * "one concept, one implementation" and "the settings UI does not recompute
 * persisted state" both hold at once.
 *
 * Callers own their own input validation — this function assumes two finite
 * numbers and does the subtraction, nothing else.
 */
export function usableCapacityKw(hardCapKw: number, safetyMarginKw: number): number {
  return Math.max(0, hardCapKw - safetyMarginKw);
}
