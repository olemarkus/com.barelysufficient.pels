import { planTerminalEnding, resolveTerminalShedCommand } from '../lib/app/appInit/deferredObjectiveLifecycle';
import type { ShedActuationCommand, ShedActuationObservedState } from '../lib/device/shedBehaviorActuation';
import type { PlanInputDevice } from '../lib/plan/planTypes';

const binaryOff: ShedActuationCommand = { kind: 'binary_off', capabilityId: 'onoff', flowBacked: false };
const setTemp: ShedActuationCommand = { kind: 'set_temperature', targetValue: 5 };
const skip: ShedActuationCommand = { kind: 'skip', reasonCode: 'x' };

const observed = (state: Partial<ShedActuationObservedState>): ShedActuationObservedState => ({
  binaryState: 'unknown',
  targetValue: null,
  ...state,
});

describe('planTerminalEnding (gated terminal-ending decision — the P1 fix)', () => {
  it('actuates and WAITS (no disarm) while a binary device is still observed on', () => {
    expect(planTerminalEnding(binaryOff, observed({ binaryState: 'on' }), false))
      .toEqual({ actuate: true, disarm: false });
  });

  it('disarms (no actuation) once the device is observed off — settled', () => {
    expect(planTerminalEnding(binaryOff, observed({ binaryState: 'off' }), false))
      .toEqual({ actuate: false, disarm: true });
  });

  it('keeps waiting (no disarm) on an unknown observation within the grace window — NOT single-shot', () => {
    // This is the core of the P1 fix: a transient `unknown` (e.g. post-restart)
    // must not let the task disarm on the first tick, or the release would be a
    // single shot that misses the device. Stay enabled and re-fire.
    expect(planTerminalEnding(binaryOff, observed({ binaryState: 'unknown' }), false))
      .toEqual({ actuate: true, disarm: false });
  });

  it('gives up (disarms) once the grace window has elapsed without settling', () => {
    expect(planTerminalEnding(binaryOff, observed({ binaryState: 'unknown' }), true))
      .toEqual({ actuate: true, disarm: true });
  });

  it('actuates and waits while a thermostat is away from its shed setpoint', () => {
    expect(planTerminalEnding(setTemp, observed({ targetValue: 21 }), false))
      .toEqual({ actuate: true, disarm: false });
  });

  it('disarms once the thermostat is already at the shed setpoint — settled', () => {
    expect(planTerminalEnding(setTemp, observed({ targetValue: 5 }), false))
      .toEqual({ actuate: false, disarm: true });
  });

  it('disarms a skip command immediately (nothing to actuate)', () => {
    expect(planTerminalEnding(skip, observed({}), false))
      .toEqual({ actuate: false, disarm: true });
  });
});

describe('resolveTerminalShedCommand — set_temperature setpoint normalization', () => {
  const thermostat = (overrides: Partial<PlanInputDevice['targets'][number]> = {}): PlanInputDevice => ({
    id: 't1',
    name: 'Thermostat',
    currentOn: true,
    targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5, value: 21, ...overrides }],
  } as PlanInputDevice);

  it('normalizes an out-of-range legacy shed setpoint to the capability bounds so it can settle', () => {
    // Without normalization, an out-of-range setpoint never equals the observed
    // (device-normalized) value, so isInShedPosture never settles and the task
    // re-issues the write every tick until the 5-min grace expires.
    const command = resolveTerminalShedCommand(
      thermostat(),
      'temperature',
      { action: 'set_temperature', temperature: -50 },
      [],
    );
    expect(command).toEqual({ kind: 'set_temperature', targetValue: 5 });
  });

  it('rounds the shed setpoint to the capability step', () => {
    const command = resolveTerminalShedCommand(
      thermostat(),
      'temperature',
      { action: 'set_temperature', temperature: 7.3 },
      [],
    );
    expect(command).toEqual({ kind: 'set_temperature', targetValue: 7.5 });
  });
});
