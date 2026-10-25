import type { DeferredObjectiveActivePlanRevisionV1 } from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import type { HorizonHour } from './deadlinePlanData.ts';

// Project the booking energy onto presentation periods by actual overlap. The
// grid may have changed since the commitment was made, and current bookings can
// begin between price boundaries.
export const buildChargeByStartMs = (
  revision: Pick<DeferredObjectiveActivePlanRevisionV1, 'hours'> | null,
  periods: readonly Pick<HorizonHour, 'startsAtMs' | 'endMs'>[],
): Map<number, number> => {
  const out = new Map<number, number>();
  for (const period of periods) {
    let energy = 0;
    for (const booking of revision?.hours ?? []) {
      const start = booking.coversFromMs ?? booking.startsAtMs;
      const overlap = Math.max(0, Math.min(period.endMs, booking.endsAtMs) - Math.max(period.startsAtMs, start));
      if (booking.plannedKWh > 0 && overlap > 0) energy += booking.plannedKWh * overlap / (booking.endsAtMs - start);
    }
    if (energy > 0) out.set(period.startsAtMs, energy);
  }
  return out;
};
