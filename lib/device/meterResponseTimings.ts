/**
 * The app's record of how long each device's lone switch-ons and switch-offs
 * take to show on the home meter (`meterResponseCapture.ts` holds the rules),
 * and the summary a diagnostics report lists.
 *
 * Every device write is reported here (`lib/actuator/commandWitness.ts`), and
 * Main's whole-home readings with its devices. Capture only: nothing reads this
 * back into a plan, pacing, cooldown or shed decision.
 *
 * Kept per device for {@link TIMING_WINDOW_MS}, the newest
 * {@link MAX_ENTRIES_PER_KIND} timed and as many "no change" entries per
 * direction. Unrelated load can still slip past the capture's rules, so a
 * single time proves little: a direction's time is trusted only once
 * {@link MIN_AGREEING_TIMES} times agree.
 */
import type { ActuatorOutcome, DeviceCommand } from '../actuator/deviceCommand';
import type { DeviceCommandWitness } from '../actuator/commandWitness';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import type { WholeHomePowerObservation } from '../ports/homeMeterReadings';
import { getDebugEmitter, getLogger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';
import type { UserdataDatabase } from '../store/userdataDatabase';
import {
  MeterResponseCapture,
  type MeterResponseDirection,
  type MeterResponseOutcome,
} from './meterResponseCapture';
import {
  createMeterResponseTimingRepository,
  type MeterResponseEntriesByDeviceId,
  type MeterResponseEntry,
  type MeterResponseTimingRepository,
} from './meterResponseTimingStore';

const logger = getLogger('device/meter-response');
const emitDebug = getDebugEmitter('device/meter-response', 'devices');

/** How long an entry counts. */
export const TIMING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** The newest entries kept per device, direction and outcome. */
export const MAX_ENTRIES_PER_KIND = 12;
/** Times that must agree before a direction's time is trusted. */
export const MIN_AGREEING_TIMES = 5;
/** Times agree when they lie within 15 % either side of one value, plus one meter interval. */
const AGREEING_TIME_SPAN = 1.15 / 0.85;

/** One device's times in one direction, as a diagnostics report lists them. */
export type MeterResponseTimingSummary = {
  deviceId: string;
  deviceName: string;
  direction: MeterResponseDirection;
  /** Timed samples kept. */
  samples: number;
  medianResponseMs: number | null;
  /** The largest group of samples that agree, and its median. */
  agreeing: number;
  agreedResponseMs: number | null;
  /** At least {@link MIN_AGREEING_TIMES} samples agree. */
  trusted: boolean;
  /**
   * Watched commands the device's own reading shows it followed, while the
   * home meter showed no matching change within the window.
   */
  noChange: number;
  /** The median meter interval of the samples: no time is more precise than this. */
  medianResolutionMs: number | null;
  /** The median time Homey took to accept the write, of the samples where it did; not part of the response time. */
  medianAcceptedAfterMs: number | null;
};

type TimedEntry = Extract<MeterResponseEntry, { outcome: 'timed' }>;

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.slice(Math.floor((sorted.length - 1) / 2), Math.floor(sorted.length / 2) + 1);
  return Math.round(middle.reduce((sum, value) => sum + value, 0) / middle.length);
};

/** The largest group of times within the agreeing span of its lowest; of two the same size, the earlier. */
const resolveAgreeingTimes = (timed: readonly TimedEntry[]): readonly number[] => {
  const slackMs = median(timed.map((entry) => entry.resolutionMs)) ?? 0;
  const values = timed.map((entry) => entry.responseMs).sort((a, b) => a - b);
  let best: readonly number[] = [];
  for (const [start, lowest] of values.entries()) {
    const group = values.slice(start).filter((ms) => ms <= Math.max(lowest, 0) * AGREEING_TIME_SPAN + slackMs);
    if (group.length > best.length) best = group;
  }
  return best;
};

export const summarizeMeterResponseTimings = (
  device: { id: string; name: string },
  entries: readonly MeterResponseEntry[],
  nowMs: number,
): MeterResponseTimingSummary[] => {
  const current = entries.filter((entry) => nowMs - entry.atMs < TIMING_WINDOW_MS);
  return (['on', 'off'] as const).flatMap((direction) => {
    const ofDirection = current.filter((entry) => entry.direction === direction);
    if (ofDirection.length === 0) return [];
    const timed = ofDirection.filter((entry): entry is TimedEntry => entry.outcome === 'timed');
    const agreeing = resolveAgreeingTimes(timed);
    return [{
      deviceId: device.id,
      deviceName: device.name,
      direction,
      samples: timed.length,
      medianResponseMs: median(timed.map((entry) => entry.responseMs)),
      agreeing: agreeing.length,
      agreedResponseMs: median(agreeing),
      trusted: agreeing.length >= MIN_AGREEING_TIMES,
      noChange: ofDirection.length - timed.length,
      medianResolutionMs: median(timed.map((entry) => entry.resolutionMs)),
      medianAcceptedAfterMs: median(timed.flatMap((entry) => (
        entry.acceptedAfterMs === undefined ? [] : [entry.acceptedAfterMs]
      ))),
    }];
  });
};

const toEntry = (outcome: MeterResponseOutcome): MeterResponseEntry | null => {
  const { dispatchedAtMs: atMs, direction } = outcome;
  if (outcome.kind === 'no_change') return { outcome: 'no_change', atMs, direction };
  if (outcome.kind !== 'timed') return null;
  const { responseMs, acceptedAfterMs, resolutionMs, changeKw } = outcome;
  return {
    outcome: 'timed', atMs, direction, responseMs, resolutionMs, changeKw,
    ...(acceptedAfterMs === undefined ? {} : { acceptedAfterMs }),
  };
};

/** `entries` with `entry` added: the newest of each direction and outcome within the window. */
export const keepMeterResponseEntries = (
  entries: readonly MeterResponseEntry[], entry: MeterResponseEntry,
): MeterResponseEntry[] => {
  const current = [...entries, entry].filter((kept) => entry.atMs - kept.atMs < TIMING_WINDOW_MS);
  const newerOfKind = (index: number): number => current.slice(index + 1).filter((newer) => (
    newer.direction === current[index]!.direction && newer.outcome === current[index]!.outcome
  )).length;
  return current.filter((_kept, index) => newerOfKind(index) < MAX_ENTRIES_PER_KIND);
};

const logOutcome = (outcome: MeterResponseOutcome): void => {
  const base = {
    deviceId: outcome.deviceId,
    deviceName: outcome.deviceName,
    direction: outcome.direction,
    figureKw: outcome.figureKw,
    dispatchedAtMs: outcome.dispatchedAtMs,
  };
  if (outcome.kind === 'timed') {
    logger.info({
      event: 'meter_response_timed',
      ...base,
      responseMs: outcome.responseMs,
      ...(outcome.acceptedAfterMs === undefined ? {} : { acceptedAfterMs: outcome.acceptedAfterMs }),
      resolutionMs: outcome.resolutionMs,
      changeKw: outcome.changeKw,
    });
  } else if (outcome.kind === 'no_change') {
    logger.info({ event: 'meter_response_no_change', ...base });
  } else {
    emitDebug({ event: 'meter_response_dropped', ...base, reason: outcome.reason });
  }
};

/**
 * Told of every write and Main's readings; keeps what the capture times. The
 * entries are loaded from the userdata database on first use; while that read
 * fails nothing is recorded, so a write cannot drop rows nobody has read.
 */
export class MeterResponseTimings implements DeviceCommandWitness {
  private readonly capture = new MeterResponseCapture();
  private entries: MeterResponseEntriesByDeviceId | null = null;
  private readFailureLogged = false;
  /** Said once per run of failures, not at every reading. */
  private captureFailureLogged = false;

  constructor(private readonly getRepository: () => MeterResponseTimingRepository) {}

  commandDispatched(command: DeviceCommand, dispatchedAtMs: number): void {
    this.contained(() => this.capture.commandDispatched(command, dispatchedAtMs));
  }

  commandSettled(command: DeviceCommand, outcome: ActuatorOutcome, settledAtMs: number): void {
    this.contained(() => this.capture.commandSettled(command, outcome, settledAtMs));
  }

  commandFailed(command: DeviceCommand): void {
    this.contained(() => this.capture.commandFailed(command));
  }

  /**
   * One of Main's whole-home observations. Main's devices are read
   * through `readDevices` only when the capture needs them.
   */
  recordWholeHomeSample(
    sample: WholeHomePowerObservation, atMs: number, readDevices: () => readonly DeviceSurfaces[],
  ): void {
    this.contained(() => this.capture.recordSample(sample, atMs, readDevices));
  }

  /**
   * Each of `devices`' directions with anything kept, for a diagnostics report.
   * Throws while the stored entries cannot be read, so the report says the
   * section is unavailable rather than that nothing was timed.
   */
  readAll(devices: readonly { id: string; name: string }[], nowMs: number): MeterResponseTimingSummary[] {
    const entries = this.loadEntries();
    if (entries === null) throw new Error('The meter response timings could not be read.');
    return devices.flatMap((device) => summarizeMeterResponseTimings(device, entries.get(device.id) ?? [], nowMs));
  }

  /** Capture only: a failure here is logged once and never reaches the write or the reading that caused it. */
  private contained(observe: () => void): void {
    try {
      observe();
      this.flush();
      this.captureFailureLogged = false;
    } catch (error) {
      if (!this.captureFailureLogged) {
        logger.error({ event: 'meter_response_capture_failed', err: normalizeError(error) });
      }
      this.captureFailureLogged = true;
    }
  }

  private flush(): void {
    for (const outcome of this.capture.drainOutcomes()) {
      logOutcome(outcome);
      const entry = toEntry(outcome);
      if (entry !== null) this.store(outcome.deviceId, entry);
    }
  }

  private store(deviceId: string, entry: MeterResponseEntry): void {
    const entries = this.loadEntries();
    if (entries === null) return;
    const next = new Map(entries);
    next.set(deviceId, keepMeterResponseEntries(entries.get(deviceId) ?? [], entry));
    this.entries = next;
    try {
      this.getRepository().write(next);
    } catch (error) {
      logger.error({ event: 'meter_response_timing_write_failed', deviceId, err: normalizeError(error) });
    }
  }

  private loadEntries(): MeterResponseEntriesByDeviceId | null {
    if (this.entries !== null) return this.entries;
    try {
      this.entries = this.getRepository().read();
      this.readFailureLogged = false;
    } catch (error) {
      if (!this.readFailureLogged) {
        logger.error({ event: 'meter_response_timing_read_failed', err: normalizeError(error) });
      }
      this.readFailureLogged = true;
    }
    return this.entries;
  }
}

/**
 * The app's timings, on the table of whichever userdata database is open: the
 * repository is built on first use and rebuilt for a reopened database.
 */
export const createMeterResponseTimings = (getDatabase: () => UserdataDatabase): MeterResponseTimings => {
  let opened: { database: UserdataDatabase; repository: MeterResponseTimingRepository } | undefined;
  return new MeterResponseTimings(() => {
    const database = getDatabase();
    if (opened?.database !== database) opened = { database, repository: createMeterResponseTimingRepository(database) };
    return opened.repository;
  });
};
