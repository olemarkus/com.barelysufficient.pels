import { usableCapacityKw } from '../../packages/shared-domain/src/capacityAllowance';

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
 * The runtime owner: every quantity derived from PERSISTED capacity settings is
 * resolved here and handed out, so no caller recomputes the subtraction. The
 * arithmetic itself lives in `packages/shared-domain/src/capacityAllowance.ts`
 * because the settings UI must also apply it to unsaved form input, which no
 * resolved scalar on the contract can answer — see that file for why.
 */
export function resolveUsableCapacityKw(capacitySettings: CapacitySettings): number {
  return usableCapacityKw(capacitySettings.limitKw, capacitySettings.marginKw);
}
