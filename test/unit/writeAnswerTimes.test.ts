import { describe, expect, it } from 'vitest';
import {
  MAX_ANSWER_MS,
  MAX_SAMPLES,
  MIN_WINDOW_MS,
  SAMPLE_WINDOW_MS,
  WARM_UP_MS,
  WriteAnswerTimes,
  switchAnswerKind,
  type WriteAnswerKind,
} from '../../lib/device/transport/writeAnswerTimes';
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../../lib/ports/controlCommandConfirmation';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';

const START = Date.parse('2026-11-22T12:00:00.000Z');
const READY = START + WARM_UP_MS;
const NOW = READY + 60 * 60_000;

const learner = (feedUp: () => boolean = () => true) => new WriteAnswerTimes(START, feedUp);
const nameOf = (deviceId: string) => `Device ${deviceId}`;

/** One write sent at `sentAtMs` and answered `answerMs` later. */
const answer = (times: WriteAnswerTimes, deviceId: string, kind: WriteAnswerKind, sentAtMs: number, answerMs: number) => {
  const attempt = times.begin(deviceId, kind, sentAtMs);
  times.answered(attempt, sentAtMs + answerMs);
};

/** `answersMs` answered one minute apart, from `READY` on. */
const answerAll = (times: WriteAnswerTimes, deviceId: string, answersMs: number[], kind: WriteAnswerKind = 'switch_on') => {
  answersMs.forEach((answerMs, index) => answer(times, deviceId, kind, READY + index * 60_000, answerMs));
};

describe('WriteAnswerTimes', () => {
  it('keeps the fixed window until a device has three answers in that direction', () => {
    const times = learner();
    answerAll(times, 'relay', [400, 500]);

    expect(times.windowMs('relay', true, NOW)).toBe(CONTROL_COMMAND_CONFIRMATION_MS);
    expect(times.windowMs('unknown', true, NOW)).toBe(CONTROL_COMMAND_CONFIRMATION_MS);
  });

  it('learns twice the slowest answer plus a margin from three answers', () => {
    const times = learner();
    answerAll(times, 'cloud-relay', [8_000, 14_000, 12_000]);

    expect(times.windowMs('cloud-relay', true, NOW)).toBe(2 * 14_000 + 15_000);
  });

  it('never goes below the floor for a device that answers at once', () => {
    const times = learner();
    answerAll(times, 'relay', [300, 400, 500]);

    expect(times.windowMs('relay', true, NOW)).toBe(MIN_WINDOW_MS);
  });

  it('learns each direction on its own', () => {
    const times = learner();
    answerAll(times, 'relay', [300, 400, 500], 'switch_on');

    expect(times.windowMs('relay', true, NOW)).toBe(MIN_WINDOW_MS);
    expect(times.windowMs('relay', false, NOW)).toBe(CONTROL_COMMAND_CONFIRMATION_MS);
  });

  it('never learns an on/off window from other writes to the device', () => {
    const times = learner();
    answerAll(times, 'thermostat', [300, 400, 500], 'other');

    expect(times.windowMs('thermostat', true, NOW)).toBe(CONTROL_COMMAND_CONFIRMATION_MS);
    expect(times.windowMs('thermostat', false, NOW)).toBe(CONTROL_COMMAND_CONFIRMATION_MS);
  });

  it('sets the slowest answer aside once five are kept, so one stall does not stretch it', () => {
    const times = learner();
    answerAll(times, 'relay', [400, 300, 14_000, 500, 600]);

    expect(times.windowMs('relay', true, NOW)).toBe(MIN_WINDOW_MS);
  });

  it('learns nothing from a write sent while another write to the device is in flight', () => {
    const times = learner();
    answerAll(times, 'relay', [400, 400]);
    const setpoint = times.begin('relay', 'other', NOW - 10_000);
    const queued = times.begin('relay', 'switch_on', NOW - 9_000);
    times.answered(setpoint, NOW - 2_000);
    times.answered(queued, NOW - 1_000);

    expect(times.windowMs('relay', true, NOW)).toBe(CONTROL_COMMAND_CONFIRMATION_MS);
  });

  it('learns nothing from a write that failed, and lets the next one count', () => {
    const times = learner();
    const failed = times.begin('relay', 'switch_on', READY);
    times.unanswered(failed, false);
    times.answered(failed, READY + 200);
    answerAll(times, 'relay', [400, 400, 400]);

    expect(times.describe(NOW, nameOf)).toEqual([expect.objectContaining({ deviceId: 'relay', samples: 3 })]);
  });

  it('relearns from scratch after a write that timed out without an answer', () => {
    const times = learner();
    answerAll(times, 'relay', [400, 400, 400]);
    answerAll(times, 'relay', [900], 'other');
    times.unanswered(times.begin('relay', 'switch_off', NOW - 20_000), true);

    expect(times.windowMs('relay', true, NOW)).toBe(CONTROL_COMMAND_CONFIRMATION_MS);
    expect(times.describe(NOW, nameOf)).toEqual([]);
  });

  it('learns nothing from writes sent during the warm-up after start', () => {
    const times = learner();
    [START, START + 1_000, START + WARM_UP_MS - 1].forEach((sentAtMs) => answer(times, 'relay', 'switch_on', sentAtMs, 400));

    expect(times.describe(NOW, nameOf)).toEqual([]);
  });

  it('learns nothing from an answer before the write, too late, or not a number', () => {
    const times = learner();
    answerAll(times, 'relay', [-1, MAX_ANSWER_MS + 1, Number.NaN]);

    expect(times.describe(NOW, nameOf)).toEqual([]);
  });

  it('keeps the fixed window while the live feed is down, whatever is learned', () => {
    let feedUp = true;
    const times = learner(() => feedUp);
    answerAll(times, 'relay', [400, 400, 400]);
    feedUp = false;

    expect(times.windowMs('relay', true, NOW)).toBe(CONTROL_COMMAND_CONFIRMATION_MS);
    feedUp = true;
    expect(times.windowMs('relay', true, NOW)).toBe(MIN_WINDOW_MS);
  });

  it('relearns from scratch when an on/off command goes unconfirmed', () => {
    const times = learner();
    answerAll(times, 'relay', [400, 400, 400]);
    answerAll(times, 'relay', [400, 400, 400], 'switch_off');
    times.unconfirmed('relay');

    expect(times.windowMs('relay', true, NOW)).toBe(CONTROL_COMMAND_CONFIRMATION_MS);
    expect(times.windowMs('relay', false, NOW)).toBe(CONTROL_COMMAND_CONFIRMATION_MS);
  });

  it('forgets answers older than the sample window', () => {
    const times = learner();
    answerAll(times, 'relay', [400, 400, 400]);

    expect(times.windowMs('relay', true, READY + SAMPLE_WINDOW_MS + 60 * 60_000)).toBe(CONTROL_COMMAND_CONFIRMATION_MS);
  });

  it('keeps only the newest answers', () => {
    const times = learner();
    answerAll(times, 'heater', [12_000, ...Array.from({ length: MAX_SAMPLES }, () => 1_000)]);

    expect(times.describe(NOW, nameOf)).toEqual([expect.objectContaining({
      samples: MAX_SAMPLES, slowestAnswerMs: 1_000,
    })]);
  });

  it('reports each device and kind of write with its median, slowest and on/off window', () => {
    const times = learner();
    answerAll(times, 'heater', [4_000, 2_000, 12_000]);
    answerAll(times, 'heater', [9_000], 'other');

    expect(times.describe(NOW, nameOf)).toEqual([
      { deviceId: 'heater', deviceName: 'Device heater', kind: 'switch_on', samples: 3, medianAnswerMs: 4_000,
        slowestAnswerMs: 12_000, confirmationWindowMs: 2 * 12_000 + 15_000 },
      { deviceId: 'heater', deviceName: 'Device heater', kind: 'other', samples: 1, medianAnswerMs: 9_000,
        slowestAnswerMs: 9_000, confirmationWindowMs: null },
    ]);
  });
});

describe('switchAnswerKind', () => {
  const relay = { binaryCapabilityId: 'onoff' } as TransportDeviceSnapshot;
  const onoff = (value: unknown) => ({ capabilityId: 'onoff', value });

  it('names an on/off write to the switch that reads back as written, by direction', () => {
    expect(switchAnswerKind(relay, onoff(true), onoff(true), true)).toBe('switch_on');
    expect(switchAnswerKind(relay, onoff(false), onoff(false), true)).toBe('switch_off');
  });

  it('names any switch confirmed by something other than its own echo as another write', () => {
    // The integration sends the switch as another write, such as a charger current of 0 A.
    expect(switchAnswerKind(relay, onoff(false), { capabilityId: 'target_current', value: 0 }, true)).toBe('other');
    // PELS does not read the switch back as written.
    expect(switchAnswerKind(relay, onoff(true), onoff(true), false)).toBe('other');
    // The device reports its switch on another capability.
    expect(switchAnswerKind({ ...relay, binaryObservationCapabilityId: 'evcharger_charging' } as TransportDeviceSnapshot,
      onoff(true), onoff(true), true)).toBe('other');
    // A write that is not the switch, or a device PELS has no snapshot of.
    expect(switchAnswerKind(relay, { capabilityId: 'target_temperature', value: 21 },
      { capabilityId: 'target_temperature', value: 21 }, true)).toBe('other');
    expect(switchAnswerKind(undefined, onoff(true), onoff(true), true)).toBe('other');
  });
});
