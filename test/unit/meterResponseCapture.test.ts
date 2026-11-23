import { describe, expect, it } from 'vitest';
import {
  MeterResponseCapture,
  PRIOR_QUIET_MS,
  WINDOW_MS,
  type MeterResponseOutcome,
} from '../../lib/device/meterResponseCapture';
import type { DeviceCommand } from '../../lib/actuator/deviceCommand';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';

const T0 = 1_800_000_000_000;
const STEP_MS = 5_000;
/** The command goes out after the capture has watched the meter for longer than the quiet period. */
const DISPATCH_AT = T0 + PRIOR_QUIET_MS + 61_000;
const STREAM = 0;

type DeviceFixture = {
  id: string;
  expectedPowerKw?: number;
  expectedPowerSource?: DeviceSurfaces['expectedPowerSource'];
  measuredPowerKw?: number;
  /** The reading comes from an energy counter, not a direct measurement. */
  derived?: true;
  isEvCharger?: boolean;
  isBatteryOrSolar?: boolean;
};

const binary = (deviceId: string, desired: boolean): DeviceCommand => ({ kind: 'binary', deviceId, desired });

/** A small alternating ripple, so a fast meter changes value at every reading. */
const ripple = (atMs: number): number => (Math.floor(atMs / STEP_MS) % 2 === 0 ? 0.01 : -0.01);

type Scene = {
  /** The home's draw at a reading. */
  houseKw: (atMs: number) => number;
  /** The home's devices at a reading. */
  devices: (atMs: number) => DeviceFixture[];
  generationKw?: (atMs: number) => number;
  stepMs?: (atMs: number) => number;
  streamGeneration?: (atMs: number) => number;
  command?: DeviceCommand;
  /** Extra writes, by when they go out. */
  otherCommands?: ReadonlyArray<{ atMs: number; command: DeviceCommand }>;
  acceptedAfterMs?: number;
  endAtMs?: number;
};

const heaterOn = binary('heater', true);
const heaterOff = binary('heater', false);

/**
 * The devices as Homey dates them: a reading keeps the time its value last
 * changed, so a steady draw reads old.
 */
const datedSurfaces = () => {
  const changedAtMs = new Map<string, { kw: number; atMs: number }>();
  return (fixtures: DeviceFixture[], atMs: number): DeviceSurfaces[] => fixtures.map(({ derived, ...fixture }) => {
    const { measuredPowerKw } = fixture;
    let observedAtMs: number | undefined;
    if (measuredPowerKw !== undefined) {
      const last = changedAtMs.get(fixture.id);
      if (last?.kw !== measuredPowerKw) changedAtMs.set(fixture.id, { kw: measuredPowerKw, atMs });
      observedAtMs = changedAtMs.get(fixture.id)!.atMs;
    }
    return {
      name: `Device ${fixture.id}`,
      expectedPowerKw: 2,
      expectedPowerSource: 'manual',
      isEvCharger: false,
      isBatteryOrSolar: false,
      ...fixture,
      ...(measuredPowerKw === undefined ? {} : {
        measuredPowerObservedAtMs: observedAtMs, measuredPowerIsDirectMeasurement: derived !== true,
      }),
    } as unknown as DeviceSurfaces;
  });
};

const playScene = (scene: Scene): { outcomes: MeterResponseOutcome[]; deviceReads: number } => {
  const capture = new MeterResponseCapture();
  const command = scene.command ?? heaterOn;
  const surfaces = datedSurfaces();
  const events = [
    { atMs: DISPATCH_AT, run: () => capture.commandDispatched(command, DISPATCH_AT) },
    ...(scene.acceptedAfterMs === undefined ? [] : [{
      atMs: DISPATCH_AT + scene.acceptedAfterMs,
      run: () => capture.commandSettled(command, {
        requested: true, kind: 'binary', acknowledged: true,
      }, DISPATCH_AT + (scene.acceptedAfterMs ?? 0)),
    }]),
    ...(scene.otherCommands ?? []).map(({ atMs, command: other }) => ({
      atMs, run: () => capture.commandDispatched(other, atMs),
    })),
  ].sort((a, b) => a.atMs - b.atMs);
  const endAtMs = scene.endAtMs ?? DISPATCH_AT + 3 * 60_000;
  let deviceReads = 0;
  let atMs = T0;
  while (atMs <= endAtMs) {
    while (events.length > 0 && events[0]!.atMs < atMs) events.shift()!.run();
    const generationKw = scene.generationKw?.(atMs);
    const readAtMs = atMs;
    capture.recordSample({
      powerW: (scene.houseKw(atMs) + ripple(atMs)) * 1000,
      streamGeneration: scene.streamGeneration?.(atMs) ?? STREAM,
      ...(generationKw === undefined ? {} : { generationW: generationKw * 1000 }),
    }, atMs, () => {
      deviceReads += 1;
      return surfaces(scene.devices(readAtMs), readAtMs);
    });
    atMs += scene.stepMs?.(atMs) ?? STEP_MS;
  }
  return { outcomes: capture.drainOutcomes(), deviceReads };
};

const runScene = (scene: Scene): MeterResponseOutcome[] => playScene(scene).outcomes;

/** The heater draws 2 kW from `startsAtMs` on; the rest of the home holds 3 kW. */
const turnOnScene = (startsAtMs: number, overrides: Partial<Scene> = {}): Scene => ({
  houseKw: (atMs) => (atMs >= startsAtMs ? 5 : 3),
  devices: () => [{ id: 'heater' }, { id: 'fridge', measuredPowerKw: 0.1 }],
  acceptedAfterMs: 800,
  ...overrides,
});

const droppedReason = (outcomes: MeterResponseOutcome[]): string | undefined => {
  const [outcome] = outcomes;
  return outcome?.kind === 'dropped' ? outcome.reason : outcome?.kind;
};

describe('MeterResponseCapture', () => {
  it('times a lone switch-on from dispatch to the first reading past half the change', () => {
    // Readings fall on whole 5 s steps from T0; the dispatch lands 1 s after one.
    const firstReadingAtNewLevel = DISPATCH_AT - 1_000 + 4 * STEP_MS;
    const outcomes = runScene(turnOnScene(firstReadingAtNewLevel - 2_000));
    expect(outcomes).toEqual([{
      kind: 'timed',
      deviceId: 'heater',
      deviceName: 'Device heater',
      direction: 'on',
      dispatchedAtMs: DISPATCH_AT,
      figureKw: 2,
      responseMs: firstReadingAtNewLevel - DISPATCH_AT,
      acceptedAfterMs: 800,
      resolutionMs: STEP_MS,
      changeKw: expect.closeTo(2, 1),
    }]);
  });

  it('discards an open measurement on a stream discontinuity', () => {
    const outcomes = runScene(turnOnScene(DISPATCH_AT + 20_000, {
      streamGeneration: (atMs) => (atMs < DISPATCH_AT + 10_000 ? STREAM : STREAM + 1),
    }));
    expect(droppedReason(outcomes)).toBe('meter_changed');
  });

  it('times a lone switch-off by the device\'s own direct reading, which agrees with the home', () => {
    const fallsAtMs = DISPATCH_AT + 30_000;
    const outcomes = runScene({
      command: heaterOff,
      houseKw: (atMs) => (atMs >= fallsAtMs ? 3 : 4.5),
      devices: (atMs) => [{ id: 'heater', measuredPowerKw: atMs >= fallsAtMs ? 0 : 1.5 }],
    });
    expect(outcomes).toEqual([expect.objectContaining({
      kind: 'timed', direction: 'off', figureKw: 1.5, changeKw: expect.closeTo(1.5, 1),
    })]);
    const [timed] = outcomes;
    expect(timed?.kind === 'timed' && timed.acceptedAfterMs).toBeUndefined();
    expect(timed?.kind === 'timed' && timed.responseMs).toBeGreaterThanOrEqual(30_000);
    expect(timed?.kind === 'timed' && timed.responseMs).toBeLessThan(30_000 + STEP_MS);
  });

  it('takes a derived reading for no own reading: the planning figure, and no say on timing', () => {
    const fallsAtMs = DISPATCH_AT + 30_000;
    const outcomes = runScene({
      command: heaterOff,
      houseKw: (atMs) => (atMs >= fallsAtMs ? 3 : 5),
      // An energy-counter reading that lags the switch by minutes.
      devices: (atMs) => [
        { id: 'heater', derived: true, measuredPowerKw: atMs >= DISPATCH_AT + 150_000 ? 0 : 1.2 },
        { id: 'fridge', derived: true, measuredPowerKw: atMs >= DISPATCH_AT + 15_000 ? 0.6 : 0.1 },
      ],
    });
    expect(outcomes).toEqual([expect.objectContaining({ kind: 'timed', direction: 'off', figureKw: 2 })]);
  });

  it('takes no time from a command sent while another write was recent', () => {
    // Within the quiet period no device is read, so the command is not even watched.
    expect(runScene(turnOnScene(DISPATCH_AT + 20_000, {
      otherCommands: [{ atMs: DISPATCH_AT - 60_000, command: binary('lamp', false) }],
    }))).toEqual([]);
  });

  it('drops a command when a write sent just before the steady period is still in flight', () => {
    const capture = new MeterResponseCapture();
    const surfaces = datedSurfaces();
    const lamp = binary('lamp', true);
    capture.commandDispatched(lamp, T0 - 1);
    for (let atMs = T0; atMs <= DISPATCH_AT; atMs += STEP_MS) {
      // The lamp's write settles once the capture already reads devices again.
      if (atMs === T0 + 330_000) capture.commandSettled(lamp, { requested: false }, atMs);
      const readAtMs = atMs;
      capture.recordSample({ powerW: (3 + ripple(atMs)) * 1000, streamGeneration: STREAM }, atMs, () => (
        surfaces([{ id: 'heater' }], readAtMs)
      ));
    }
    capture.commandDispatched(heaterOn, DISPATCH_AT + 1);
    expect(droppedReason(capture.drainOutcomes())).toBe('unsteady_before');
  });

  it('drops a watch when another write goes out before the change settles', () => {
    expect(droppedReason(runScene(turnOnScene(DISPATCH_AT + 20_000, {
      otherCommands: [{
        atMs: DISPATCH_AT + 40_000,
        command: { kind: 'target', target: 'temperature', deviceId: 'thermostat', value: 21 },
      }],
    })))).toBe('concurrent_command');
  });

  it('drops a watch when another device\'s own direct reading moves in the window', () => {
    expect(droppedReason(runScene(turnOnScene(DISPATCH_AT + 20_000, {
      devices: (atMs) => [
        { id: 'heater' },
        { id: 'fridge', measuredPowerKw: atMs >= DISPATCH_AT + 15_000 ? 0.6 : 0.1 },
      ],
    })))).toBe('other_device_moved');
  });

  it('drops a watch when production moves in the window', () => {
    expect(droppedReason(runScene(turnOnScene(DISPATCH_AT + 20_000, {
      generationKw: (atMs) => (atMs >= DISPATCH_AT + 15_000 ? 1.5 : 2),
    })))).toBe('generation_moved');
  });

  it('rejects a response when a later production observation explains the net move', () => {
    expect(droppedReason(runScene(turnOnScene(DISPATCH_AT + 20_000, {
      // The production poll catches up after net power already crossed the threshold.
      generationKw: (atMs) => (atMs >= DISPATCH_AT + 35_000 ? 0 : 2),
    })))).toBe('generation_moved');
  });

  it('drops a command when the home was not steady before it', () => {
    expect(droppedReason(runScene(turnOnScene(DISPATCH_AT + 20_000, {
      houseKw: (atMs) => {
        if (atMs >= DISPATCH_AT + 20_000) return 5;
        return atMs >= DISPATCH_AT - 30_000 ? 3.8 : 3;
      },
    })))).toBe('unsteady_before');
  });

  it('drops a change that comes back too small to be the device', () => {
    // The home rises past the threshold, then settles only 0.6 kW up for a 2 kW device.
    expect(droppedReason(runScene(turnOnScene(DISPATCH_AT + 20_000, {
      houseKw: (atMs) => {
        if (atMs < DISPATCH_AT + 20_000) return 3;
        return atMs < DISPATCH_AT + 40_000 ? 4.2 : 3.6;
      },
    })))).toBe('too_small');
  });

  it('drops a home that moves the wrong way', () => {
    expect(droppedReason(runScene(turnOnScene(DISPATCH_AT + 20_000, {
      houseKw: (atMs) => (atMs >= DISPATCH_AT + 20_000 ? 1.5 : 3),
    })))).toBe('wrong_direction');
  });

  it('takes no time from a slow meter', () => {
    expect(droppedReason(runScene(turnOnScene(DISPATCH_AT + 20_000, {
      stepMs: () => 30_000,
    })))).toBe('slow_meter');
  });

  it('takes no time from a fast poll of a meter whose value changes slowly', () => {
    // Read every 5 s, but the value only moves every 30 s.
    expect(droppedReason(runScene(turnOnScene(DISPATCH_AT + 20_000, {
      houseKw: (atMs) => (atMs >= DISPATCH_AT + 20_000 ? 5 : 3) - ripple(atMs)
        + (Math.floor(atMs / 30_000) % 2 === 0 ? 0.01 : -0.01),
    })))).toBe('slow_meter');
  });

  it('drops a sample when the device\'s own reading moves at a different time than the home', () => {
    expect(droppedReason(runScene(turnOnScene(DISPATCH_AT + 20_000, {
      devices: (atMs) => [{ id: 'heater', measuredPowerKw: atMs >= DISPATCH_AT + 70_000 ? 2 : 0 }],
    })))).toBe('own_reading_disagrees');
  });

  it('drops a sample when the device\'s own reading reports nothing after the command', () => {
    expect(droppedReason(runScene(turnOnScene(DISPATCH_AT + 20_000, {
      devices: () => [{ id: 'heater', measuredPowerKw: 0 }],
    })))).toBe('own_reading_silent');
  });

  it('counts no change only when the device\'s own reading shows it changed while the home did not', () => {
    const endAtMs = DISPATCH_AT + WINDOW_MS + 10_000;
    expect(runScene(turnOnScene(Number.POSITIVE_INFINITY, {
      endAtMs,
      devices: (atMs) => [{ id: 'heater', measuredPowerKw: atMs >= DISPATCH_AT + 20_000 ? 2 : 0 }],
    }))).toEqual([expect.objectContaining({ kind: 'no_change', deviceId: 'heater', direction: 'on' })]);
    // A thermostat kept it idle: its reading never moved, or it has none.
    expect(droppedReason(runScene(turnOnScene(Number.POSITIVE_INFINITY, {
      endAtMs, devices: () => [{ id: 'heater', measuredPowerKw: 0 }],
    })))).toBe('no_change_unverified');
    expect(droppedReason(runScene(turnOnScene(Number.POSITIVE_INFINITY, { endAtMs }))))
      .toBe('no_change_unverified');
  });

  it('watches no charger, battery, assumed figure or idle switch-off', () => {
    const silent = (devices: DeviceFixture[], command = heaterOn): MeterResponseOutcome[] => (
      runScene(turnOnScene(DISPATCH_AT + 20_000, { devices: () => devices, command }))
    );
    expect(silent([{ id: 'heater', isEvCharger: true }])).toEqual([]);
    expect(silent([{ id: 'heater', isBatteryOrSolar: true }])).toEqual([]);
    expect(silent([{ id: 'heater', expectedPowerSource: 'default' }])).toEqual([]);
    expect(silent([{ id: 'heater', expectedPowerKw: 0.2 }])).toEqual([]);
    expect(silent([{ id: 'heater', measuredPowerKw: 0 }], heaterOff)).toEqual([]);
  });

  it('reads no devices while PELS writes too often for any command to be watched', () => {
    const everyTwoMinutes = Array.from({ length: 10 }, (_, index) => ({
      atMs: T0 + 1_000 + index * 120_000, command: binary('lamp', index % 2 === 0),
    }));
    const { outcomes, deviceReads } = playScene(turnOnScene(DISPATCH_AT + 20_000, {
      otherCommands: everyTwoMinutes, endAtMs: T0 + 10 * 120_000,
    }));
    expect(deviceReads).toBe(0);
    expect(outcomes).toEqual([]);
  });

  it('drops a command that was not sent', () => {
    const capture = new MeterResponseCapture();
    const surfaces = datedSurfaces();
    for (let atMs = T0; atMs <= DISPATCH_AT; atMs += STEP_MS) {
      const readAtMs = atMs;
      capture.recordSample({ powerW: (3 + ripple(atMs)) * 1000, streamGeneration: STREAM }, atMs, () => (
        surfaces([{ id: 'heater' }], readAtMs)
      ));
    }
    capture.commandDispatched(heaterOn, DISPATCH_AT + 1);
    capture.commandSettled(heaterOn, { requested: false }, DISPATCH_AT + 2);
    expect(droppedReason(capture.drainOutcomes())).toBe('command_not_sent');
  });
});
