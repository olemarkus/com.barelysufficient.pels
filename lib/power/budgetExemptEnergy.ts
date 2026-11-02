import type { PowerTrackerState } from '../../packages/contracts/src/powerTrackerTypes';

const finiteNonNegative = (value: number | undefined): number => (
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
);

/**
 * The budget-exempt energy booked in one UTC hour: the managed share
 * (`exemptBuckets`) plus the background share (`uncontrolledExemptBuckets`),
 * bounded by the hour's metered total. The one read of "how much of this hour
 * the daily budget does not pace", for the planner's pace and the daily budget's
 * own views alike, so neither sums the families itself.
 *
 * Bounded by the NET metered total, floored at 0: the shares are gross draw at
 * the appliance, which under solar self-consumption can exceed what the meter
 * billed, and a legacy export hour can persist a negative total. Attribution
 * (which share is managed) is a different question and reads `exemptBuckets`
 * alone.
 */
export function resolveBudgetExemptKWh(powerTracker: PowerTrackerState, hourKey: string): number {
  const meteredKWh = finiteNonNegative(powerTracker.buckets?.[hourKey]);
  const exemptKWh = finiteNonNegative(powerTracker.exemptBuckets?.[hourKey])
    + finiteNonNegative(powerTracker.uncontrolledExemptBuckets?.[hourKey]);
  return Math.min(exemptKWh, meteredKWh);
}
