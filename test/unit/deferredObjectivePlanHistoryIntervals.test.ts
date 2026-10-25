import {
  bookedKWhForInterval,
  mergeHourStartBookings,
} from '../../lib/objectives/deferredObjectives/planHistoryHourStartBookings';
import type { DeferredObjectiveActivePlanRevisionV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';

const HOUR_MS = 3_600_000;
const revision = (hours: DeferredObjectiveActivePlanRevisionV1['hours']): DeferredObjectiveActivePlanRevisionV1 => ({
  revision: 1,
  revisedAtMs: 0,
  computedFromPricesUpTo: HOUR_MS,
  reason: 'flow_card',
  hours,
  energyNeededKWh: 2,
  planStatus: 'on_track',
});

describe('history booking intervals', () => {
  it('distributes an hourly commitment across quarters without duplicating its energy', () => {
    const plan = revision([{ startsAtMs: 0, endsAtMs: HOUR_MS, plannedKWh: 2 }]);
    const quarters = Array.from({ length: 4 }, (_, i) => bookedKWhForInterval(plan, i * HOUR_MS / 4, (i + 1) * HOUR_MS / 4));
    expect(quarters).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it('uses actual partial coverage without spreading energy into the elapsed part', () => {
    const plan = revision([{ startsAtMs: 0, endsAtMs: HOUR_MS, coversFromMs: HOUR_MS / 6, plannedKWh: 1 }]);
    expect(bookedKWhForInterval(plan, 0, HOUR_MS / 6)).toBe(0);
    expect(bookedKWhForInterval(plan, 0, HOUR_MS / 4)).toBeCloseTo(0.1);
    expect(bookedKWhForInterval(plan, HOUR_MS / 4, HOUR_MS)).toBeCloseTo(0.9);
  });

  it('retains saved quarter coverage and fills only the uncovered part of a live hourly row', () => {
    expect(mergeHourStartBookings(
      [{ atMs: 0, endsAtMs: HOUR_MS / 4, bookedKWh: 0.75 }],
      [{ atMs: 0, endsAtMs: HOUR_MS, bookedKWh: 4 }],
    )).toEqual([
      { atMs: 0, endsAtMs: HOUR_MS / 4, bookedKWh: 0.75 },
      { atMs: HOUR_MS / 4, endsAtMs: HOUR_MS, bookedKWh: 3 },
    ]);
  });

  it('keeps a legacy hourly capture whole when a restarted source supplies quarters', () => {
    const saved = [{ atMs: 0, endsAtMs: HOUR_MS, bookedKWh: 2 }];
    const live = Array.from({ length: 4 }, (_, i) => ({
      atMs: i * HOUR_MS / 4, endsAtMs: (i + 1) * HOUR_MS / 4, bookedKWh: 0.75,
    }));
    expect(mergeHourStartBookings(saved, live)).toEqual(saved);
  });
});
