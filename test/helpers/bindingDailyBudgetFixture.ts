import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';

// A 1.1 kWh hourly budget binds below the restore specs' capacity limit while
// leaving positive budget headroom once the initial shedding episode clears.
export const buildBindingDailyBudgetSnapshot = (dayStartMs: number): DailyBudgetUiPayload => {
  const dayStartUtc = new Date(dayStartMs).toISOString();
  const dateKey = dayStartUtc.slice(0, 10);
  const hours = Array.from({ length: 24 }, (_, index) => index);
  const plannedKWh = hours.map(() => 1.1);
  const day: DailyBudgetDayPayload = {
    dateKey,
    timeZone: 'UTC',
    nowUtc: dayStartUtc,
    dayStartUtc,
    currentBucketIndex: 0,
    budget: { enabled: true, dailyBudgetKWh: 26.4, priceShapingEnabled: false },
    state: {
      usedNowKWh: 0,
      allowedNowKWh: 1.1,
      remainingKWh: 25.3,
      deviationKWh: 0,
      exceeded: false,
      frozen: false,
      confidence: 1,
      priceShapingActive: false,
    },
    buckets: {
      startUtc: hours.map((index) => new Date(dayStartMs + index * 60 * 60 * 1000).toISOString()),
      startLocalLabels: hours.map((index) => String(index).padStart(2, '0')),
      plannedWeight: hours.map(() => 1),
      plannedKWh,
      plannedUncontrolledKWh: hours.map(() => 0),
      plannedControlledKWh: plannedKWh.slice(),
      actualKWh: hours.map(() => 0),
      actualControlledKWh: hours.map(() => 0),
      actualUncontrolledKWh: hours.map(() => 0),
      allowedCumKWh: hours.map((index) => 1.1 * (index + 1)),
      price: hours.map(() => 30),
    },
  };
  return { todayKey: dateKey, days: { [dateKey]: day } };
};
