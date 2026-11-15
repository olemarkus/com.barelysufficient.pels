import { describe, expect, it } from 'vitest';
import { SimulatedPeriodEnergy } from '../../lib/plan/simulatedPeriodEnergy';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { buildPlanDevice } from '../utils/planTestUtils';
import { NO_STORAGE_RELIEF } from '../../lib/plan/battery/storageRelief';
import type { StorageRelief, StorageStateSummary } from '../../lib/plan/battery/storageReliefTypes';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import { partialDouble } from '../helpers/partialDouble';

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
    ledger.hold([heldOff(2)], NO_STORAGE_RELIEF, [], tracker(HOUR_12 + 50 * MIN, {}));
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
    ledger.hold([heldOff(3)], NO_STORAGE_RELIEF, [], tracker(HOUR_12, {}));
    ledger.accrue(tracker(HOUR_12, {}));
    ledger.accrue(tracker(HOUR_12 + 6 * MIN, {}));
    ledger.accrue(tracker(HOUR_12 + 6 * MIN, {}));
    const view = ledger.planningView(tracker(HOUR_12 + 6 * MIN, { [key(HOUR_12)]: 2 }));
    expect(view.buckets?.[key(HOUR_12)]).toBeCloseTo(2 - 0.3);
  });

  it('leaves an exporting hour as measured and never takes an hour below zero', () => {
    const ledger = new SimulatedPeriodEnergy();
    ledger.hold([heldOff(6)], NO_STORAGE_RELIEF, [], tracker(HOUR_12, {}));
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
    ], NO_STORAGE_RELIEF, [], tracker(HOUR_12, {}));
    ledger.accrue(tracker(HOUR_12 + 30 * MIN, {}));
    const measured = tracker(HOUR_12 + 30 * MIN, { [key(HOUR_12)]: 3 });
    expect(ledger.planningView(measured).buckets?.[key(HOUR_12)]).toBe(3);
  });

  it('takes a budget-exempt device\'s relief off the exempt energy too, so the budget counts it once', () => {
    const ledger = new SimulatedPeriodEnergy();
    ledger.hold([buildPlanDevice({
      id: 'exempt', plannedState: 'shed', plannedShedTargetKind: 'binary_off', currentDrawKw: 2, budgetExempt: true,
    })], NO_STORAGE_RELIEF, [], tracker(HOUR_12, {}));
    ledger.accrue(tracker(HOUR_12 + 30 * MIN, {}));
    const view = ledger.planningView({
      ...tracker(HOUR_12 + 30 * MIN, { [key(HOUR_12)]: 3 }),
      exemptBuckets: { [key(HOUR_12)]: 1.5 },
    } as PowerTrackerState);
    expect(view.buckets?.[key(HOUR_12)]).toBeCloseTo(2);
    expect(view.exemptBuckets?.[key(HOUR_12)]).toBeCloseTo(0.5);
  });

  it('counts what a held battery would take off the import: more discharge, or less charge', () => {
    const held = (deviceId: string, setpointW: number) => partialDouble<StorageStateSummary>({
      deviceId, setpointW, decision: { kind: 'setpoint', setpointW, stepW: 5 },
    });
    const storage: StorageRelief = { ...NO_STORAGE_RELIEF, batteries: [held('idle', -1500), held('charging', 0)] };
    const observed = (id: string, signedPowerW: number) => partialDouble<PlanInputDevice>({
      id, storage: { reading: 'observed', signedPowerW },
    } as Partial<PlanInputDevice>);
    const ledger = new SimulatedPeriodEnergy();
    ledger.hold([], storage, [observed('idle', 0), observed('charging', 1000)], tracker(HOUR_12, {}));
    ledger.accrue(tracker(HOUR_12 + 30 * MIN, {}));
    const view = ledger.planningView(tracker(HOUR_12 + 30 * MIN, { [key(HOUR_12)]: 3 }));
    expect(view.buckets?.[key(HOUR_12)]).toBeCloseTo(3 - (1.5 + 1) * 0.5);
  });

  it('counts the import a held battery would add, as planned grid charging does', () => {
    const storage: StorageRelief = { ...NO_STORAGE_RELIEF, batteries: [partialDouble<StorageStateSummary>({
      deviceId: 'buying', setpointW: 2000, decision: { kind: 'setpoint', setpointW: 2000, stepW: 5 },
    })] };
    const idle = partialDouble<PlanInputDevice>({ id: 'buying', storage: { reading: 'observed', signedPowerW: 0 } } as Partial<PlanInputDevice>);
    const ledger = new SimulatedPeriodEnergy();
    ledger.hold([], storage, [idle], tracker(HOUR_12, {}));
    expect(ledger.heldReliefKw()).toBeCloseTo(-2);
    ledger.accrue(tracker(HOUR_12 + 30 * MIN, {}));
    expect(ledger.planningView(tracker(HOUR_12 + 30 * MIN, { [key(HOUR_12)]: 3 })).buckets?.[key(HOUR_12)])
      .toBeCloseTo(4);
  });

  it('paces from the measured tracker again once simulation ends', () => {
    const ledger = new SimulatedPeriodEnergy();
    ledger.hold([heldOff(2)], NO_STORAGE_RELIEF, [], tracker(HOUR_12, {}));
    ledger.accrue(tracker(HOUR_12 + 30 * MIN, {}));
    expect(ledger.endSimulation()).toBe(true);
    const measured = tracker(HOUR_12 + 30 * MIN, { [key(HOUR_12)]: 3 });
    expect(ledger.planningView(measured)).toBe(measured);
  });
});
