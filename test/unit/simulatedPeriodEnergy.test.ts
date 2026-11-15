import { describe, expect, it } from 'vitest';
import { SimulatedPeriodEnergy } from '../../lib/plan/simulatedPeriodEnergy';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { buildPlanDevice } from '../utils/planTestUtils';

const HOUR_12 = Date.UTC(2026, 9, 6, 12);
const MIN = 60_000;
const key = (ms: number) => new Date(ms).toISOString();

const tracker = (lastTimestamp: number, buckets: Record<string, number>, quarterKWh?: number): PowerTrackerState => ({
  lastTimestamp,
  lastPowerW: 6000,
  buckets,
  ...(quarterKWh === undefined ? {} : {
    capacityQuarter: { startMs: Math.floor(lastTimestamp / (15 * MIN)) * 15 * MIN, energyKWh: quarterKWh, trackedMs: 0 },
  }),
}) as PowerTrackerState;

const heldOff = (drawKw: number) => buildPlanDevice({
  id: 'garage', plannedState: 'shed', plannedShedTargetKind: 'binary_off', currentDrawKw: drawKw,
});

describe('SimulatedPeriodEnergy', () => {
  it('takes the held relief off each hour and the current quarter, from the tracker it counted against', () => {
    const ledger = new SimulatedPeriodEnergy();
    ledger.hold([heldOff(2)], tracker(HOUR_12 + 50 * MIN, {}));
    // Ten minutes later, across the 13:00 boundary.
    ledger.accrue(tracker(HOUR_12 + 70 * MIN, {}));
    const view = ledger.planningView(tracker(HOUR_12 + 70 * MIN, {
      [key(HOUR_12)]: 5, [key(HOUR_12 + 60 * MIN)]: 1,
    }, 0.9));

    expect(view.buckets?.[key(HOUR_12)]).toBeCloseTo(5 - 2 * (10 / 60));
    expect(view.buckets?.[key(HOUR_12 + 60 * MIN)]).toBeCloseTo(1 - 2 * (10 / 60));
    expect(view.capacityQuarter?.energyKWh).toBeCloseTo(0.9 - 2 * (10 / 60));
  });

  it('counts only what the tracker has counted, and never an interval twice', () => {
    const ledger = new SimulatedPeriodEnergy();
    ledger.hold([heldOff(3)], tracker(HOUR_12, {}));
    ledger.accrue(tracker(HOUR_12, {}));
    ledger.accrue(tracker(HOUR_12 + 6 * MIN, {}));
    ledger.accrue(tracker(HOUR_12 + 6 * MIN, {}));
    const view = ledger.planningView(tracker(HOUR_12 + 6 * MIN, { [key(HOUR_12)]: 2 }));
    expect(view.buckets?.[key(HOUR_12)]).toBeCloseTo(2 - 0.3);
  });

  it('leaves an exporting hour as measured and never takes an hour below zero', () => {
    const ledger = new SimulatedPeriodEnergy();
    ledger.hold([heldOff(6)], tracker(HOUR_12, {}));
    ledger.accrue(tracker(HOUR_12 + 30 * MIN, {}));
    const view = ledger.planningView(tracker(HOUR_12 + 30 * MIN, { [key(HOUR_12)]: 1 }));
    expect(view.buckets?.[key(HOUR_12)]).toBe(0);
    const exporting = ledger.planningView(tracker(HOUR_12 + 30 * MIN, { [key(HOUR_12)]: -0.5 }));
    expect(exporting.buckets?.[key(HOUR_12)]).toBe(-0.5);
  });

  it('counts nothing for a device it keeps or one limited only by temperature', () => {
    const ledger = new SimulatedPeriodEnergy();
    ledger.hold([
      buildPlanDevice({ id: 'kept', currentDrawKw: 2 }),
      buildPlanDevice({ id: 'cooler', plannedState: 'shed', plannedShedTargetKind: 'target_value', currentDrawKw: 2 }),
    ], tracker(HOUR_12, {}));
    ledger.accrue(tracker(HOUR_12 + 30 * MIN, {}));
    const measured = tracker(HOUR_12 + 30 * MIN, { [key(HOUR_12)]: 3 });
    expect(ledger.planningView(measured).buckets?.[key(HOUR_12)]).toBe(3);
  });

  it('paces from the measured tracker again once cleared', () => {
    const ledger = new SimulatedPeriodEnergy();
    ledger.hold([heldOff(2)], tracker(HOUR_12, {}));
    ledger.accrue(tracker(HOUR_12 + 30 * MIN, {}));
    ledger.clear();
    const measured = tracker(HOUR_12 + 30 * MIN, { [key(HOUR_12)]: 3 });
    expect(ledger.planningView(measured)).toBe(measured);
  });
});
