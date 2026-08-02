/**
 * The two capacity settings the safe-pace family is derived from. In the canonical
 * names of `notes/safe-pace-two-constraints.md` § "Canonical names" — the
 * definition of record, whose translation subsection maps the local names here
 * onto the canonical ones — `limitKw` is `hardCapKw` and `marginKw` is
 * `safetyMarginKw`.
 */
export type CapacitySettings = {
  limitKw: number;
  marginKw: number;
};

/**
 * Owner of the hourly capacity allowance: `hourlyAllowanceKWh` read as energy, or
 * `sustainableRateKw` read as the steady rate that spends it — one owner, two
 * named readings (`notes/safe-pace-two-constraints.md`).
 *
 * A pure function of two settings values with no runtime state, so this is the
 * single place the subtraction belongs. Callers must not recompute it; the note
 * keeps the inventory of the six sites that still do, three of them in the
 * settings UI, which should receive the resolved value through the contract.
 */
export function resolveUsableCapacityKw(capacitySettings: CapacitySettings): number {
  return Math.max(0, capacitySettings.limitKw - capacitySettings.marginKw);
}

/**
 * Deprecated alias of `resolveUsableCapacityKw`, kept only until its last caller
 * (`lib/diagnostics/periodicStatus.ts`) moves over. The name promises
 * `capacityPaceKw` — the dynamic hourly threshold — but it returns
 * `hourlyAllowanceKWh`, a different quantity: the pace budgets the allowance over
 * the time left in the hour and legitimately exceeds it in an under-used hour. Do
 * not add callers; use `resolveUsableCapacityKw` directly.
 */
export function resolveCapacitySoftLimitKw(capacitySettings: CapacitySettings): number {
  return resolveUsableCapacityKw(capacitySettings);
}
