import {
  CONTROL_COMMAND_CONFIRMATION_MS,
  type ConfirmationWindows,
} from '../../ports/controlCommandConfirmation';
import type { CapabilityWrite } from '../deviceAdapter';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { isHomeyRequestTimeout } from '../../utils/errorUtils';

/**
 * Owner: transport. How long Homey takes to answer PELS's own writes to each
 * device, and the on/off confirmation window that follows from it.
 *
 * The answer is Homey's reply to the write itself: a capability write's PUT
 * resolving, or an app action card's run resolving. Homey replies once the
 * device's app has taken the command, so the time is the device's command
 * path: a Zigbee or Z-Wave radio answers in well under a second, a vendor
 * cloud in seconds to over a minute. It says nothing about when the device
 * starts or stops drawing power, and it is not read from any device report.
 * Every write's answer is kept, by what it was, and reported in diagnostics.
 *
 * Only an on/off command takes a learned window, and only from answers to
 * on/off writes in the same direction that reached the switch capability
 * itself and read back as written ({@link switchAnswerKind}): then the
 * confirmation is Homey's echo of the write, which arrives with the answer.
 * A switch the device's integration turns into another write (a charger paused
 * by a current of 0 A), a switch read back from another capability, a Flow,
 * and every setpoint, step and action is confirmed by a later report, minutes
 * after Homey answered, so it keeps the fixed window.
 *
 * Only clean samples are learned, because one wrong sample moves the window
 * for every later command to that device:
 * - only a write PELS sent and Homey answered without an error: a rejected,
 *   failed or unanswered write gives no time at all;
 * - only a write that was the device's sole PELS write in flight, since one
 *   queued behind another reports the wait for both;
 * - none sent during the warm-up after start, while Homey and the app are
 *   still busy starting;
 * - none negative, and none longer than {@link MAX_ANSWER_MS}.
 *
 * The window is three or more of the newest {@link MAX_SAMPLES} answers from
 * the last {@link SAMPLE_WINDOW_MS}. With five or more the slowest is set
 * aside, so one stalled answer does not stretch it. Until then the device keeps
 * {@link CONTROL_COMMAND_CONFIRMATION_MS}, and so does every device while the
 * live feed is down: its echo then reaches PELS only on the next read. A device
 * relearns from scratch when an on/off command to it goes unconfirmed, or a
 * write to it times out without an answer: a capability write's request is
 * given up after 15 s, so a slow answer would otherwise never be learned.
 * Learning is in memory: after a restart a device relearns from its next
 * writes, and a device removed from Homey is forgotten then.
 */
export class WriteAnswerTimes implements ConfirmationWindows {
  private readonly samplesByKey = new Map<string, WriteAnswerSample[]>();
  private readonly inFlightByDeviceId = new Map<string, number>();

  constructor(
    private readonly startedAtMs: number,
    private readonly isLiveFeedSubscribed: () => boolean,
  ) {}

  /**
   * Send one write and time Homey's answer to it: `send` resolving is the
   * answer, its rejecting is no answer. The write's own outcome is returned
   * unchanged.
   */
  async timeWrite<T>(deviceId: string, kind: WriteAnswerKind, send: () => Promise<T>): Promise<T> {
    const attempt = this.begin(deviceId, kind, Date.now());
    try {
      const result = await send();
      this.answered(attempt, Date.now());
      return result;
    } catch (error) {
      this.unanswered(attempt, isHomeyRequestTimeout(error));
      throw error;
    }
  }

  /** What a capability write is, for its answer ({@link switchAnswerKind}). */
  kindOf(
    snapshot: TransportDeviceSnapshot | undefined, requested: CapabilityWrite, sent: CapabilityWrite, readBack: boolean,
  ): WriteAnswerKind {
    return switchAnswerKind(snapshot, requested, sent, readBack);
  }

  /** A write about to be sent; settle it with {@link answered} or {@link unanswered}. */
  begin(deviceId: string, kind: WriteAnswerKind, sentAtMs: number): WriteAnswerAttempt {
    const inFlight = this.inFlightByDeviceId.get(deviceId) ?? 0;
    this.inFlightByDeviceId.set(deviceId, inFlight + 1);
    return {
      deviceId,
      kind,
      sentAtMs,
      learnable: inFlight === 0 && sentAtMs - this.startedAtMs >= WARM_UP_MS,
      settled: false,
    };
  }

  /** Homey answered the write without an error. */
  answered(attempt: WriteAnswerAttempt, answeredAtMs: number): void {
    if (!this.settle(attempt)) return;
    const answerMs = answeredAtMs - attempt.sentAtMs;
    if (!attempt.learnable || !Number.isFinite(answerMs) || answerMs < 0 || answerMs > MAX_ANSWER_MS) return;
    const key = sampleKey(attempt.deviceId, attempt.kind);
    const kept = this.currentSamples(key, answeredAtMs);
    this.samplesByKey.set(key, [...kept, { answerMs, atMs: answeredAtMs }].slice(-MAX_SAMPLES));
  }

  /**
   * The write failed, was refused or got no answer: no time is learned from it.
   * A request that timed out also clears what the device had learned.
   */
  unanswered(attempt: WriteAnswerAttempt, timedOut: boolean): void {
    if (this.settle(attempt) && timedOut) this.forget(attempt.deviceId);
  }

  windowMs(deviceId: string, desired: boolean, nowMs: number): number {
    const estimateMs = this.isLiveFeedSubscribed()
      ? this.estimateMs(sampleKey(deviceId, desired ? 'switch_on' : 'switch_off'), nowMs) : undefined;
    if (estimateMs === undefined) return CONTROL_COMMAND_CONFIRMATION_MS;
    return Math.max(MIN_WINDOW_MS, 2 * estimateMs + WINDOW_MARGIN_MS);
  }

  /** An on/off command went unconfirmed in its window: the device relearns from scratch. */
  unconfirmed(deviceId: string): void {
    this.forget(deviceId);
  }

  /** What is kept for each device and kind of write, with the device's name in Homey, for diagnostics. */
  describe(nowMs: number, nameOf: (deviceId: string) => string | null): WriteAnswerTimesEntry[] {
    return [...this.samplesByKey.keys()].flatMap((key) => {
      const samples = this.currentSamples(key, nowMs);
      if (samples.length === 0) return [];
      const [deviceId, kind] = parseSampleKey(key);
      const sorted = samples.map((sample) => sample.answerMs).sort((a, b) => a - b);
      return [{
        deviceId,
        deviceName: nameOf(deviceId),
        kind,
        samples: samples.length,
        medianAnswerMs: sorted[Math.floor((sorted.length - 1) / 2)] ?? 0,
        slowestAnswerMs: sorted.at(-1) ?? 0,
        confirmationWindowMs: kind === 'other' ? null : this.windowMs(deviceId, kind === 'switch_on', nowMs),
      }];
    });
  }

  private forget(deviceId: string): void {
    for (const kind of WRITE_ANSWER_KINDS) this.samplesByKey.delete(sampleKey(deviceId, kind));
  }

  private estimateMs(key: string, nowMs: number): number | undefined {
    const samples = this.currentSamples(key, nowMs);
    if (samples.length < MIN_SAMPLES) return undefined;
    const slowestFirst = samples.map((sample) => sample.answerMs).sort((a, b) => b - a);
    return slowestFirst[samples.length >= TRIM_SLOWEST_FROM ? 1 : 0];
  }

  private currentSamples(key: string, nowMs: number): WriteAnswerSample[] {
    return (this.samplesByKey.get(key) ?? []).filter((sample) => nowMs - sample.atMs < SAMPLE_WINDOW_MS);
  }

  /** Settle an attempt once; false when it was already settled. */
  private settle(attempt: WriteAnswerAttempt): boolean {
    if (attempt.settled) return false;
    // eslint-disable-next-line no-param-reassign -- The attempt is this owner's token, settled once.
    attempt.settled = true;
    const inFlight = (this.inFlightByDeviceId.get(attempt.deviceId) ?? 1) - 1;
    if (inFlight > 0) this.inFlightByDeviceId.set(attempt.deviceId, inFlight);
    else this.inFlightByDeviceId.delete(attempt.deviceId);
    return true;
  }
}

/**
 * What a capability write is, for its answer: an on/off write whose echo is its
 * confirmation, or any other write. It is the switch's only when the write
 * reached the switch capability itself, PELS reads that capability back as
 * written, and the device reports its switch on that same capability.
 */
export function switchAnswerKind(
  snapshot: TransportDeviceSnapshot | undefined,
  requested: CapabilityWrite,
  sent: CapabilityWrite,
  readBackAsWritten: boolean,
): WriteAnswerKind {
  const switchCapabilityId = snapshot?.binaryCapabilityId;
  const echoed = readBackAsWritten && typeof requested.value === 'boolean'
    && requested.capabilityId === switchCapabilityId && sent.capabilityId === switchCapabilityId
    && (snapshot?.binaryObservationCapabilityId ?? switchCapabilityId) === switchCapabilityId;
  if (!echoed) return 'other';
  return requested.value === true ? 'switch_on' : 'switch_off';
}

/** An on/off write whose echo confirms it, by direction, or any other write. */
export type WriteAnswerKind = 'switch_on' | 'switch_off' | 'other';
const WRITE_ANSWER_KINDS: readonly WriteAnswerKind[] = ['switch_on', 'switch_off', 'other'];

const sampleKey = (deviceId: string, kind: WriteAnswerKind): string => `${kind}:${deviceId}`;
const parseSampleKey = (key: string): [string, WriteAnswerKind] => {
  const separator = key.indexOf(':');
  return [key.slice(separator + 1), key.slice(0, separator) as WriteAnswerKind];
};

/** One write on its way, as {@link WriteAnswerTimes.begin} issued it. */
export type WriteAnswerAttempt = {
  readonly deviceId: string;
  readonly kind: WriteAnswerKind;
  readonly sentAtMs: number;
  /** Whether its answer may be learned: the device's only write in flight, sent after warm-up. */
  readonly learnable: boolean;
  settled: boolean;
};

/** One device's answer times for one kind of write, as the diagnostics report lists them. */
export type WriteAnswerTimesEntry = {
  deviceId: string;
  /** The device's name in Homey, or null once it is gone. */
  deviceName: string | null;
  kind: WriteAnswerKind;
  samples: number;
  medianAnswerMs: number;
  slowestAnswerMs: number;
  /** The window an on/off command in this direction sent now would take; null for other writes. */
  confirmationWindowMs: number | null;
};

type WriteAnswerSample = { answerMs: number; atMs: number };

/** Answers needed before a device's window is learned. */
export const MIN_SAMPLES = 3;
/** Newest answers kept per device and kind of write. */
export const MAX_SAMPLES = 8;
/** From this many answers on, the slowest is set aside. */
const TRIM_SLOWEST_FROM = 5;
/** An answer counts this long, as a learned power peak does. */
export const SAMPLE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Writes sent this soon after start teach nothing. */
export const WARM_UP_MS = 2 * 60 * 1000;
/** The longest answer learned: an action run is listened to this long (`homeyActionAccess.ts`). */
export const MAX_ANSWER_MS = 120 * 1000;
/**
 * A learned window is twice the answer time plus this. A capability write's
 * answer comes within its 15 s request timeout, so an on/off window stays
 * under a minute.
 */
const WINDOW_MARGIN_MS = 15 * 1000;
/**
 * Never shorter. The window is also what resolves a write whose request timed
 * out (15 s, `managerHomeyApi.ts`) while Homey may still deliver it, so it
 * leaves telemetry as long again to settle it, and covers the read PELS
 * schedules after a write for an echo that missed the live feed.
 */
export const MIN_WINDOW_MS = 30 * 1000;
