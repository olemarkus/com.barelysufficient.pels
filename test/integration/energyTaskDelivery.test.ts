import { EnergyTaskDeliveryTracker } from '../../lib/objectives/deferredObjectives/energyDelivery';
import type { EnergyDeliveryStore } from '../../lib/objectives/deferredObjectives/energyDelivery';
import type {
  DeferredObjectiveSettingsEntry,
  DeferredObjectiveSettingsV1,
} from '../../packages/contracts/src/deferredObjectiveSettings';
import { createMemoryEnergyDeliveryStore, everyReadingLive } from '../helpers/deferredObjectiveWiringFixtures';

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const START_MS = Date.UTC(2026, 8, 28, 22, 0, 0);
const DEADLINE_MS = START_MS + 8 * HOUR_MS;

const energyTask = (overrides: Partial<DeferredObjectiveSettingsEntry> = {}): DeferredObjectiveSettingsEntry => ({
  enabled: true,
  kind: 'energy',
  enforcement: 'soft',
  targetEnergyKWh: 16,
  deadlineAtMs: DEADLINE_MS,
  ...overrides,
} as DeferredObjectiveSettingsEntry);

const settingsWith = (
  objectivesByDeviceId: Record<string, DeferredObjectiveSettingsEntry>,
): DeferredObjectiveSettingsV1 => ({ version: 1, objectivesByDeviceId });

const heater = (currentDrawKw: number) => ({ id: 'heater', currentDrawKw });

// The lifecycle clock ticks every 30 s; a minute is well inside the gap cap.
const tickEach = (
  tracker: EnergyTaskDeliveryTracker,
  settings: DeferredObjectiveSettingsV1,
  device: ReturnType<typeof heater> | null,
  fromMs: number,
  toMs: number,
): void => {
  for (let nowMs = fromMs; nowMs < toMs; nowMs += MIN_MS) {
    tracker.observe(device === null ? [] : [device], settings, nowMs);
  }
};

describe('EnergyTaskDeliveryTracker', () => {
  it('books the draw each tick saw over the time until the next tick', () => {
    const tracker = new EnergyTaskDeliveryTracker(createMemoryEnergyDeliveryStore(), everyReadingLive);
    const settings = settingsWith({ heater: energyTask() });

    tracker.observe([heater(2)], settings, START_MS);
    expect(tracker.getDeliveredKWh('heater', DEADLINE_MS)).toBe(0);

    tickEach(tracker, settings, heater(2), START_MS + MIN_MS, START_MS + HOUR_MS + MIN_MS);
    expect(tracker.getDeliveredKWh('heater', DEADLINE_MS)).toBeCloseTo(2);

    // The thermostat cut out: the 2 kW last seen holds until the first 0 kW
    // reading replaces it (one more minute), then nothing more is booked.
    tickEach(tracker, settings, heater(0), START_MS + HOUR_MS + MIN_MS, START_MS + 2 * HOUR_MS);
    expect(tracker.getDeliveredKWh('heater', DEADLINE_MS)).toBeCloseTo(2 + 2 / 60);
  });

  it('reports nothing delivered for a task it has not opened a run for', () => {
    const tracker = new EnergyTaskDeliveryTracker(createMemoryEnergyDeliveryStore(), everyReadingLive);
    expect(tracker.getDeliveredKWh('heater', DEADLINE_MS)).toBe(0);
  });

  it('keeps what was delivered when the owner changes the target for the same deadline', () => {
    const tracker = new EnergyTaskDeliveryTracker(createMemoryEnergyDeliveryStore(), everyReadingLive);
    tickEach(tracker, settingsWith({ heater: energyTask({ targetEnergyKWh: 16 }) }), heater(2), START_MS, START_MS + HOUR_MS);
    tickEach(
      tracker,
      settingsWith({ heater: energyTask({ targetEnergyKWh: 20 }) }),
      heater(2),
      START_MS + HOUR_MS,
      START_MS + 2 * HOUR_MS + MIN_MS,
    );
    expect(tracker.getDeliveredKWh('heater', DEADLINE_MS)).toBeCloseTo(4);
  });

  it('starts a new count for a new deadline and forgets the old run', () => {
    const store = createMemoryEnergyDeliveryStore();
    const tracker = new EnergyTaskDeliveryTracker(store, everyReadingLive);
    tickEach(tracker, settingsWith({ heater: energyTask() }), heater(2), START_MS, START_MS + HOUR_MS);

    const nextDeadline = DEADLINE_MS + 24 * HOUR_MS;
    const nextNight = START_MS + 24 * HOUR_MS;
    tracker.observe([heater(2)], settingsWith({ heater: energyTask({ deadlineAtMs: nextDeadline }) }), nextNight);

    expect(tracker.getDeliveredKWh('heater', nextDeadline)).toBe(0);
    expect(tracker.getDeliveredKWh('heater', DEADLINE_MS)).toBe(0);
    expect(store.rows()).toEqual([
      { deviceId: 'heater', deadlineAtMs: nextDeadline, startedAtMs: nextNight, deliveredKWh: 0 },
    ]);
  });

  it('books nothing past the deadline', () => {
    const tracker = new EnergyTaskDeliveryTracker(createMemoryEnergyDeliveryStore(), everyReadingLive);
    const settings = settingsWith({ heater: energyTask() });
    tickEach(tracker, settings, heater(2), DEADLINE_MS - 30 * MIN_MS, DEADLINE_MS + 30 * MIN_MS);
    expect(tracker.getDeliveredKWh('heater', DEADLINE_MS)).toBeCloseTo(1);
  });

  it('counts only energy tasks, and only enabled ones', () => {
    const tracker = new EnergyTaskDeliveryTracker(createMemoryEnergyDeliveryStore(), everyReadingLive);
    const settings = settingsWith({
      heater: energyTask({ enabled: false }),
      boiler: {
        enabled: true, kind: 'temperature', enforcement: 'soft', targetTemperatureC: 65, deadlineAtMs: DEADLINE_MS,
      },
    });
    const boiler = { id: 'boiler', currentDrawKw: 2 };
    for (let nowMs = START_MS; nowMs < START_MS + HOUR_MS; nowMs += MIN_MS) {
      tracker.observe([heater(2), boiler], settings, nowMs);
    }
    expect(tracker.getDeliveredKWh('heater', DEADLINE_MS)).toBe(0);
    expect(tracker.getDeliveredKWh('boiler', DEADLINE_MS)).toBe(0);
  });

  it('books a departing device only up to the tick it went missing, and re-anchors on return', () => {
    const tracker = new EnergyTaskDeliveryTracker(createMemoryEnergyDeliveryStore(), everyReadingLive);
    const settings = settingsWith({ heater: energyTask() });
    tracker.observe([heater(2)], settings, START_MS);
    // Missing from the roster (no power reading): the minute up to that tick is
    // booked, nothing while it is gone.
    tickEach(tracker, settings, null, START_MS + MIN_MS, START_MS + HOUR_MS);
    tickEach(tracker, settings, heater(2), START_MS + HOUR_MS, START_MS + 2 * HOUR_MS + MIN_MS);
    expect(tracker.getDeliveredKWh('heater', DEADLINE_MS)).toBeCloseTo(2 + 2 / 60);
  });

  it('books nothing from a reading that is not a live measurement, and re-anchors on the next live one', () => {
    let live = true;
    const tracker = new EnergyTaskDeliveryTracker(createMemoryEnergyDeliveryStore(), () => live);
    const settings = settingsWith({ heater: energyTask() });
    tracker.observe([heater(2)], settings, START_MS);
    // The relay's own reading went away and the power figure is now a rate
    // derived from its cumulative meter, which lingers after it switches off.
    live = false;
    tickEach(tracker, settings, heater(2), START_MS + MIN_MS, START_MS + HOUR_MS);
    expect(tracker.getDeliveredKWh('heater', DEADLINE_MS)).toBe(0);
    live = true;
    tickEach(tracker, settings, heater(2), START_MS + HOUR_MS, START_MS + 2 * HOUR_MS + MIN_MS);
    expect(tracker.getDeliveredKWh('heater', DEADLINE_MS)).toBeCloseTo(2);
  });

  it('keeps a run whose task is missing from one roster read, and resumes counting it', () => {
    const store = createMemoryEnergyDeliveryStore();
    const tracker = new EnergyTaskDeliveryTracker(store, everyReadingLive);
    const settings = settingsWith({ heater: energyTask() });
    tickEach(tracker, settings, heater(2), START_MS, START_MS + HOUR_MS + MIN_MS);
    expect(tracker.getDeliveredKWh('heater', DEADLINE_MS)).toBeCloseTo(2);
    // A settings read that came back without the objective keys: the task is
    // not on this tick's roster. Its count is kept, not restarted at 0; the run
    // books nothing while its task is missing.
    tracker.observe([heater(2)], settingsWith({}), START_MS + HOUR_MS + 2 * MIN_MS);
    expect(tracker.getDeliveredKWh('heater', DEADLINE_MS)).toBeCloseTo(2);
    expect(store.rows()).toHaveLength(1);
    // Back on the roster: counting resumes from the next tick (63 → 120 min).
    tickEach(tracker, settings, heater(2), START_MS + HOUR_MS + 3 * MIN_MS, START_MS + 2 * HOUR_MS + MIN_MS);
    expect(tracker.getDeliveredKWh('heater', DEADLINE_MS)).toBeCloseTo(2 + 2 * (57 / 60));
  });

  it('bridges a gap between ticks with the level seen before it, however long', () => {
    const tracker = new EnergyTaskDeliveryTracker(createMemoryEnergyDeliveryStore(), everyReadingLive);
    const settings = settingsWith({ heater: energyTask() });
    tracker.observe([heater(2)], settings, START_MS);
    // A stalled clock: the next tick lands two hours later. A watt reading holds
    // until the next report replaces it, so the 2 kW ran for those two hours.
    tracker.observe([heater(2)], settings, START_MS + 2 * HOUR_MS);
    expect(tracker.getDeliveredKWh('heater', DEADLINE_MS)).toBeCloseTo(4);
  });

  it('carries a run across a restart without booking the downtime', () => {
    const store = createMemoryEnergyDeliveryStore();
    const first = new EnergyTaskDeliveryTracker(store, everyReadingLive);
    const settings = settingsWith({ heater: energyTask() });
    tickEach(first, settings, heater(2), START_MS, START_MS + HOUR_MS + MIN_MS);
    first.flushIfDirty();

    const second = new EnergyTaskDeliveryTracker(store, everyReadingLive);
    // Down for two hours; the first tick back re-anchors.
    tickEach(second, settings, heater(2), START_MS + 3 * HOUR_MS, START_MS + 4 * HOUR_MS + MIN_MS);
    expect(second.getDeliveredKWh('heater', DEADLINE_MS)).toBeCloseTo(4);
  });

  it('answers from the stored runs before its first tick after a restart', () => {
    const store = createMemoryEnergyDeliveryStore([
      { deviceId: 'heater', deadlineAtMs: DEADLINE_MS, startedAtMs: START_MS, deliveredKWh: 5 },
    ]);
    expect(new EnergyTaskDeliveryTracker(store, everyReadingLive).getDeliveredKWh('heater', DEADLINE_MS)).toBe(5);
  });

  it('writes when a run opens or closes, and otherwise at most every five minutes', () => {
    const backing = createMemoryEnergyDeliveryStore();
    const writes: number[] = [];
    const store: EnergyDeliveryStore = {
      read: () => backing.read(),
      write: (runs) => {
        writes.push(runs.length);
        backing.write(runs);
      },
    };
    const tracker = new EnergyTaskDeliveryTracker(store, everyReadingLive);
    const settings = settingsWith({ heater: energyTask() });
    tickEach(tracker, settings, heater(2), START_MS, START_MS + 20 * MIN_MS);
    // Opened at the first tick, then every five minutes of booking.
    expect(writes).toEqual([1, 1, 1, 1]);

    // The task is gone and its deadline has passed: the run closes.
    tracker.observe([heater(2)], settingsWith({}), DEADLINE_MS);
    expect(writes).toEqual([1, 1, 1, 1, 0]);
  });

  it('keeps persistence closed while the store cannot be read, then adds what it held', () => {
    const backing = createMemoryEnergyDeliveryStore([
      { deviceId: 'heater', deadlineAtMs: DEADLINE_MS, startedAtMs: START_MS - HOUR_MS, deliveredKWh: 5 },
    ]);
    let readable = false;
    let reads = 0;
    const writes: number[] = [];
    const store: EnergyDeliveryStore = {
      read: () => {
        reads += 1;
        if (!readable) throw new Error('disk busy');
        return backing.read();
      },
      write: (runs) => {
        writes.push(runs.length);
        backing.write(runs);
      },
    };
    const tracker = new EnergyTaskDeliveryTracker(store, everyReadingLive);
    const settings = settingsWith({ heater: energyTask() });

    tickEach(tracker, settings, heater(2), START_MS, START_MS + HOUR_MS + MIN_MS);
    expect(writes).toEqual([]);
    // Plan-cycle reads between ticks do not hammer an unreadable store.
    const readsBefore = reads;
    tracker.getDeliveredKWh('heater', DEADLINE_MS);
    tracker.getDeliveredKWh('heater', DEADLINE_MS);
    expect(reads).toBe(readsBefore);

    readable = true;
    tracker.observe([heater(2)], settings, START_MS + HOUR_MS + 2 * MIN_MS);
    // The stored run counted the night before this process started (5 kWh); the
    // one booked in memory counted it since (2 kWh, then the two minutes to this tick).
    expect(tracker.getDeliveredKWh('heater', DEADLINE_MS)).toBeCloseTo(5 + 2 + 4 / 60);
    expect(writes.length).toBe(1);
  });
});
