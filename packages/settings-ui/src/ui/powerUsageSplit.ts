import { resolveAttributionSplit } from '../../../shared-domain/src/dailyBudget/attributionSplit.ts';
import { isFiniteNumber } from '../../../shared-domain/src/numberGuards.ts';

export type UsageSplit = {
  controlledKWh?: number;
  uncontrolledKWh?: number;
};

// Power-view per-hour managed vs background split. Uses the shared gross-preferring
// resolver so it matches the daily-budget breakdown view and the raw tracker buckets
// (managed + background reflect actual consumption, not the net total reduced by solar).
export const resolveUsageSplit = (params: {
  totalKWh: number;
  rawControlled: unknown;
  rawUncontrolled: unknown;
}): UsageSplit => {
  const { totalKWh, rawControlled, rawUncontrolled } = params;
  const { controlled, uncontrolled } = resolveAttributionSplit({
    totalNet: totalKWh,
    controlledGross: isFiniteNumber(rawControlled) ? rawControlled : undefined,
    uncontrolledGross: isFiniteNumber(rawUncontrolled) ? rawUncontrolled : undefined,
  });
  return {
    controlledKWh: controlled ?? undefined,
    uncontrolledKWh: uncontrolled ?? undefined,
  };
};
