import { resolveAttributionSplit } from '../../../shared-domain/src/dailyBudget/attributionSplit.ts';

export type UsageSplit = {
  controlledKWh?: number;
  uncontrolledKWh?: number;
};

const hasFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

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
    controlledGross: hasFiniteNumber(rawControlled) ? rawControlled : undefined,
    uncontrolledGross: hasFiniteNumber(rawUncontrolled) ? rawUncontrolled : undefined,
  });
  return {
    controlledKWh: controlled ?? undefined,
    uncontrolledKWh: uncontrolled ?? undefined,
  };
};
