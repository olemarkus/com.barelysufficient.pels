import { describe, expect, it, vi } from 'vitest';
import {
  CONTEST_THRESHOLD, CONTEST_WINDOW_MS, ControlContestObserver,
} from '../../lib/device/controlContestObserver';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import { partialDouble } from '../helpers/partialDouble';

const MINUTE_MS = 60_000;
const START = Date.UTC(2026, 10, 2, 6, 0);

const heater = (target: number, on = true) => partialDouble<TransportDeviceSnapshot>({
  id: 'heater', name: 'Stove', binaryCapabilityId: 'onoff', targets: [],
  binaryControlObservation: {
    valid: true, capabilityId: 'onoff', observedValue: on, observedCapabilityIds: ['onoff'],
    observedAtMs: START, source: 'realtime_capability',
  },
  temperature: partialDouble<NonNullable<TransportDeviceSnapshot['temperature']>>({ target: { id: 'target_temperature', value: target, unit: '°C' } }),
});

const setup = () => {
  const emit = vi.fn();
  const record = vi.fn();
  const observer = new ControlContestObserver(emit, { record });
  /** Something sets the target to `to`, overriding PELS's `from`. */
  const setTarget = (atMs: number, from: number, to: number) => observer.observeControlChange(heater(to), {
    deviceId: 'heater', observedAtMs: atMs,
    changes: [{ capabilityId: 'target_temperature', previousValue: `${from}°C`, nextValue: `${to}°C` }],
  });
  /** PELS sets the target to `value` on a device showing `before`. */
  const command = (atMs: number, value: number, before = 20) => observer.recordCommand(
    'heater', { capabilityId: 'target_temperature', value }, heater(before), atMs,
  );
  return { observer, emit, record, setTarget, command };
};

describe('settings changed outside PELS, again and again', () => {
  /** One round: something sets `to` over PELS's 17, and PELS sets 17 again. */
  const round = (
    { setTarget, command }: ReturnType<typeof setup>,
    atMs: number,
    to = 20,
  ) => {
    setTarget(atMs, 17, to);
    command(atMs + 20_000, 17, to);
  };

  it('records the device as contested once the rounds against PELS reach the threshold within the hour', () => {
    const context = setup();
    const { observer, record, command } = context;
    command(START, 17);
    for (let i = 0; i < CONTEST_THRESHOLD; i += 1) {
      round(context, START + (i * 5 + 2) * MINUTE_MS);
      expect(record).toHaveBeenCalledTimes(i + 1 < CONTEST_THRESHOLD ? 0 : 1);
    }
    expect(record).toHaveBeenCalledWith(['heater'], expect.objectContaining({
      event: 'device_control_contested', deviceId: 'heater', deviceName: 'Stove', kind: 'reverted',
      count: CONTEST_THRESHOLD,
      firstAtMs: START + 2 * MINUTE_MS,
    }));
    const [, event] = record.mock.calls[0];
    expect(event.changes.at(-1)).toEqual({
      atMs: START + 17 * MINUTE_MS, capabilityId: 'target_temperature', commanded: 17, observed: 20, kind: 'reverted',
    });
    expect(observer.contestedControl('heater', START + 18 * MINUTE_MS)).toEqual({
      capabilityId: 'target_temperature', kind: 'reverted', count: CONTEST_THRESHOLD, sinceMs: START + 2 * MINUTE_MS,
    });
    expect(observer.contestedControl('heater', START + 2 * MINUTE_MS + CONTEST_WINDOW_MS)).toBeUndefined();
  });

  it('tells a write that does not stick from something setting another value', () => {
    const context = setup();
    const { observer, record, command } = context;
    // PELS limits a heater set to 20 °C to 17 °C; something then sets 22 °C, not the 20 °C it had.
    command(START, 17, 20);
    for (let i = 0; i < CONTEST_THRESHOLD; i += 1) round(context, START + (i * 5 + 2) * MINUTE_MS, 22);
    expect(record).toHaveBeenCalledWith(['heater'], expect.objectContaining({ kind: 'overridden' }));
    expect(observer.contestedControl('heater', START + 30 * MINUTE_MS)?.kind).toBe('overridden');
  });

  it('counts a switched-back on/off the same way', () => {
    const { observer, record } = setup();
    observer.recordCommand('heater', { capabilityId: 'onoff', value: false }, heater(20, true), START);
    for (let i = 1; i <= CONTEST_THRESHOLD; i += 1) {
      const atMs = START + i * 5 * MINUTE_MS;
      observer.observeControlChange(heater(20), {
        deviceId: 'heater', observedAtMs: atMs - MINUTE_MS,
        changes: [{ capabilityId: 'onoff', previousValue: 'off', nextValue: 'on' }],
      });
      observer.recordCommand('heater', { capabilityId: 'onoff', value: false }, heater(20, true), atMs);
    }
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('does not count PELS reaching its own command, a late echo of an earlier one, or a device PELS never set', () => {
    const { record, setTarget, command } = setup();
    for (let i = 0; i < CONTEST_THRESHOLD * 2; i += 1) setTarget(START + i * MINUTE_MS, 18, 15);
    for (let i = 0; i < CONTEST_THRESHOLD * 2; i += 1) {
      const atMs = START + 10 * MINUTE_MS + i * 5 * MINUTE_MS;
      command(atMs, i % 2 === 0 ? 15 : 18);
      setTarget(atMs + 30_000, 18, 15);
    }
    expect(record).not.toHaveBeenCalled();
  });

  it('does not count a change PELS accepts rather than sets back', () => {
    const { observer, record, setTarget, command } = setup();
    command(START, 17);
    for (let i = 1; i <= CONTEST_THRESHOLD * 2; i += 1) {
      const atMs = START + i * 5 * MINUTE_MS;
      // Someone sets 20 and PELS never writes 17 again, or moves on to 21.
      setTarget(atMs, 17, 20);
      if (i % 2 === 0) command(atMs + 20_000, 21);
      if (i % 2 === 0) command(atMs + 4 * MINUTE_MS, 17);
    }
    expect(record).not.toHaveBeenCalled();
    expect(observer.contestedControl('heater', START + 60 * MINUTE_MS)).toBeUndefined();
  });

  it('forgets rounds older than the hour, and records a device at most once an hour', () => {
    const context = setup();
    const { record, command } = context;
    command(START, 17);
    for (let i = 0; i < CONTEST_THRESHOLD - 1; i += 1) round(context, START + i * 25 * MINUTE_MS);
    expect(record).not.toHaveBeenCalled();

    const steady = START + 3 * CONTEST_WINDOW_MS;
    for (let i = 0; i < CONTEST_THRESHOLD * 3; i += 1) round(context, steady + i * 5 * MINUTE_MS);
    expect(record).toHaveBeenCalledTimes(1);
    round(context, steady + CONTEST_WINDOW_MS + 15 * MINUTE_MS);
    expect(record).toHaveBeenCalledTimes(2);
  });
});
