import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import { createWitnessedActuator } from '../../lib/actuator/commandWitness';
import type { Actuator } from '../../lib/actuator/deviceActuator';
import { createMeterResponseTimings } from '../../lib/device/meterResponseTimings';
import { PRIOR_QUIET_MS } from '../../lib/device/meterResponseCapture';
import { WholeHomePowerObservationStream } from '../../lib/power/wholeHomePowerObservationStream';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';

const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const STEP_MS = 5_000;
const STREAM = 0;

/** The heater with its own direct reading, dated when the value last changed, as Homey dates it. */
const heater = (measuredPowerKw: number, measuredPowerObservedAtMs: number): DeviceSurfaces => ({
  id: 'heater', name: 'Hall heater', expectedPowerKw: 2, expectedPowerSource: 'manual',
  isEvCharger: false, isBatteryOrSolar: false,
  measuredPowerKw, measuredPowerObservedAtMs, measuredPowerIsDirectMeasurement: true,
}) as unknown as DeviceSurfaces;

/** A transport that accepts every switch at once. */
const acceptingActuator = (): Actuator => ({
  canTurnOnDevice: () => true,
  resolveTemperatureTarget: (_deviceId, desired) => desired,
  apply: async () => ({ requested: true, kind: 'binary', acknowledged: true }),
});

let capture: LoggerCapture;
beforeEach(() => {
  capture = captureLogger('info', []);
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
  capture.restore();
});

/**
 * The capture as wired: writes through the witnessed actuator, Main's readings
 * fed beside it, and the timings kept on the real repository over an in-memory
 * userdata database. The acceptance rules are unit-tested in
 * `meterResponseCapture.test.ts`.
 */
describe('meter response timings', () => {
  it.each(['identified', 'unidentified', 'switching'] as const)('times a shed and a restore on a %s stream', async (stream) => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    onTestFinished(() => db.close());
    const timings = createMeterResponseTimings(() => db);
    const actuator = createWitnessedActuator(acceptingActuator(), timings);
    const observations = new WholeHomePowerObservationStream();
    const meterDeviceId = stream === 'unidentified' ? undefined : 'meter-1';
    let observedMeter = meterDeviceId;
    let houseKw = 5;
    let heaterKw = 2;
    let heaterChangedAtMs = T0;
    let ripple = 0.01;
    const readFor = (durationMs: number): void => {
      const untilMs = Date.now() + durationMs;
      while (Date.now() < untilMs) {
        vi.advanceTimersByTime(STEP_MS);
        ripple = -ripple;
        timings.recordWholeHomeSample(
          observations.observe((houseKw + ripple) * 1000, undefined, observedMeter),
          Date.now(),
          () => [heater(heaterKw, heaterChangedAtMs)],
        );
      }
    };

    readFor(PRIOR_QUIET_MS + 60_000);
    vi.advanceTimersByTime(1_000);
    await actuator.apply({ kind: 'binary', deviceId: 'heater', desired: false });
    if (stream === 'switching') observedMeter = undefined;
    readFor(15_000);
    houseKw = 3;
    heaterKw = 0;
    heaterChangedAtMs = Date.now();
    readFor(PRIOR_QUIET_MS + 60_000);
    vi.advanceTimersByTime(1_000);
    await actuator.apply({ kind: 'binary', deviceId: 'heater', desired: true });
    observedMeter = meterDeviceId;
    readFor(25_000);
    houseKw = 5;
    heaterKw = 2;
    heaterChangedAtMs = Date.now();
    readFor(90_000);

    expect(capture.findEvents('meter_response_timed')).toEqual([
      expect.objectContaining({ deviceId: 'heater', direction: 'off', acceptedAfterMs: 0, figureKw: 2 }),
      expect.objectContaining({ deviceId: 'heater', direction: 'on', acceptedAfterMs: 0, figureKw: 2 }),
    ]);
    const nextRun = createMeterResponseTimings(() => db);
    expect(nextRun.readAll([{ id: 'heater', name: 'Hall heater' }], Date.now())).toEqual([
      expect.objectContaining({
        direction: 'on', samples: 1, medianResponseMs: 30_000, trusted: false, noChange: 0,
        medianResolutionMs: 5_000, medianAcceptedAfterMs: 0,
      }),
      expect.objectContaining({
        direction: 'off', samples: 1, medianResponseMs: 20_000, trusted: false, noChange: 0,
        medianResolutionMs: 5_000, medianAcceptedAfterMs: 0,
      }),
    ]);
  });

  it('contains a failing capture: the reading goes on, and the failure is said once', () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    onTestFinished(() => db.close());
    const timings = createMeterResponseTimings(() => db);
    const failingDevices = (): DeviceSurfaces[] => { throw new Error('device read failed'); };
    // Read for longer than the quiet period, so the capture asks for the devices.
    for (let atMs = T0; atMs <= T0 + PRIOR_QUIET_MS + 30_000; atMs += STEP_MS) {
      expect(() => timings.recordWholeHomeSample({ powerW: 3_000, streamGeneration: STREAM }, atMs, failingDevices))
        .not.toThrow();
    }
    expect(capture.findEvents('meter_response_capture_failed')).toHaveLength(1);
  });
});
