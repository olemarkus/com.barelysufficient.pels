/**
 * How long after PELS switches one device on or off the change shows on the
 * whole-home meter. Capture only: nothing here feeds a plan, pacing, cooldown
 * or shed decision.
 *
 * The shed relief audit (`lib/plan/shedding/shedReliefAudit.ts`) reads how far
 * the home fell a minute after a lone switch-off. This reads when it moved, at
 * the meter's own resolution, for switch-offs and switch-ons alike. Unrelated
 * load moves the same meter, so a sample is taken only when nothing else could
 * have made the move, and dropped at the first doubt:
 *
 * - Lone command: no other write to any device in {@link PRIOR_QUIET_MS} before
 *   the command (whole-home readings for that long, so a write sent before
 *   a restart cannot hide), none in flight, and none until the sample is taken.
 * - Known size and direction: an on/off device (no chargers, batteries, solar
 *   or stepped devices) with a known figure: its own direct reading before a
 *   switch-off, else the figure PELS plans it with (never an assumed default).
 *   The home must move the expected way by at least half of it and at least
 *   {@link NOISE_FLOOR_KW}, then hold the new level.
 * - Steady before: the home reading held within a quarter of the figure for
 *   {@link STEADY_MS} before the command.
 * - Fast readings: whole-home power changes at least every
 *   {@link MAX_SAMPLE_INTERVAL_MS}, with no longer gap while a sample is open.
 * - Nothing else moved: no other device's own direct reading, and no
 *   production reading, moved by {@link OTHER_MOVE_KW} from the steady period
 *   to the sample. Production may be the latest still-fresh observation
 *   from a separate poll. The settle window keeps checking for later
 *   updates, and losing the production signal invalidates the window.
 * - Own reading agrees: a device with its own direct reading must report a new
 *   value after the command, show the change, and cross half of it within
 *   {@link OWN_TIMING_TOLERANCE_MS} of the home.
 *
 * Only a device's direct reading (`measuredPowerIsDirectMeasurement`) is its
 * own reading here; one derived from an energy counter is no own reading. Its
 * age is no evidence (`lib/AGENTS.md`): Homey re-dates a reading only when the
 * value changes, so a steady draw reads old. Whether the device reported after
 * the command is what tells a reading that moved from one that went quiet.
 *
 * A confirmed meter replacement discards the open window. Without that evidence,
 * a coincident level change can still look like a response, so individual
 * timings need corroboration.
 *
 * Timing runs from dispatch to the first whole-home reading past half of the
 * settled change. It is never more precise
 * than one meter interval, which is recorded with it. When Homey accepted the
 * write, that delay is recorded beside it. A command whose change never shows
 * within {@link WINDOW_MS} is a "no change" only when the device's own direct
 * reading shows that the device did change; otherwise nothing says the device
 * changed at all (a thermostat may have kept it idle), and it is dropped.
 */
import type { ActuatorOutcome, DeviceCommand } from '../actuator/deviceCommand';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import type { WholeHomePowerObservation } from '../ports/homeMeterReadings';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';

export type MeterResponseDirection = 'on' | 'off';

/** No other write to any device this long before the command: a device turned on just before may still be starting. */
export const PRIOR_QUIET_MS = 5 * 60 * 1000;
/** How long the home must have held steady before the command. */
export const STEADY_MS = 60 * 1000;
/** The longest a change may take to show; one device type takes about 300 s to draw after it is turned on. */
export const WINDOW_MS = 10 * 60 * 1000;
/** How long the home must hold its new level after it moved, before the sample is taken. */
export const SETTLE_MS = 60 * 1000;
/** The largest gap the capture can time a response across. */
export const MAX_SAMPLE_INTERVAL_MS = 15 * 1000;
/** The smallest move of the home that counts as the device's. */
export const NOISE_FLOOR_KW = 0.3;
/** A move of another device's own reading, or of production, this large makes the window doubtful. */
export const OTHER_MOVE_KW = 0.2;
/** A device's own reading and the home must cross half their change this close together. */
export const OWN_TIMING_TOLERANCE_MS = 30 * 1000;
/** A device drawing less than this before its switch-off was not running: nothing can fall. */
const MIN_RUNNING_DRAW_KW = 0.05;
/** The fewest readings in the steady period, and meter value changes in the cadence check. */
const MIN_STEADY_READINGS = 3;
/** How far back the meter's cadence is read. */
const CADENCE_LOOKBACK_MS = 2 * 60 * 1000;
/** While a watch is open, keep enough history for its cadence, window and settle period. */
const HISTORY_MS = CADENCE_LOOKBACK_MS + WINDOW_MS + SETTLE_MS;
/** A write that never settled stops counting as in flight after this. */
const IN_FLIGHT_EXPIRY_MS = WINDOW_MS;

export type MeterResponseDropReason =
  | 'concurrent_command'
  | 'command_not_sent'
  | 'slow_meter'
  | 'meter_changed'
  | 'unsteady_before'
  | 'other_device_moved'
  | 'generation_moved'
  | 'wrong_direction'
  | 'too_small'
  | 'unsettled'
  | 'own_reading_disagrees'
  /** The device's own reading reported nothing after the command: moved or not, it cannot say. */
  | 'own_reading_silent'
  /** The home did not show a change, and nothing says the device changed either. */
  | 'no_change_unverified';

type Subject = {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly direction: MeterResponseDirection;
  readonly dispatchedAtMs: number;
  /** The draw the switch should add or remove. */
  readonly figureKw: number;
};

/** What became of one watched command. */
export type MeterResponseOutcome = Subject & (
  | {
    readonly kind: 'timed';
    /** From dispatch to the first meter reading past half of the change. */
    readonly responseMs: number;
    /** From dispatch to Homey's acceptance of the write, when it accepted. */
    readonly acceptedAfterMs?: number;
    /** The gap before the reading that crossed: the change happened at most this much earlier. */
    readonly resolutionMs: number;
    /** The home's change, positive in the expected direction. */
    readonly changeKw: number;
  }
  | { readonly kind: 'no_change' }
  | { readonly kind: 'dropped'; readonly reason: MeterResponseDropReason }
);

/** A device's direct reading as one meter reading saw it. */
type OwnReading = { readonly kw: number; readonly observedAtMs: number | undefined };

type Reading = {
  readonly atMs: number;
  readonly kw: number;
  readonly generationKw: number | undefined;
  /** Each device's direct reading at this sample; null when the devices were not read for it. */
  readonly ownKw: ReadonlyMap<string, OwnReading> | null;
};

type OpenWatch = Subject & {
  readonly command: DeviceCommand;
  readonly thresholdKw: number;
  readonly steadyBoundKw: number;
  readonly beforeKw: number;
  readonly baseline: Reading & { readonly ownKw: ReadonlyMap<string, OwnReading> };
  acceptedAtMs: number | null;
  reachedAtMs: number | null;
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.slice(Math.floor((sorted.length - 1) / 2), Math.floor(sorted.length / 2) + 1);
  return middle.reduce((sum, value) => sum + value, 0) / middle.length;
};

const spread = (values: readonly number[]): number => Math.max(...values) - Math.min(...values);

const roundKw = (kw: number): number => Math.round(kw * 1000) / 1000;

/** The device's own reading, when it measures its draw directly. */
const resolveOwnReading = (device: DeviceSurfaces): OwnReading | undefined => (
  device.measuredPowerKw !== undefined && device.measuredPowerIsDirectMeasurement === true
    ? { kw: device.measuredPowerKw, observedAtMs: device.measuredPowerObservedAtMs }
    : undefined
);

/**
 * The draw a switch of `device` should move, or null when the device is not
 * one the capture times: a charger, battery, solar or stepped device, a figure
 * PELS only assumed, a switch-off of a device whose own reading says it was not
 * drawing, or a draw too small to tell from the noise.
 */
const resolveFigureKw = (device: DeviceSurfaces, direction: MeterResponseDirection): number | null => {
  if (device.isEvCharger || device.isBatteryOrSolar || isSteppedLoadSnapshot(device)) return null;
  const own = resolveOwnReading(device);
  let figureKw: number;
  if (direction === 'off' && own !== undefined) {
    if (own.kw < MIN_RUNNING_DRAW_KW) return null;
    figureKw = own.kw;
  } else {
    if (device.expectedPowerSource === 'default') return null;
    figureKw = device.expectedPowerKw;
  }
  return figureKw >= NOISE_FLOOR_KW ? figureKw : null;
};

/** The median gap between changes of the meter's value, or null with too few changes to say. */
const resolveChangeCadenceMs = (readings: readonly Reading[]): number | null => {
  const changeTimes = readings.flatMap((reading, index) => (
    index > 0 && reading.kw !== readings[index - 1]!.kw ? [reading.atMs] : []
  ));
  if (changeTimes.length < MIN_STEADY_READINGS + 1) return null;
  return median(changeTimes.slice(1).map((atMs, index) => atMs - changeTimes[index]!));
};

/** Another device's direct reading moved. A reading that did not change cannot have moved, however old. */
const hasOtherMove = (watch: OpenWatch, reading: Reading): boolean => {
  if (reading.ownKw === null) return true;
  for (const [deviceId, baseline] of watch.baseline.ownKw) {
    if (deviceId === watch.deviceId) continue;
    const own = reading.ownKw.get(deviceId);
    if (own !== undefined && Math.abs(own.kw - baseline.kw) >= OTHER_MOVE_KW) return true;
  }
  return false;
};

const hasGenerationMove = (watch: OpenWatch, reading: Reading): boolean => {
  const before = watch.baseline.generationKw;
  const now = reading.generationKw;
  if (before === undefined || now === undefined) return before !== now;
  return Math.abs(now - before) >= OTHER_MOVE_KW;
};

const directionSign = (direction: MeterResponseDirection): number => (direction === 'on' ? 1 : -1);

/** The subject's own direct readings after the command, as moves the expected way from its baseline. */
const ownMovesAfter = (
  watch: OpenWatch, after: readonly Reading[],
): { readonly reported: boolean; readonly moves: readonly { atMs: number; deltaKw: number }[] } | null => {
  const before = watch.baseline.ownKw.get(watch.deviceId);
  if (before === undefined) return null;
  const sign = directionSign(watch.direction);
  const own = after.flatMap((reading) => {
    const read = reading.ownKw?.get(watch.deviceId);
    return read === undefined ? [] : [{ atMs: reading.atMs, read }];
  });
  return {
    reported: own.some(({ read }) => read.kw !== before.kw || read.observedAtMs !== before.observedAtMs),
    moves: own.map(({ atMs, read }) => ({ atMs, deltaKw: (read.kw - before.kw) * sign })),
  };
};

/**
 * The in-memory capture: told of every write and every whole-home reading,
 * it answers what became of each watched command. One command is watched at a
 * time, since a second write makes any open watch doubtful. A restart drops
 * the open watch.
 */
export class MeterResponseCapture {
  private readings: Reading[] = [];
  private streamGeneration: number | null = null;
  /** The first reading in this window. Writes sent before it are unseen. */
  private watchingSinceMs: number | null = null;
  private devicesById = new Map<string, DeviceSurfaces>();
  private lastDispatchAtMs: number | null = null;
  private readonly inFlight = new Map<DeviceCommand, number>();
  private watch: OpenWatch | null = null;
  private outcomes: MeterResponseOutcome[] = [];

  /** The outcomes since the last call, oldest first. */
  drainOutcomes(): MeterResponseOutcome[] {
    const drained = this.outcomes;
    this.outcomes = [];
    return drained;
  }

  commandDispatched(command: DeviceCommand, dispatchedAtMs: number): void {
    if (this.watch) this.drop(this.watch, 'concurrent_command');
    for (const [pending, atMs] of this.inFlight) {
      if (dispatchedAtMs - atMs >= IN_FLIGHT_EXPIRY_MS) this.inFlight.delete(pending);
    }
    const quiet = this.isQuietFor(dispatchedAtMs, PRIOR_QUIET_MS);
    this.inFlight.set(command, dispatchedAtMs);
    this.lastDispatchAtMs = dispatchedAtMs;
    if (command.kind !== 'binary') return;
    const device = this.devicesById.get(command.deviceId);
    if (!device) return;
    const direction: MeterResponseDirection = command.desired ? 'on' : 'off';
    const figureKw = resolveFigureKw(device, direction);
    if (figureKw === null) return;
    const subject: Subject = {
      deviceId: device.id, deviceName: device.name, direction, dispatchedAtMs, figureKw: roundKw(figureKw),
    };
    if (!quiet) {
      this.outcomes.push({ ...subject, kind: 'dropped', reason: 'concurrent_command' });
      return;
    }
    this.open(subject, command);
  }

  commandSettled(command: DeviceCommand, outcome: ActuatorOutcome, settledAtMs: number): void {
    this.inFlight.delete(command);
    const { watch } = this;
    if (watch?.command !== command) return;
    if (!outcome.requested) {
      this.drop(watch, 'command_not_sent');
      return;
    }
    if (outcome.kind === 'binary' && outcome.acknowledged) watch.acceptedAtMs = settledAtMs;
  }

  commandFailed(command: DeviceCommand): void {
    this.inFlight.delete(command);
    if (this.watch?.command === command) this.drop(this.watch, 'command_not_sent');
  }

  /**
   * One whole-home observation. The home's devices are read only when
   * they can matter: while a command is watched, or within a steady period of
   * the moment a command could be watched; a home PELS writes to often reads
   * none.
   */
  recordSample(sample: WholeHomePowerObservation, atMs: number, readDevices: () => readonly DeviceSurfaces[]): void {
    if (sample.streamGeneration !== this.streamGeneration) {
      this.readings = [];
      this.streamGeneration = sample.streamGeneration;
      this.watchingSinceMs = atMs;
      if (this.watch) this.drop(this.watch, 'meter_changed');
    }
    const previous = this.readings.at(-1);
    if (previous !== undefined && atMs <= previous.atMs) return;
    const devices = this.watch !== null || this.isQuietFor(atMs, PRIOR_QUIET_MS - STEADY_MS) ? readDevices() : null;
    this.devicesById = new Map((devices ?? []).map((device) => [device.id, device]));
    const reading: Reading = {
      atMs,
      kw: sample.powerW / 1000,
      generationKw: sample.generationW === undefined ? undefined : sample.generationW / 1000,
      ownKw: devices === null ? null : new Map(devices.flatMap((device) => {
        const own = resolveOwnReading(device);
        return own === undefined ? [] : [[device.id, own] as const];
      })),
    };
    this.readings.push(reading);
    const historyMs = this.watch === null ? CADENCE_LOOKBACK_MS : HISTORY_MS;
    while (this.readings.length > 0 && atMs - this.readings[0]!.atMs > historyMs) this.readings.shift();
    if (this.watch && previous !== undefined) this.follow(this.watch, previous, reading);
  }

  /** Nothing in flight, the meter read and no write sent for at least `quietMs` before `atMs`. */
  private isQuietFor(atMs: number, quietMs: number): boolean {
    return this.inFlight.size === 0
      && this.watchingSinceMs !== null && atMs - this.watchingSinceMs >= quietMs
      && (this.lastDispatchAtMs === null || atMs - this.lastDispatchAtMs >= quietMs);
  }

  private open(subject: Subject, command: DeviceCommand): void {
    const before = this.readings.filter((reading) => reading.atMs <= subject.dispatchedAtMs);
    const baseline = before.at(-1);
    const cadenceMs = resolveChangeCadenceMs(
      before.filter((reading) => subject.dispatchedAtMs - reading.atMs <= CADENCE_LOOKBACK_MS),
    );
    if (baseline === undefined || cadenceMs === null || cadenceMs > MAX_SAMPLE_INTERVAL_MS
      || subject.dispatchedAtMs - baseline.atMs > MAX_SAMPLE_INTERVAL_MS) {
      this.outcomes.push({ ...subject, kind: 'dropped', reason: 'slow_meter' });
      return;
    }
    const steady = before.filter((reading) => subject.dispatchedAtMs - reading.atMs <= STEADY_MS);
    const baselineOwnKw = baseline.ownKw;
    if (steady.length < MIN_STEADY_READINGS || baselineOwnKw === null || steady.some((reading) => !reading.ownKw)
      || spread(steady.map((reading) => reading.kw)) > subject.figureKw / 4) {
      this.outcomes.push({ ...subject, kind: 'dropped', reason: 'unsteady_before' });
      return;
    }
    const watch: OpenWatch = {
      ...subject,
      command,
      thresholdKw: Math.max(subject.figureKw / 2, NOISE_FLOOR_KW),
      steadyBoundKw: subject.figureKw / 4,
      beforeKw: median(steady.map((reading) => reading.kw)),
      baseline: { ...baseline, ownKw: baselineOwnKw },
      acceptedAtMs: null,
      reachedAtMs: null,
    };
    if (steady.some((reading) => hasOtherMove(watch, reading))) {
      this.outcomes.push({ ...subject, kind: 'dropped', reason: 'other_device_moved' });
      return;
    }
    if (steady.some((reading) => hasGenerationMove(watch, reading))) {
      this.outcomes.push({ ...subject, kind: 'dropped', reason: 'generation_moved' });
      return;
    }
    this.watch = watch;
  }

  private follow(watch: OpenWatch, previous: Reading, reading: Reading): void {
    if (reading.atMs - previous.atMs > MAX_SAMPLE_INTERVAL_MS) return this.drop(watch, 'slow_meter');
    if (hasOtherMove(watch, reading)) return this.drop(watch, 'other_device_moved');
    if (hasGenerationMove(watch, reading)) return this.drop(watch, 'generation_moved');
    const deltaKw = (reading.kw - watch.beforeKw) * directionSign(watch.direction);
    if (watch.reachedAtMs === null) {
      if (deltaKw <= -watch.thresholdKw) return this.drop(watch, 'wrong_direction');
      if (deltaKw >= watch.thresholdKw) {
        this.watch = { ...watch, reachedAtMs: reading.atMs };
      } else if (reading.atMs - watch.dispatchedAtMs >= WINDOW_MS) {
        this.endWithoutChange(watch);
      }
      return undefined;
    }
    if (reading.atMs - watch.reachedAtMs >= SETTLE_MS) this.finish(watch);
    return undefined;
  }

  /** The home never moved: a "no change" only when the device's own reading says the device did. */
  private endWithoutChange(watch: OpenWatch): void {
    const own = ownMovesAfter(watch, this.readings.filter((reading) => reading.atMs > watch.dispatchedAtMs));
    const changed = own !== null && own.reported && (own.moves.at(-1)?.deltaKw ?? 0) >= watch.thresholdKw;
    if (!changed) return this.drop(watch, 'no_change_unverified');
    this.watch = null;
    this.outcomes.push({ ...this.subjectOf(watch), kind: 'no_change' });
    return undefined;
  }

  private finish(watch: OpenWatch): void {
    const sign = directionSign(watch.direction);
    const after = this.readings.filter((reading) => reading.atMs > watch.dispatchedAtMs);
    const settled = after.filter((reading) => reading.atMs >= (watch.reachedAtMs ?? 0) + SETTLE_MS / 2);
    const settledKw = settled.map((reading) => reading.kw);
    if (settled.length < 2 || spread(settledKw) > watch.steadyBoundKw) return this.drop(watch, 'unsettled');
    const changeKw = (median(settledKw) - watch.beforeKw) * sign;
    if (changeKw < watch.thresholdKw) return this.drop(watch, 'too_small');
    const crossingIndex = after.findIndex((reading) => (reading.kw - watch.beforeKw) * sign >= changeKw / 2);
    const crossing = after[crossingIndex];
    if (crossing === undefined) return this.drop(watch, 'unsettled');
    const beforeCrossing = crossingIndex > 0 ? after[crossingIndex - 1]! : watch.baseline;
    const resolutionMs = crossing.atMs - beforeCrossing.atMs;
    const disagreement = this.ownReadingDisagreement(watch, after, crossing, changeKw, resolutionMs);
    if (disagreement !== null) return this.drop(watch, disagreement);
    this.watch = null;
    this.outcomes.push({
      ...this.subjectOf(watch),
      kind: 'timed',
      responseMs: crossing.atMs - watch.dispatchedAtMs,
      ...(watch.acceptedAtMs === null ? {} : { acceptedAfterMs: watch.acceptedAtMs - watch.dispatchedAtMs }),
      resolutionMs,
      changeKw: roundKw(changeKw),
    });
    return undefined;
  }

  /**
   * Why the device's own direct reading puts the home's move in doubt, or null
   * when it does not. A device without one has nothing to disagree with. One
   * with a reading must report after the command, show at least a quarter of
   * the home's change, and cross half of its own change close to when the
   * home crossed half of its.
   */
  private ownReadingDisagreement(
    watch: OpenWatch, after: readonly Reading[], crossing: Reading, changeKw: number, resolutionMs: number,
  ): MeterResponseDropReason | null {
    const own = ownMovesAfter(watch, after);
    if (own === null) return null;
    if (!own.reported) return 'own_reading_silent';
    const ownChangeKw = own.moves.at(-1)?.deltaKw ?? 0;
    if (ownChangeKw < changeKw / 4) return 'own_reading_disagrees';
    const ownCrossing = own.moves.find((move) => move.deltaKw >= ownChangeKw / 2);
    if (ownCrossing === undefined) return 'own_reading_disagrees';
    const toleranceMs = Math.max(OWN_TIMING_TOLERANCE_MS, 2 * resolutionMs);
    return Math.abs(ownCrossing.atMs - crossing.atMs) <= toleranceMs ? null : 'own_reading_disagrees';
  }

  private subjectOf(watch: OpenWatch): Subject {
    const { deviceId, deviceName, direction, dispatchedAtMs, figureKw } = watch;
    return { deviceId, deviceName, direction, dispatchedAtMs, figureKw };
  }

  private drop(watch: OpenWatch, reason: MeterResponseDropReason): void {
    this.watch = null;
    this.outcomes.push({ ...this.subjectOf(watch), kind: 'dropped', reason });
  }
}
