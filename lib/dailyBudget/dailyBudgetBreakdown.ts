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
  return bucketStartUtcMs.reduce((acc, ts, index) => {
    const hour = getZonedParts(new Date(ts), timeZone).hour;
    const baseUncontrolled = uncontrolled[hour] ?? 0;
    const baseControlled = controlled[hour] ?? 0;
    const baseTotal = baseUncontrolled + baseControlled;
    const planned = plannedKWh[index] ?? 0;
    if (planned <= 0) {
      return {
        plannedUncontrolledKWh: [...acc.plannedUncontrolledKWh, 0],
        plannedControlledKWh: [...acc.plannedControlledKWh, 0],
      };
    }
    if (baseTotal <= 0) {
      return {
        plannedUncontrolledKWh: [...acc.plannedUncontrolledKWh, planned],
        plannedControlledKWh: [...acc.plannedControlledKWh, 0],
      };
    }
    const uncontrolledShare = baseUncontrolled / baseTotal;
    const uncontrolledKWh = planned * uncontrolledShare;
    return {
      plannedUncontrolledKWh: [...acc.plannedUncontrolledKWh, uncontrolledKWh],
      plannedControlledKWh: [...acc.plannedControlledKWh, Math.max(0, planned - uncontrolledKWh)],
    };
  }, { plannedUncontrolledKWh: [] as number[], plannedControlledKWh: [] as number[] });
}
