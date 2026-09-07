import {
  beginTrackerFreshnessReset,
  prepareTrackerForMeter,
  type TrackerFreshnessFailure,
} from '../../lib/power/trackerMeterIdentity';
import { createTrackerStore } from '../../lib/power/trackerStore';
import type { PowerTrackerMeterIdentity, PowerTrackerState } from '../../lib/power/trackerTypes';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';

const METER_A: PowerTrackerMeterIdentity = { powerSource: 'homey_energy', meterDeviceId: 'meter-a' };
const METER_B: PowerTrackerMeterIdentity = { powerSource: 'homey_energy', meterDeviceId: 'meter-b' };
const HISTORY: PowerTrackerState = {
  meterIdentity: METER_A,
  lastTimestamp: 1_700_000_000_000,
  lastPowerW: 2_400,
  buckets: { '2026-01-15T12': 2.5 },
  dailyTotals: { '2026-01-14': 7.25 },
};
const withoutFreshness = (state: PowerTrackerState, meterIdentity = state.meterIdentity): PowerTrackerState => ({
  ...state, meterIdentity, lastTimestamp: undefined, lastPowerW: undefined,
});

const open = () => createTrackerStore(openUserdataDatabase(IN_MEMORY_DATABASE));

describe('prepareTrackerForMeter', () => {
  it('starts an area the store holds nothing for with its identity in memory, writing nothing', () => {
    const store = open();
    const save = vi.spyOn(store, 'save');
    expect(prepareTrackerForMeter(store, 'h_a', METER_A, () => { throw new Error('unexpected'); }))
      .toEqual({ ok: true, state: { meterIdentity: METER_A } });
    expect(save).not.toHaveBeenCalled();
    expect(store.load('h_a')).toBeNull();
  });

  it('keeps the freshness of a stored tracker bound to the same meter', () => {
    const store = open();
    store.save('h_a', HISTORY);
    expect(prepareTrackerForMeter(store, 'h_a', METER_A, () => { throw new Error('unexpected'); }))
      .toEqual({ ok: true, state: HISTORY });
  });

  it('rebinds a tracker recorded against another meter: identity adopted, freshness cleared, accounting kept, persisted', () => {
    const store = open();
    store.save('h_a', HISTORY);
    const prepared = prepareTrackerForMeter(store, 'h_a', METER_B, () => { throw new Error('unexpected'); });
    expect(prepared).toEqual({ ok: true, state: withoutFreshness(HISTORY, METER_B) });
    expect(store.load('h_a')).toEqual(withoutFreshness(HISTORY, METER_B));
  });

  it('answers not-ok, with the cause, when the store cannot be read or the rebind cannot be written', () => {
    const store = open();
    store.save('h_a', HISTORY);
    const failures: Error[] = [];
    vi.spyOn(store, 'save').mockImplementation(() => { throw new Error('disk full'); });
    expect(prepareTrackerForMeter(store, 'h_a', METER_B, (error) => failures.push(error))).toEqual({ ok: false });
    vi.spyOn(store, 'load').mockImplementation(() => { throw new Error('disk gone'); });
    expect(prepareTrackerForMeter(store, 'h_a', METER_B, (error) => failures.push(error))).toEqual({ ok: false });
    expect(failures.map((error) => (error.cause as Error).message)).toEqual(['disk full', 'disk gone']);
  });
});

describe('beginTrackerFreshnessReset', () => {
  it('clears the latch, keeps the accounting, and rolls back to the state before', () => {
    const store = open();
    store.save('h_a', HISTORY);
    const reset = beginTrackerFreshnessReset(store, 'h_a', undefined, () => { throw new Error('unexpected'); });
    expect(reset.state).toBe('prepared');
    expect(store.load('h_a')).toEqual(withoutFreshness(HISTORY));
    expect(reset.state === 'prepared' && reset.rollback()).toBe(true);
    expect(store.load('h_a')).toEqual(HISTORY);
  });

  it('stamps a new identity with the reset when given one', () => {
    const store = open();
    store.save('h_a', HISTORY);
    beginTrackerFreshnessReset(store, 'h_a', METER_B, () => { throw new Error('unexpected'); });
    expect(store.load('h_a')).toEqual(withoutFreshness(HISTORY, METER_B));
  });

  it('is prepared with a no-op rollback for a home the store holds nothing for', () => {
    const store = open();
    const save = vi.spyOn(store, 'save');
    const reset = beginTrackerFreshnessReset(store, 'h_a', undefined, () => { throw new Error('unexpected'); });
    expect(reset.state === 'prepared' && reset.rollback()).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('names the phase that failed: read, reset, or restore', () => {
    const failures: TrackerFreshnessFailure[] = [];
    const onFailure = (failure: TrackerFreshnessFailure) => { failures.push(failure); };

    const unreadable = open();
    vi.spyOn(unreadable, 'load').mockImplementation(() => { throw new Error('disk gone'); });
    expect(beginTrackerFreshnessReset(unreadable, 'h_a', undefined, onFailure)).toEqual({ state: 'unavailable' });

    const unwritable = open();
    unwritable.save('h_a', HISTORY);
    const save = vi.spyOn(unwritable, 'save').mockImplementation(() => { throw new Error('disk full'); });
    expect(beginTrackerFreshnessReset(unwritable, 'h_a', undefined, onFailure)).toEqual({ state: 'unavailable' });
    // A reset that threw inside its transaction left the rows as they were.
    save.mockRestore();
    expect(unwritable.load('h_a')).toEqual(HISTORY);

    const reset = beginTrackerFreshnessReset(unwritable, 'h_a', undefined, onFailure);
    vi.spyOn(unwritable, 'save').mockImplementation(() => { throw new Error('disk full again'); });
    expect(reset.state === 'prepared' && reset.rollback()).toBe(false);

    expect(failures.map((failure) => [failure.phase, failure.homeId, (failure.error.cause as Error).message])).toEqual([
      ['tracker_read', 'h_a', 'disk gone'],
      ['tracker_reset', 'h_a', 'disk full'],
      ['tracker_restore', 'h_a', 'disk full again'],
    ]);
  });
});
