import { recordPowerSample, type PowerTrackerState } from '../../lib/power/tracker';
import { createTrackerStore } from '../../lib/power/trackerStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';

const START = Date.UTC(2026, 8, 14, 10);
const HOUR = new Date(START).toISOString();
const HISTORY = new Date(START - 3600000).toISOString();

const sample = async (state: PowerTrackerState, nowMs = START + 10000): Promise<PowerTrackerState> => {
  let saved = state;
  await recordPowerSample({
    generationSegments: [],
    timeZone: 'UTC',
    state, nowMs, currentPowerW: 1000, controlledPowerW: 1000, exemptPowerW: 0, hourBudgetKWh: 5,
    currentDevicePowerWById: { active: 1000, idle: 0 },
    saveState: (next) => { saved = next; },
    rebuildPlanFromCache: async () => {},
  });
  return saved;
};

const history = (): PowerTrackerState => ({
  lastTimestamp: START, lastPowerW: 1000, lastControlledPowerW: 1000,
  lastUncontrolledPowerW: 0, lastExemptPowerW: 0,
  lastDevicePowerWById: { active: 1000, idle: 0, absent: 500 },
  buckets: { [HISTORY]: 2, [HOUR]: 1 },
  hourlySampleCounts: { [HOUR]: 1 }, hourlyBudgets: { [HOUR]: 5 },
  controlledBuckets: { [HOUR]: 1 }, uncontrolledBuckets: { [HOUR]: 0 }, exemptBuckets: { [HOUR]: 0 },
  generationBuckets: { [HISTORY]: 3 }, exportBuckets: { [HISTORY]: 1 },
  deviceBuckets: {
    active: { [HISTORY]: 2, [HOUR]: 1 }, idle: { [HOUR]: 0 }, absent: { [HISTORY]: 0.5 },
  },
});

describe('power sample history sharing', () => {
  it('reuses unchanged families and device histories, including idle and missing readings', async () => {
    const previous = history();
    const next = await sample(previous);
    expect(next.hourlyBudgets).toBe(previous.hourlyBudgets);
    expect(next.uncontrolledBuckets).toBe(previous.uncontrolledBuckets);
    expect(next.exemptBuckets).toBe(previous.exemptBuckets);
    expect(next.generationBuckets).toBe(previous.generationBuckets);
    expect(next.exportBuckets).toBe(previous.exportBuckets);
    expect(next.deviceBuckets?.idle).toBe(previous.deviceBuckets?.idle);
    expect(next.deviceBuckets?.absent).toBe(previous.deviceBuckets?.absent);
    expect(next.deviceBuckets?.active).not.toBe(previous.deviceBuckets?.active);
    expect(next.buckets?.[HOUR]).toBeCloseTo(1 + 1 / 360);
  });

  it('keeps prior snapshots intact through subsequent samples and SQLite diffed saves', async () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    try {
      const store = createTrackerStore(db);
      const previous = history();
      const original = structuredClone(previous);
      for (const family of Object.values(previous)) {
        if (family && typeof family === 'object') Object.freeze(family);
      }
      for (const buckets of Object.values(previous.deviceBuckets ?? {})) Object.freeze(buckets);
      Object.freeze(previous);
      store.save('main', previous);
      const next = await sample(previous);
      const nextCopy = structuredClone(next);
      store.save('main', next);
      const later = await sample(next, START + 20000);
      store.save('main', later);
      expect(previous).toEqual(original);
      expect(next).toEqual(nextCopy);
      const persisted = store.load('main');
      expect(persisted?.buckets?.[HOUR]).toBeCloseTo(1 + 2 / 360);
      expect(persisted?.deviceBuckets?.active[HOUR]).toBeCloseTo(1 + 2 / 360);
      expect(persisted?.hourlySampleCounts?.[HOUR]).toBe(3);
      expect(persisted?.deviceBuckets?.absent).toEqual(original.deviceBuckets?.absent);
    } finally {
      db.close();
    }
  });

  it('adds energy to both crossed hours while replacing budgets and counting only the sample hour', async () => {
    const nextHour = new Date(START + 3600000).toISOString();
    const previous = {
      ...history(), lastTimestamp: START + 50 * 60000,
      buckets: { [HOUR]: 1, [nextHour]: 2 },
      hourlyBudgets: { [HOUR]: 3, [nextHour]: 4 },
      hourlySampleCounts: { [HOUR]: 7, [nextHour]: 20 },
    };
    const next = await sample(previous, START + 70 * 60000);
    expect(next.buckets?.[HOUR]).toBeCloseTo(1 + 1 / 6);
    expect(next.buckets?.[nextHour]).toBeCloseTo(2 + 1 / 6);
    expect(next.hourlyBudgets).toEqual({ [HOUR]: 5, [nextHour]: 5 });
    expect(next.hourlySampleCounts).toEqual({ [HOUR]: 7, [nextHour]: 21 });
    expect(previous.buckets).toEqual({ [HOUR]: 1, [nextHour]: 2 });
    expect(previous.hourlyBudgets).toEqual({ [HOUR]: 3, [nextHour]: 4 });
    expect(previous.hourlySampleCounts).toEqual({ [HOUR]: 7, [nextHour]: 20 });
  });

  it('does not copy energy history when the timestamp repeats or sampling resets', async () => {
    for (const nowMs of [START, START - 1000, START + 49 * 3600000]) {
      const previous = history();
      const next = await sample(previous, nowMs);
      expect(next.buckets).toBe(previous.buckets);
      expect(next.controlledBuckets).toBe(previous.controlledBuckets);
      expect(next.deviceBuckets).toBe(previous.deviceBuckets);
      expect(next.generationBuckets).toBe(previous.generationBuckets);
    }
  });
});
