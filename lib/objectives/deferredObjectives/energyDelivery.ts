/**
 * The energy each device has taken under its energy smart task, since the task
 * started — the progress an `energy` task is measured by.
 *
 * An energy task ("feed the water heater 16 kWh by 06:00") has no level of the
 * device's own to read: the device it exists for is a relay-switched water
 * heater with neither a temperature nor a battery level. Its progress is the
 * energy PELS has seen it draw, so something has to count that energy, and has
 * to keep counting it across ticks and restarts. That is this tracker.
 *
 * One run per task, keyed by device and deadline. The key is the task's
 * identity for delivery on purpose: an owner who edits "16 kWh" to "20 kWh" for
 * the same deadline has not started a new night, and the energy already fed
 * counts toward the new target. A new deadline is a new run. A run is kept
 * until its deadline has passed and its task is gone, so a task missing from
 * one roster read keeps its count rather than restarting at 0. (Plan history
 * deliberately splits a same-deadline target edit into two entries, each judged
 * against a stable target; that is why its own delivery sum is not the progress
 * source — it resets at the edit.)
 *
 * The draw is booked the way plan history books it: a watt reading is a level
 * that holds until the next report replaces it, so the draw seen on the previous
 * tick is what ran between that tick and this one, however long the gap,
 * clipped to the run's `[startedAtMs, deadlineAtMs]` window. A tick where the
 * device is missing books up to that tick and nothing after it: a device that
 * left the objective roster (no power reading, unmanaged, removed) says nothing
 * about what it drew since.
 *
 * Two things are not readings of the level, and book nothing, because counting
 * energy a device never took makes the task stop asking for energy it still
 * needs:
 * - a draw that is not a live measurement (the observer's
 *   `isLiveMeasuredDraw`): a rate the device layer derived from a cumulative
 *   meter lingers after the device stops. The gate that lets an energy task be
 *   created asks the same question (`supportsSmartTaskKind`); asking it again
 *   here covers a device whose live reading goes away mid-run. The stretch
 *   ending at that tick is dropped and the count re-anchors on the next live
 *   reading;
 * - the downtime across a restart: the anchor is in memory only, so the draw
 *   last seen before the app stopped is not booked over the time it was down.
 *
 * The store is written when a run opens or closes, and otherwise at most every
 * `PERSIST_INTERVAL_MS` while energy is booked: a crash loses at most a few
 * minutes of count, and a smaller count only asks for more energy.
 *
 * Runs on the lifecycle clock only (`lifecycleEmitter.ts`), so there is one
 * booking clock; the decoration and preview paths read the result.
 */
import type { DeferredObjectiveSettingsV1 } from '../../../packages/contracts/src/deferredObjectiveSettings';
import type { DeliveredEnergyReader } from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import { getLogger } from '../../logging/logger';
import { normalizeError } from '../../utils/errorUtils';

const logger = getLogger('deferred-objectives/energy-delivery');

const ONE_HOUR_MS = 60 * 60 * 1000;
const PERSIST_INTERVAL_MS = 5 * 60 * 1000;

export type EnergyDeliveryRun = {
  deviceId: string;
  deadlineAtMs: number;
  startedAtMs: number;
  deliveredKWh: number;
};

/** The runs' rows in the userdata database. Both calls throw only on I/O. */
export type EnergyDeliveryStore = {
  read(): EnergyDeliveryRun[];
  write(runs: readonly EnergyDeliveryRun[]): void;
};

/** A device's measured draw on this tick, as the objective roster carries it. */
export type EnergyDeliveryDevice = {
  id: string;
  currentDrawKw: number;
};

/** The observer's answer to "is this device's power reading a live measurement". */
export type LiveMeasuredDrawReader = (deviceId: string) => boolean;

export type { DeliveredEnergyReader };

type DrawTick = { atMs: number; drawKw: number };

const runKey = (deviceId: string, deadlineAtMs: number): string => `${deviceId}|${deadlineAtMs}`;

export class EnergyTaskDeliveryTracker {
  private runs = new Map<string, EnergyDeliveryRun>();

  // Per device, in memory only: the anchor for the next booking. Never
  // persisted, so a restart re-anchors instead of booking the downtime.
  private lastDrawByDeviceId = new Map<string, DrawTick>();

  private loaded = false;

  // One load attempt per lifecycle tick while the store is unreadable, and one
  // warning per outage: readers call `loadIfNeeded` on every plan cycle.
  private loadAttemptedThisTick = false;

  private loadFailureLogged = false;

  // One error per write outage: a failed write is retried every tick.
  private persistFailureLogged = false;

  private dirty = false;

  // A run opened or closed: written on this tick, not on the interval.
  private runsChanged = false;

  private lastPersistAtMs: number | null = null;

  constructor(
    private readonly store: EnergyDeliveryStore,
    private readonly isLiveMeasuredDraw: LiveMeasuredDrawReader,
  ) {}

  /**
   * Energy fed so far. A task with no run yet has fed nothing: it was created
   * after the last tick, and the next tick opens its run at 0.
   *
   * Loads the stored runs first: the plan cycle and the settings UI can read
   * before the lifecycle clock's first tick after a restart, and reading an
   * unloaded tracker as "nothing fed" would re-feed a night's energy.
   */
  readonly getDeliveredKWh: DeliveredEnergyReader = (deviceId, deadlineAtMs) => {
    this.loadIfNeeded();
    return this.runs.get(runKey(deviceId, deadlineAtMs))?.deliveredKWh ?? 0;
  };

  observe(
    devices: readonly EnergyDeliveryDevice[],
    settings: DeferredObjectiveSettingsV1,
    nowMs: number,
  ): void {
    this.loadAttemptedThisTick = false;
    this.loadIfNeeded();
    const activeKeys = this.openRuns(settings, nowMs);
    this.bookDraw(devices, activeKeys, nowMs);
    this.dropEndedRuns(activeKeys, nowMs);
    if (this.runsChanged || this.lastPersistAtMs === null || nowMs - this.lastPersistAtMs >= PERSIST_INTERVAL_MS) {
      if (this.flushIfDirty()) this.lastPersistAtMs = nowMs;
    }
  }

  /** Write what changed now. Returns whether the store holds the current runs. */
  flushIfDirty(): boolean {
    // Until the stored runs have been read, a write would replace them with an
    // empty or partial set — the restart that most needs them is the one that
    // would lose them. Persistence stays closed until a read succeeds.
    if (!this.loaded) return false;
    if (!this.dirty) return true;
    try {
      this.store.write([...this.runs.values()]);
      this.dirty = false;
      this.runsChanged = false;
      if (this.persistFailureLogged) {
        logger.info({ event: 'energy_task_delivery_persist_recovered' });
        this.persistFailureLogged = false;
      }
      return true;
    } catch (error) {
      if (!this.persistFailureLogged) {
        logger.error({ event: 'energy_task_delivery_persist_failed', err: normalizeError(error) });
        this.persistFailureLogged = true;
      }
      return false;
    }
  }

  private loadIfNeeded(): void {
    if (this.loaded || this.loadAttemptedThisTick) return;
    this.loadAttemptedThisTick = true;
    let stored: EnergyDeliveryRun[];
    try {
      stored = this.store.read();
    } catch (error) {
      if (!this.loadFailureLogged) {
        logger.warn({ event: 'energy_task_delivery_load_unavailable', err: normalizeError(error) });
        this.loadFailureLogged = true;
      }
      return;
    }
    if (this.loadFailureLogged) {
      logger.info({ event: 'energy_task_delivery_load_recovered' });
      this.loadFailureLogged = false;
    }
    // A run booked in memory while the store was unreadable was opened after
    // this process started, so it counted only energy since then; the stored
    // copy counted only energy before. Both are real and they do not overlap.
    for (const run of stored) {
      const key = runKey(run.deviceId, run.deadlineAtMs);
      const held = this.runs.get(key);
      this.runs.set(key, held === undefined ? run : {
        deviceId: run.deviceId,
        deadlineAtMs: run.deadlineAtMs,
        startedAtMs: Math.min(run.startedAtMs, held.startedAtMs),
        deliveredKWh: run.deliveredKWh + held.deliveredKWh,
      });
      if (held !== undefined) {
        this.dirty = true;
        this.runsChanged = true;
      }
    }
    this.loaded = true;
  }

  private openRuns(settings: DeferredObjectiveSettingsV1, nowMs: number): Set<string> {
    const activeKeys = new Set<string>();
    for (const [deviceId, objective] of Object.entries(settings.objectivesByDeviceId)) {
      if (!objective.enabled || objective.kind !== 'energy') continue;
      const key = runKey(deviceId, objective.deadlineAtMs);
      activeKeys.add(key);
      if (this.runs.has(key)) continue;
      this.runs.set(key, { deviceId, deadlineAtMs: objective.deadlineAtMs, startedAtMs: nowMs, deliveredKWh: 0 });
      this.dirty = true;
      this.runsChanged = true;
      logger.info({
        event: 'energy_task_delivery_run_opened',
        deviceId,
        deadlineAtMs: objective.deadlineAtMs,
        targetEnergyKWh: objective.targetEnergyKWh,
      });
    }
    return activeKeys;
  }

  // A run ends when its deadline has passed and its task is gone. A task
  // missing from one roster read (a settings read that came back without the
  // objective keys) keeps its run: dropping it would restart the count at 0 on
  // the next good read and re-feed energy already delivered. A task removed
  // for good leaves its run until the deadline, which a task re-created for
  // the same deadline then resumes.
  private dropEndedRuns(activeKeys: ReadonlySet<string>, nowMs: number): void {
    for (const [key, run] of this.runs) {
      if (activeKeys.has(key) || run.deadlineAtMs > nowMs) continue;
      this.runs.delete(key);
      this.dirty = true;
      this.runsChanged = true;
      logger.info({
        event: 'energy_task_delivery_run_closed',
        deviceId: run.deviceId,
        deadlineAtMs: run.deadlineAtMs,
        deliveredKWh: run.deliveredKWh,
      });
    }
  }

  // Books only into runs whose task is on this tick's roster: a run kept for a
  // task that is missing is not counting, and resumes when the task is back.
  private bookDraw(devices: readonly EnergyDeliveryDevice[], activeKeys: ReadonlySet<string>, nowMs: number): void {
    const deviceIdsWithRuns = new Set(
      [...this.runs].filter(([key]) => activeKeys.has(key)).map(([, run]) => run.deviceId),
    );
    const seen = new Set<string>();
    for (const device of devices) {
      if (!deviceIdsWithRuns.has(device.id)) continue;
      seen.add(device.id);
      if (!this.isLiveMeasuredDraw(device.id)) {
        // Not a reading of the level: book nothing and re-anchor on the next
        // live one.
        this.lastDrawByDeviceId.delete(device.id);
        continue;
      }
      const previous = this.lastDrawByDeviceId.get(device.id);
      if (previous !== undefined) this.bookHeldDraw(device.id, previous, activeKeys, nowMs);
      this.lastDrawByDeviceId.set(device.id, { atMs: nowMs, drawKw: device.currentDrawKw });
    }
    for (const [deviceId, previous] of this.lastDrawByDeviceId) {
      if (seen.has(deviceId)) continue;
      if (deviceIdsWithRuns.has(deviceId)) this.bookHeldDraw(deviceId, previous, activeKeys, nowMs);
      this.lastDrawByDeviceId.delete(deviceId);
    }
  }

  private bookHeldDraw(deviceId: string, from: DrawTick, activeKeys: ReadonlySet<string>, toMs: number): void {
    if (from.drawKw <= 0) return;
    for (const [key, run] of this.runs) {
      if (run.deviceId !== deviceId || !activeKeys.has(key)) continue;
      const startMs = Math.max(from.atMs, run.startedAtMs);
      const endMs = Math.min(toMs, run.deadlineAtMs);
      if (endMs <= startMs) continue;
      this.runs.set(key, {
        deviceId: run.deviceId,
        deadlineAtMs: run.deadlineAtMs,
        startedAtMs: run.startedAtMs,
        deliveredKWh: run.deliveredKWh + from.drawKw * ((endMs - startMs) / ONE_HOUR_MS),
      });
      this.dirty = true;
    }
  }
}
