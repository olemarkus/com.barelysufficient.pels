import type { DevicePlanDevice } from '../planTypes';
import { minPowerLimit } from '../powerLimitMath';

/**
 * The room left on each admission axis at the start of a restore pass, `null`
 * for an axis whose limit is off (`MeasuredPower.capacityHeadroomKw`,
 * `gridHeadroomKw`, `budgetHeadroomKw`). Every increase spends both physical
 * axes; a budget exemption only bypasses the budget axis.
 */
export type RestoreHeadroomAxes = {
  capacityAvailableKw: number | null;
  gridAvailableKw: number | null;
  budgetAvailableKw: number | null;
};

/**
 * Per-axis available-power ledger for one restore pass
 * (`notes/safe-pace-two-constraints.md` § "Proposed model", admission-scoped).
 *
 * Owns the three admission axes so every candidate is evaluated on the axes
 * that actually constrain it, while the inner admission gates keep their single
 * `availableKw` scalar:
 *
 * - every candidate reads the PHYSICAL axes, capacity and grid: a restore adds
 *   real import whatever its budget standing, so both limits see it;
 * - a budget-exempt candidate reads the physical axes only — its projected draw
 *   already sits in the daily-pace add-back, so gating it on the binding pace
 *   made its own reservation unusable by construction (prod 2026-08-01: a
 *   1.25 kW reservation could never cover a 1.41 kW inflated need plus
 *   reserves);
 * - a non-exempt candidate also reads the budget axis, which uses the MEASURED
 *   exempt sum — it must not spend headroom that exists only as an off exempt
 *   device's projection (the same evening, a non-exempt thermostat was admitted
 *   out of the heater's reservation and then drew 0 W).
 *
 * `availableFor` is the lowest of the axes that apply, and `null` only when
 * none does (no limit is on): the candidate is unconstrained
 * (`resolveReserveAdmission`), never handed a stand-in number.
 *
 * Commits are per-axis: any admission consumes the capacity and grid axes (real
 * import rises either way); only a non-exempt admission consumes the budget
 * axis — an exempt device's draw does not count toward the budget, and its
 * projection is already reserved in the pace. An axis that is off stays off.
 *
 * Callers translate at the loop boundary: read `availableFor(dev)` before the
 * gate, and `commit(dev, before - after)` when the gate returns a reduced
 * scalar — only when both are numbers, since an unconstrained candidate spent
 * no counted room. `summaryAvailableKw()` is the non-exempt view, used for the
 * batch throttle and the result scalar.
 */
export type RestoreHeadroomLedger = {
  availableFor(dev: Pick<DevicePlanDevice, 'budgetExempt'>): number | null;
  commit(dev: Pick<DevicePlanDevice, 'budgetExempt'>, spentKw: number): void;
  summaryAvailableKw(): number | null;
  axes(): RestoreHeadroomAxes;
};

export function buildRestoreHeadroomLedger(axes: RestoreHeadroomAxes): RestoreHeadroomLedger {
  let capacityKw = axes.capacityAvailableKw;
  let gridKw = axes.gridAvailableKw;
  let budgetKw = axes.budgetAvailableKw;
  return {
    availableFor(dev) {
      return minPowerLimit(capacityKw, gridKw, dev.budgetExempt === true ? null : budgetKw);
    },
    commit(dev, spentKw) {
      // Finite-positive gate: a NaN delta from an upstream regression must not
      // poison the axes, and negative deltas (a swap freeing more than the
      // target needs) are deliberately dropped — conservative within the
      // cycle; the next rebuild reads the meter.
      if (!Number.isFinite(spentKw) || spentKw <= 0) return;
      if (capacityKw !== null) capacityKw -= spentKw;
      if (gridKw !== null) gridKw -= spentKw;
      if (dev.budgetExempt !== true && budgetKw !== null) budgetKw -= spentKw;
    },
    summaryAvailableKw() {
      return minPowerLimit(capacityKw, gridKw, budgetKw);
    },
    axes() {
      return { capacityAvailableKw: capacityKw, gridAvailableKw: gridKw, budgetAvailableKw: budgetKw };
    },
  };
}
