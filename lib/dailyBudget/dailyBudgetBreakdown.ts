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
  const plannedUncontrolledKWh: number[] = [];
  const plannedControlledKWh: number[] = [];
  for (const [index, ts] of bucketStartUtcMs.entries()) {
    const hour = getZonedParts(new Date(ts), timeZone).hour;
    const baseUncontrolled = uncontrolled[hour] ?? 0;
    const baseControlled = controlled[hour] ?? 0;
    const baseTotal = baseUncontrolled + baseControlled;
    const planned = plannedKWh[index] ?? 0;
    if (planned <= 0) {
      plannedUncontrolledKWh.push(0);
      plannedControlledKWh.push(0);
      continue;
    }
    if (baseTotal <= 0) {
      plannedUncontrolledKWh.push(planned);
      plannedControlledKWh.push(0);
      continue;
    }
    const uncontrolledShare = baseUncontrolled / baseTotal;
    const uncontrolledKWh = planned * uncontrolledShare;
    plannedUncontrolledKWh.push(uncontrolledKWh);
    plannedControlledKWh.push(Math.max(0, planned - uncontrolledKWh));
  }
  return { plannedUncontrolledKWh, plannedControlledKWh };
}
