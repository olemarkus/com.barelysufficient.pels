import { getZonedParts } from '../utils/dateUtils';

export function buildPlanBreakdown(params: {
  bucketStartUtcMs: number[];
  timeZone: string;
  plannedKWh: number[];
  breakdown: { uncontrolled: number[]; controlled: number[] } | null | undefined;
}): { plannedUncontrolledKWh: number[]; plannedControlledKWh: number[] } | null {
  const { bucketStartUtcMs, timeZone, plannedKWh, breakdown } = params;
  if (!breakdown) return null;
  const { uncontrolled, controlled } = breakdown;
  if (uncontrolled.length !== 24 || controlled.length !== 24) return null;
  const allocations = bucketStartUtcMs.map((ts, index) => {
    const hour = getZonedParts(new Date(ts), timeZone).hour;
    const baseUncontrolled = uncontrolled[hour] ?? 0;
    const baseControlled = controlled[hour] ?? 0;
    const baseTotal = baseUncontrolled + baseControlled;
    const planned = plannedKWh[index] ?? 0;
    if (planned <= 0) {
      return { uncontrolled: 0, controlled: 0 };
    }
    if (baseTotal <= 0) {
      return { uncontrolled: planned, controlled: 0 };
    }
    const uncontrolledShare = baseUncontrolled / baseTotal;
    const uncontrolledKWh = planned * uncontrolledShare;
    return {
      uncontrolled: uncontrolledKWh,
      controlled: Math.max(0, planned - uncontrolledKWh),
    };
  });
  return {
    plannedUncontrolledKWh: allocations.map((entry) => entry.uncontrolled),
    plannedControlledKWh: allocations.map((entry) => entry.controlled),
  };
}
