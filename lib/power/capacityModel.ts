import { usableCapacityKw } from '../../packages/shared-domain/src/capacityAllowance';
import { capacityPeriodEnergyKWh } from '../../packages/shared-domain/src/settings/capacityPeriod';
import { planningPowerCeiling } from '../../packages/shared-domain/src/settings/powerLimits';
import type {
  CapacitySettings, PowerLimitCeiling, PowerLimitSettings,
} from '../../packages/contracts/src/capacitySettings';

/**
 * The two capacity settings the safe-pace family is derived from. In the canonical
 * names of `notes/safe-pace-two-constraints.md` § "Canonical names" — the
 * definition of record, whose translation subsection maps the local names here
 * onto the canonical ones — `limitKw` is `hardCapKw` and `marginKw` is
 * `safetyMarginKw`.
 */
export type CapacityLimitSettings = {
  limitKw: number;
  marginKw: number;
};

/**
 * Owner of the capacity allowance: the selected period's kWh read as energy, or
 * `sustainableRateKw` read as the steady rate that spends it — one owner, two
 * named readings (`notes/safe-pace-two-constraints.md`).
 *
 * The runtime owner: every quantity derived from PERSISTED capacity settings is
 * resolved here and handed out, so no caller recomputes the subtraction. The
 * arithmetic itself lives in `packages/shared-domain/src/capacityAllowance.ts`
 * because the settings UI must also apply it to unsaved form input, which no
 * resolved scalar on the contract can answer — see that file for why.
 */
export function resolveUsableCapacityKw(capacitySettings: CapacityLimitSettings): number {
  return usableCapacityKw(capacitySettings.limitKw, capacitySettings.marginKw);
}

/** Energy allowance for the configured billing window. */
export function resolveUsableCapacityKWh(capacitySettings: CapacitySettings): number {
  return capacityPeriodEnergyKWh(resolveUsableCapacityKw(capacitySettings), capacitySettings.periodMinutes);
}

/** Hard-cap energy boundary for the configured billing window. */
export function resolveHardCapacityKWh(capacitySettings: CapacitySettings): number {
  return capacityPeriodEnergyKWh(Math.max(0, capacitySettings.limitKw), capacitySettings.periodMinutes);
}

/**
 * Owner of the house planning ceiling (`planningCeiling` in
 * `notes/safe-pace-two-constraints.md`): the import rate the daily budget's
 * hours, smart-task reservations and budget-pressure eligibility plan against
 * (the weather suggestion and the Budget page's recommendation apply the same
 * shared arithmetic, `planningPowerCeiling`, where this owner cannot be reached).
 * It is the lower enabled limit, so a disabled Capacity limit stops shaping
 * plans and an enabled grid import limit starts to; `null` when no power limit
 * is enabled. With only Capacity limit on it equals `resolveUsableCapacityKw`.
 *
 * The live capacity pace is NOT this: it stays on the period allowance
 * (`computeDynamicSoftLimit`), and live admission spends measured grid headroom.
 */
export function resolvePlanningPowerCeiling(settings: PowerLimitSettings): PowerLimitCeiling | null {
  return planningPowerCeiling(settings);
}

/** The planning ceiling read as a rate alone, for consumers that never name the limit. */
export function resolvePlanningCeilingKw(settings: PowerLimitSettings): number | null {
  return resolvePlanningPowerCeiling(settings)?.kw ?? null;
}
