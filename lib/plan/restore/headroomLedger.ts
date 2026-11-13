import type { DevicePlanDevice } from '../planTypes';
import { minLimitHeadroom, spendLimitHeadroom, type LimitHeadroom } from '../planContext';
import { phaseRoomFor, spendPhaseRoom, spendPhaseVector, type PhaseRoomAxis } from '../phase/phaseRoom';
import type { ChargingPhaseDebit } from '../../../packages/planner-types/src/chargingPhases';

/**
 * The room left on each admission axis at the start of a restore pass, `off`
 * for an axis whose limit is off (`MeasuredPower.capacityHeadroom`,
 * `gridHeadroom`, `budgetHeadroom`). Every increase spends both physical
 * axes; a budget exemption only bypasses the budget axis.
 */
export type RestoreHeadroomAxes = {
  capacity: LimitHeadroom;
  grid: LimitHeadroom;
  budget: LimitHeadroom;
  phase: PhaseRoomAxis;
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
 * A phase axis, when phases are protected, adds a per-footprint room
 * (`phase/phaseRoom.ts`) to every candidate's physical axes; the inner gates keep
 * their single scalar. `summaryAvailableKw()` stays the non-exempt scalar view.
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
type LedgerDevice = Pick<DevicePlanDevice, 'budgetExempt' | 'phaseFootprint'>;

export type RestoreHeadroomLedger = {
  availableFor(dev: LedgerDevice): number | null;
  commit(dev: LedgerDevice, spentKw: number): void;
  /** A phase redistribution can consume phase room while its total-power increase is zero. */
  commitPhaseVector(dev: Pick<LedgerDevice, 'budgetExempt'>, debit: ChargingPhaseDebit): void;
  summaryAvailableKw(): number | null;
  axes(): RestoreHeadroomAxes;
};

export function buildRestoreHeadroomLedger(axes: RestoreHeadroomAxes): RestoreHeadroomLedger {
  let capacity = axes.capacity;
  let grid = axes.grid;
  let budget = axes.budget;
  let phase = axes.phase;
  const availableKw = (...limits: LimitHeadroom[]): number | null => {
    const headroom = minLimitHeadroom(...limits);
    return headroom.kind === 'on' ? headroom.kw : null;
  };
  return {
    availableFor(dev) {
      return availableKw(
        capacity, grid, dev.budgetExempt ? { kind: 'off' } : budget, phaseRoomFor(phase, dev.phaseFootprint),
      );
    },
    commit(dev, spentKw) {
      // Negative swaps free no room until the next meter sample; keep the existing
      // admission-delta boundary's finite-positive gate.
      if (!Number.isFinite(spentKw) || spentKw <= 0) return;
      capacity = spendLimitHeadroom(capacity, spentKw);
      grid = spendLimitHeadroom(grid, spentKw);
      if (!dev.budgetExempt) budget = spendLimitHeadroom(budget, spentKw);
      phase = spendPhaseRoom(phase, dev.phaseFootprint, spentKw);
    },
    commitPhaseVector(dev, debit) {
      capacity = spendLimitHeadroom(capacity, debit.totalKw);
      grid = spendLimitHeadroom(grid, debit.totalKw);
      if (!dev.budgetExempt) budget = spendLimitHeadroom(budget, debit.totalKw);
      phase = spendPhaseVector(phase, debit.perPhaseKw);
    },
    summaryAvailableKw() {
      return availableKw(capacity, grid, budget);
    },
    axes() {
      return { capacity, grid, budget, phase };
    },
  };
}
