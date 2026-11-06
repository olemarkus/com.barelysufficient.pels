import { afterEach, describe, expect, it, vi } from 'vitest';
import { aggregateAndPruneHistory, recordPowerSample, type PowerTrackerState } from '../../lib/power/tracker';
import type { RecordPowerSampleParams } from '../../lib/power/trackerTypes';
import { createTrackerStore } from '../../lib/power/trackerStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';

const START = Date.UTC(2026, 10, 2, 21);
const HOUR = new Date(START).toISOString();
const NEXT_HOUR = new Date(START + 3600000).toISOString();

const sample = async (
  state: PowerTrackerState,
  nowMs: number,
  readings: Partial<RecordPowerSampleParams> = {},
): Promise<PowerTrackerState> => {
  let saved = state;
  await recordPowerSample({
    state,
    nowMs,
    currentPowerW: 4400,
    controlledPowerW: 1000,
    exemptPowerW: 3060,
    uncontrolledExemptPowerW: 3060,
    generationSegments: [],
    managedDraw: { totalW: 0, loadKey: 0 },
    timeZone: 'UTC',
    rebuildPlanFromCache: async () => {},
    saveState: (next) => { saved = next; },
    ...readings,
  });
  return saved;
};

afterEach(() => vi.useRealTimers());

describe('power tracker background exemption', () => {
  it('records an exempt background charger without moving its draw into controlled energy', async () => {
    const first = await sample({}, START);
    const state = await sample(first, START + 3600000);
    expect(state.buckets?.[HOUR]).toBeCloseTo(4.4);
    expect(state.controlledBuckets?.[HOUR]).toBeCloseTo(1);
    expect(state.uncontrolledBuckets?.[HOUR]).toBeCloseTo(3.4);
    expect(state.exemptBuckets?.[HOUR]).toBeCloseTo(3.06);
    expect(state.uncontrolledExemptBuckets?.[HOUR]).toBeCloseTo(3.06);
  });

  it('keeps a held exemption split through restart, then books its end across an hour boundary', async () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    try {
      const store = createTrackerStore(db);
      const first = await sample({}, START + 50 * 60000);
      store.save('main', first);
      const restored = store.load('main');
      expect(restored).not.toBeNull();
      if (!restored) throw new Error('Expected persisted sample');
      const ended = await sample(restored, START + 70 * 60000, {
        exemptPowerW: 0, uncontrolledExemptPowerW: 0,
      });
      const later = await sample(ended, START + 80 * 60000, {
        exemptPowerW: 0, uncontrolledExemptPowerW: 0,
      });
      expect(later.uncontrolledExemptBuckets?.[HOUR]).toBeCloseTo(0.51);
      expect(later.uncontrolledExemptBuckets?.[NEXT_HOUR]).toBeCloseTo(0.51);
      expect(later.exemptBuckets).toEqual(later.uncontrolledExemptBuckets);
      expect(later.lastUncontrolledExemptPowerW).toBe(0);
    } finally {
      db.close();
    }
  });

  it('interprets a legacy held exempt sample as managed-only without attributing it to background', async () => {
    const old: PowerTrackerState = {
      lastTimestamp: START,
      lastPowerW: 4400,
      lastControlledPowerW: 1000,
      lastUncontrolledPowerW: 3400,
      lastExemptPowerW: 500,
    };
    const next = await sample(old, START + 30 * 60000);
    expect(next.exemptBuckets?.[HOUR]).toBeCloseTo(0.25);
    expect(next.uncontrolledExemptBuckets?.[HOUR]).toBe(0);
    expect(next.lastUncontrolledExemptPowerW).toBe(3060);
  });

  it('bounds each exemption share by its gross draw while solar reduces net import', async () => {
    const next = await sample({}, START, {
      currentPowerW: 500,
      grossConsumptionW: 3000,
      controlledPowerW: 1000,
      exemptPowerW: 2800,
      uncontrolledExemptPowerW: 2500,
    });
    expect(next.lastUncontrolledExemptPowerW).toBe(2000);
    // The clipped 500 W background claim must not become a managed exemption.
    expect(next.lastExemptPowerW).toBe(2300);
    expect(next.lastControlledPowerW).toBe(1000);
    expect(next.lastUncontrolledPowerW).toBe(2000);
  });

  it('preserves managed exemption when the background device readings exceed the whole-home meter', async () => {
    const next = await sample({}, START, {
      currentPowerW: 4000,
      controlledPowerW: 1000,
      exemptPowerW: 5000,
      uncontrolledExemptPowerW: 4000,
    });
    expect(next.lastUncontrolledExemptPowerW).toBe(3000);
    expect(next.lastExemptPowerW).toBe(4000);
    expect(next.lastControlledPowerW).toBe(1000);
    expect(next.lastUncontrolledPowerW).toBe(3000);
  });

  it('folds the background exemption into daily history and prunes old hourly entries', async () => {
    const first = await sample({}, START);
    const state = await sample(first, START + 3600000);
    vi.useFakeTimers();
    vi.setSystemTime(START + 32 * 24 * 3600000);
    const pruned = aggregateAndPruneHistory(state, 'UTC');
    expect(pruned.uncontrolledExemptBuckets).toEqual({});
    expect(pruned.uncontrolledExemptDailyTotals?.['2026-11-02']).toBeCloseTo(3.06);
    expect(Object.values(pruned.uncontrolledExemptHourlyAverages ?? {})).toEqual([{ sum: 3.06, count: 1 }]);
  });

  it('resets the held exemption without charging a gap longer than the sampling horizon', async () => {
    const first = await sample({}, START);
    const next = await sample(first, START + 49 * 3600000);
    expect(next.uncontrolledExemptBuckets).toBeUndefined();
    expect(next.exemptBuckets).toEqual({});
    expect(next.lastUncontrolledExemptPowerW).toBe(3060);
  });
});
