import type { DevicePlanDevice } from '../planTypes';
import { minPowerLimit } from '../powerLimitMath';

/** Every increase spends both physical axes. Budget exemptions only bypass the budget axis. */
export type RestoreHeadroomAxes = {
  capacityAvailableKw: number | null;
  gridAvailableKw: number | null;
  budgetAvailableKw: number | null;
};

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
