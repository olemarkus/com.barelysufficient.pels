/**
 * Nominal types for the smart-task energy quantities.
 *
 * These exist because the quantities are all `number` and were, for a long
 * time, all `number | null` — so `??` between any two of them compiled, and a
 * chain of such fallbacks silently swapped one for another. The specific defect
 * that motivated this module: `deferredPlanHistoryAttribution` compared
 * *cumulative delivered energy* against the FINAL revision's `energyExpectedKWh`
 * — which is the energy **still outstanding** at that moment, not a plan total
 * — via `energyExpectedKWh ?? plannedKWh`. Both operands were `number | null`,
 * so nothing objected, and a nine-hour EV run that was capacity-bound the whole
 * way reported "Target needed more energy than estimated."
 *
 * The brands are compile-time only: `Branded<number, K>` erases to `number`, so
 * a branded value serializes byte-identically. That matters here because plan
 * history is schema v4 and RELEASED — the persisted wire shape must not change
 * (`lib/objectives/deferredObjectives/planHistorySettings.ts`).
 *
 * This is a deliberately small, local idiom: it covers these three quantities
 * and does not introduce a general-purpose `Branded<T, K>` utility for the repo.
 *
 * Constructors return `| null` because they sit at the persisted-blob boundary,
 * where a value genuinely may be missing or malformed. Inward of a constructor
 * the value is non-nullable and callers must not re-check it — per the root
 * `AGENTS.md` rule "clean and trusted interfaces between layers".
 */

import { isFiniteNumber } from './numberGuards';

declare const energyBrand: unique symbol;

type Branded<T, K extends string> = T & { readonly [energyBrand]: K };

/**
 * Mean-based energy still needed to reach target, measured from one revision's
 * moment: `kWhPerUnit.mean × remainingUnits` (see
 * `notes/deferred-load-objectives/README.md`). It SHRINKS as a run delivers, so
 * the value from a late revision is not comparable with a run's cumulative
 * delivery — read it from the ORIGINAL revision when you want "what this run
 * needed in total".
 */
export type RemainingEnergyKWh = Branded<number, 'RemainingEnergyKWh'>;

/**
 * Sum of the per-hour `plannedKWh` a revision booked — the buffered
 * (`mean + k·SE`) allocation. A plan total, not a remainder.
 */
export type PlannedFloorEnergyKWh = Branded<number, 'PlannedFloorEnergyKWh'>;

/** Cumulative useful energy the executor delivered across a whole run. */
export type DeliveredEnergyKWh = Branded<number, 'DeliveredEnergyKWh'>;

/**
 * Narrows an untrusted persisted value to a positive finite energy figure.
 * Non-positive is rejected, not clamped: zero kWh is never a usable comparison
 * basis, and the persisted validators already treat a non-positive
 * `energyExpectedKWh` as tampering.
 */
const asPositiveEnergy = (value: unknown): number | null => (
  isFiniteNumber(value) && value > 0 ? value : null
);

export const asRemainingEnergyKWh = (value: unknown): RemainingEnergyKWh | null => (
  asPositiveEnergy(value) as RemainingEnergyKWh | null
);

export const asPlannedFloorEnergyKWh = (value: unknown): PlannedFloorEnergyKWh | null => (
  asPositiveEnergy(value) as PlannedFloorEnergyKWh | null
);

/**
 * Delivered energy admits zero — a run that delivered nothing is a real,
 * meaningful observation (it drives the `no_delivery` attribution), unlike a
 * zero comparison basis.
 */
export const asDeliveredEnergyKWh = (value: unknown): DeliveredEnergyKWh | null => (
  isFiniteNumber(value) && value >= 0 ? value as DeliveredEnergyKWh : null
);

/**
 * The ONE read of a revision's `energyExpectedKWh`, for both the persisted
 * history snapshot and the live active-plan revision (structurally typed so it
 * serves both without importing either contract).
 *
 * Absence is not "unknown" — the contract defines it as equality:
 * `energyExpectedKWh` is persisted "only when it differs from
 * `energyNeededKWh`; absent means no buffer to show (cold-start, bootstrap,
 * steady device)". That omission is a byte-stability optimisation and is
 * lossless, so resolving absence to `energyNeededKWh` recovers the exact value.
 *
 * Absence is the ORDINARY shape, not a legacy one: `bufferedRate` collapses to
 * the mean whenever `sampleCount < 4 || sigma <= 0`, so steady and bootstrap
 * devices omit the field on every revision they write.
 *
 * Null only when neither field is a usable positive number.
 */
export const resolveRemainingEnergyKWh = (
  revision: { energyExpectedKWh?: number; energyNeededKWh: number } | null | undefined,
): RemainingEnergyKWh | null => {
  if (revision === null || revision === undefined) return null;
  return asRemainingEnergyKWh(revision.energyExpectedKWh ?? revision.energyNeededKWh);
};
