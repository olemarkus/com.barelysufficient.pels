import { getZonedParts } from '../../packages/shared-domain/src/utils/dateUtils';
import { buildUncontrolledReserveFloors } from './dailyBudgetPlanCaps';
import type { DayContext } from './dailyBudgetState';
import type { DailyBudgetState } from './dailyBudgetTypes';
import { resolveObservedHourlyStats } from './observedHourlyStats';

export type StoredPlanBreakdown = {
  plannedUncontrolledKWh?: number[];
  plannedGrossUncontrolledKWh?: number[];
  plannedControlledKWh?: number[];
  grossBackfilled: boolean;
  grossBackfillComplete: boolean;
};

export const resolveStoredPlanBreakdown = (params: {
  state: DailyBudgetState;
  bucketCount: number;
  context: DayContext;
  controlledUsageWeight: number;
}): StoredPlanBreakdown => {
  const { state, bucketCount, context, controlledUsageWeight } = params;
  const { plannedUncontrolledKWh, plannedGrossUncontrolledKWh, plannedControlledKWh } = state;
  const hasStoredSplit = Array.isArray(plannedUncontrolledKWh)
    && Array.isArray(plannedControlledKWh)
    && plannedUncontrolledKWh.length === bucketCount
    && plannedControlledKWh.length === bucketCount;
  if (!hasStoredSplit) return { grossBackfilled: false, grossBackfillComplete: false };
  const hasStoredGross = Array.isArray(plannedGrossUncontrolledKWh)
    && plannedGrossUncontrolledKWh.length === bucketCount;
  const backfill = hasStoredGross
    ? null
    : buildStoredGrossUncontrolledKWh({ state, context, plannedUncontrolledKWh, controlledUsageWeight });
  const backfilledGross = hasStoredGross ? plannedGrossUncontrolledKWh : backfill?.values;
  return {
    plannedUncontrolledKWh,
    ...(backfilledGross ? { plannedGrossUncontrolledKWh: backfilledGross } : {}),
    plannedControlledKWh,
    grossBackfilled: !hasStoredGross && Boolean(backfilledGross),
    grossBackfillComplete: hasStoredGross || Boolean(backfill?.complete),
  };
};

const buildStoredGrossUncontrolledKWh = (params: {
  state: DailyBudgetState;
  context: DayContext;
  plannedUncontrolledKWh: number[];
  controlledUsageWeight: number;
}): { values: number[]; complete: boolean } | undefined => {
  const { state, context, plannedUncontrolledKWh, controlledUsageWeight } = params;
  const observed = resolveObservedHourlyStats(state);
  const sampleCounts = observed.profileObservedGrossUncontrolledSampleCounts;
  const grossSamplePresence = context.bucketStartUtcMs.map((bucketStartMs) => (
    hasObservedGrossSample(sampleCounts, bucketStartMs, context.timeZone)
  ));
  const hasGrossSamples = grossSamplePresence.some(Boolean);
  if (!hasGrossSamples) return undefined;
  const grossReserveFloors = buildUncontrolledReserveFloors({
    bucketStartUtcMs: context.bucketStartUtcMs,
    timeZone: context.timeZone,
    profileObservedMinUncontrolledKWh: observed.profileObservedMinUncontrolledKWh,
    profileObservedP50UncontrolledKWh: observed.profileObservedP50GrossUncontrolledKWh,
    profileObservedP75UncontrolledKWh: observed.profileObservedP75GrossUncontrolledKWh,
    profileObservedP90UncontrolledKWh: observed.profileObservedP90GrossUncontrolledKWh,
    profileObservedUncontrolledSampleCounts: sampleCounts,
    applyFromIndex: 0,
    reserveAggressiveness: controlledUsageWeight,
  });
  const values = plannedUncontrolledKWh.map((planned, index) => (
    grossSamplePresence[index] === true
      ? Math.max(0, grossReserveFloors[index] ?? 0)
      : Math.max(0, planned)
  ));
  return {
    values,
    complete: grossSamplePresence.every(Boolean),
  };
};

const hasObservedGrossSample = (sampleCounts: number[], bucketStartMs: number, timeZone: string): boolean => {
  const hour = getZonedParts(new Date(bucketStartMs), timeZone).hour;
  const samples = sampleCounts[hour];
  return typeof samples === 'number' && Number.isFinite(samples) && samples > 0;
};
