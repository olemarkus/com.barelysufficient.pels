import type { DevicePlanDevice } from '../planTypes';

/**
 * Per-axis available-power ledger for one restore pass
 * (`notes/safe-pace-two-constraints.md` § "Proposed model", admission-scoped).
 *
 * Owns the two admission axes so every candidate is evaluated on the axis that
 * actually constrains it, while the inner admission gates keep their single
 * `availableKw` scalar:
 *
 * - a budget-exempt candidate reads the CAPACITY axis only — its projected draw
 *   already sits in the daily-pace add-back, so gating it on the binding pace
 *   made its own reservation unusable by construction (prod 2026-08-01: a
 *   1.25 kW reservation could never cover a 1.41 kW inflated need plus
 *   reserves);
 * - a non-exempt candidate reads min(capacity, budget) where the budget axis
 *   uses the MEASURED exempt sum — it must not spend headroom that exists only
 *   as an off exempt device's projection (the same evening, a non-exempt
 *   thermostat was admitted out of the heater's reservation and then drew 0 W).
 *
 * Commits are per-axis: any admission consumes the capacity axis (real import
 * rises either way); only a non-exempt admission consumes the budget axis — an
 * exempt device's draw does not count toward the budget, and its projection is
 * already reserved in the pace.
 *
 * Callers translate at the loop boundary: read `availableFor(dev)` before the
 * gate, and `commit(dev, before - after)` when the gate returns a reduced
 * scalar. `summaryAvailableKw()` is the non-exempt view, used for the batch
 * throttle and the result scalar.
 */
export type RestoreHeadroomLedger = {
  availableFor(dev: Pick<DevicePlanDevice, 'budgetExempt'>): number;
  commit(dev: Pick<DevicePlanDevice, 'budgetExempt'>, spentKw: number): void;
  summaryAvailableKw(): number;
  // Post-pass axis values, for handing the per-axis state to a later stage
  // (the set_temperature hold lane rebuilds a ledger from these).
  axes(): { capacityAvailableKw: number; budgetAvailableKw: number | null };
};

export function buildRestoreHeadroomLedger(params: {
  capacityAvailableKw: number;
  budgetAvailableKw: number | null;
}): RestoreHeadroomLedger {
  let capacityKw = params.capacityAvailableKw;
  let budgetKw = params.budgetAvailableKw;
  return {
    availableFor(dev) {
      if (dev.budgetExempt === true) return capacityKw;
      return budgetKw === null ? capacityKw : Math.min(capacityKw, budgetKw);
    },
    commit(dev, spentKw) {
      // Finite-positive gate: a NaN delta from an upstream regression must not
      // poison the axes, and negative deltas (a swap freeing more than the
      // target needs) are deliberately dropped — conservative within the
      // cycle; the next rebuild reads the meter.
      if (!Number.isFinite(spentKw) || spentKw <= 0) return;
      capacityKw -= spentKw;
      if (dev.budgetExempt !== true && budgetKw !== null) budgetKw -= spentKw;
    },
    summaryAvailableKw() {
      return budgetKw === null ? capacityKw : Math.min(capacityKw, budgetKw);
    },
    axes() {
      return { capacityAvailableKw: capacityKw, budgetAvailableKw: budgetKw };
    },
  };
}
