import {
  buildShedActuator,
  planTerminalEnding,
  readTerminalObserved,
  resolveTerminalShedCommand,
} from '../../setup/appInit/deferredObjectiveLifecycle';
import {
  applyShedBehavior,
  type ShedActuationCommand,
  type ShedActuationObservedState,
} from '../../lib/actuator/terminalShedActuation';
import { createDeviceActuator, type Actuator } from '../../lib/actuator/deviceActuator';
import type { ActuatorTransport } from '../../lib/actuator/deviceCommand';
import type { AppContext } from '../../lib/app/appContext';
import type { PlanInputDevice } from '../../lib/plan/planTypes';

const binaryOff: ShedActuationCommand = { kind: 'binary_off', capabilityId: 'onoff', flowBacked: false };
const setTemp: ShedActuationCommand = { kind: 'set_temperature', targetValue: 5 };
const setStep: ShedActuationCommand = {
  kind: 'set_step',
  profile: {
    model: 'stepped_load',
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: 1000 },
      { id: 'high', planningPowerW: 3000 },
    ],
  },
  targetStepId: 'low',
  planningCurrentA: 0,
};
const skip: ShedActuationCommand = { kind: 'skip', reasonCode: 'x' };

const observed = (state: Partial<ShedActuationObservedState>): ShedActuationObservedState => ({
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

  it('gives up (disarms) once the grace window has elapsed while still not settled', () => {
    // A device still observed `on` at the deadline keeps the task armed (above),
    // but the disarm grace bounds that: once elapsed, actuate one last time and
    // disarm so a device that never confirms off cannot pin the task forever.
    expect(planTerminalEnding(binaryOff, observed({ binaryState: 'on' }), true))
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

  it('actuates and waits while a stepped device is above the terminal shed step', () => {
    expect(planTerminalEnding(setStep, observed({ stepId: 'high' }), false))
      .toEqual({ actuate: true, disarm: false });
  });

  it('disarms once a stepped device is at or below the terminal shed step', () => {
    expect(planTerminalEnding(setStep, observed({ stepId: 'low' }), false))
      .toEqual({ actuate: false, disarm: true });
    expect(planTerminalEnding(setStep, observed({ stepId: 'off' }), false))
      .toEqual({ actuate: false, disarm: true });
  });

  it('disarms a skip command immediately (nothing to actuate)', () => {
    expect(planTerminalEnding(skip, observed({}), false))
      .toEqual({ actuate: false, disarm: true });
  });
});

describe('readTerminalObserved — 2-state read of the producer binaryControl.on bit', () => {
  const binaryDevice = (overrides: Partial<PlanInputDevice>): PlanInputDevice => ({
    id: 'b1',
    name: 'Water heater',
    binaryControl: { on: false },
    targets: [],
    ...overrides,
  } as PlanInputDevice);

  it('reports off when binaryControl.on is false', () => {
    expect(readTerminalObserved(binaryDevice({ binaryControl: { on: false } })).binaryState)
      .toBe('off');
  });

  it('reports on when binaryControl.on is true', () => {
    expect(readTerminalObserved(binaryDevice({ binaryControl: { on: true } })).binaryState)
      .toBe('on');
  });

  it('reads binaryControl.on directly — no observation-trust / staleness gate', () => {
    // binaryControl.on IS the trusted binary read (the producer latches prior
    // trusted evidence on a missing read). The terminal state read does NOT
    // re-derive trust from observationStale — that would reinvent the
    // binaryControlObservation coupling the producer owns. Stale-or-not, the read
    // is the bit. Commandability (`available`) is gated at the actuation decision,
    // not here.
    expect(readTerminalObserved(binaryDevice({ binaryControl: { on: true }, observationStale: true })).binaryState)
      .toBe('on');
    expect(readTerminalObserved(binaryDevice({ binaryControl: { on: false }, observationStale: true })).binaryState)
      .toBe('off');
    expect(readTerminalObserved(binaryDevice({ binaryControl: { on: false }, available: false })).binaryState)
      .toBe('off');
  });
});

describe('readTerminalObserved — EV charger reads the same 2-state binaryControl.on bit (de-coupled from raw plug state)', () => {
  // After the EV de-couple, an EV charger reads the SAME 2-state binaryControl.on
  // bit as a water heater — identical input shape, identical outputs, no
  // EV-specific case. binaryControl.on is the producer-resolved EV on/off
  // (resolveEvCurrentOn: only plugged_in_charging is "on").
  const evDevice = (overrides: Partial<PlanInputDevice>): PlanInputDevice => ({
    id: 'ev1',
    name: 'EV charger',
    deviceClass: 'evcharger',
    controlCapabilityId: 'evcharger_charging',
    binaryControl: { on: false },
    targets: [],
    ...overrides,
  } as PlanInputDevice);

  it('reports on for a charging EV (binaryControl.on true)', () => {
    expect(readTerminalObserved(evDevice({ binaryControl: { on: true } })).binaryState).toBe('on');
  });

  it('reports off for a not-charging EV (binaryControl.on false)', () => {
    expect(readTerminalObserved(evDevice({ binaryControl: { on: false } })).binaryState).toBe('off');
  });

  it('follows the producer-resolved binaryControl.on, ignoring the raw evChargingState string', () => {
    // Regression for the de-couple: readTerminalObserved reads the resolved bit
    // (state-authoritative for EV via resolveEvCurrentOn) and no longer re-derives
    // on/off from evChargingState. A contradictory raw string must not win.
    expect(readTerminalObserved(evDevice({ binaryControl: { on: true }, evChargingState: 'plugged_out' })).binaryState)
      .toBe('on');
    expect(readTerminalObserved(evDevice({ binaryControl: { on: false }, evChargingState: 'plugged_in_charging' })).binaryState)
      .toBe('off');
  });
});

describe('resolveTerminalShedCommand — set_temperature setpoint normalization', () => {
  const thermostat = (overrides: Partial<PlanInputDevice['targets'][number]> = {}): PlanInputDevice => ({
    id: 't1',
    name: 'Thermostat',
    binaryControl: { on: true },
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

  it('emits a set_temperature command when a present primary target exists (no regression)', () => {
    const command = resolveTerminalShedCommand(
      thermostat(),
      'temperature',
      { action: 'set_temperature', temperature: 18 },
      [],
    );
    expect(command).toEqual({ kind: 'set_temperature', targetValue: 18 });
  });
});

describe('resolveTerminalShedCommand — missing-target falls back to binary-off', () => {
  // A cap-off non-EV device whose persisted shed behavior says `set_temperature`
  // but whose primary target capability is absent from the snapshot (stale
  // behavior, or a thermostat/target cap that dropped out). Without the fallback
  // this resolved a `set_temperature` command that `applyShedBehavior` no-ops
  // every tick (no numeric observed target) until the disarm grace elapsed,
  // leaving the device running. It must use the binary handle instead.
  const deviceWithoutTarget = (
    overrides: Partial<PlanInputDevice> = {},
  ): PlanInputDevice => ({
    id: 'd1',
    name: 'Panel heater',
    binaryControl: { on: true },
    targets: [],
    controlCapabilityId: 'onoff',
    ...overrides,
  } as PlanInputDevice);

  it('falls back to binary_off via controlCapabilityId when set_temperature has no present target', () => {
    const command = resolveTerminalShedCommand(
      deviceWithoutTarget(),
      'temperature',
      { action: 'set_temperature', temperature: 5 },
      [],
    );
    expect(command).toEqual({ kind: 'binary_off', capabilityId: 'onoff', flowBacked: false });
  });

  it('actuates the binary handle off given an observed-on state (end-to-end via applyShedBehavior)', async () => {
    const command = resolveTerminalShedCommand(
      deviceWithoutTarget(),
      'temperature',
      { action: 'set_temperature', temperature: 5 },
      [],
    );
    const setCapability = vi.fn(async () => undefined);
    const actuator = createDeviceActuator({
      setCapability,
      applyDeviceTargets: vi.fn(async () => undefined),
      triggerFlowBackedBinaryControl: vi.fn(async () => undefined),
    });
    const wrote = await applyShedBehavior({
      deviceId: 'd1',
      name: 'Panel heater',
      command,
      observed: { binaryState: 'on', targetValue: null },
      actuator,
    });
    expect(wrote).toBe(true);
    expect(setCapability).toHaveBeenCalledWith('d1', 'onoff', false);
  });

  it('skips when set_temperature has no target AND no binary handle', () => {
    const command = resolveTerminalShedCommand(
      deviceWithoutTarget({ controlCapabilityId: undefined }),
      'temperature',
      { action: 'set_temperature', temperature: 5 },
      [],
    );
    expect(command).toEqual({ kind: 'skip', reasonCode: 'no_binary_handle_for_terminal_release' });
  });

  it('emits a stepped command for a stepped-only device with no binary handle', () => {
    const command = resolveTerminalShedCommand(
      deviceWithoutTarget({
        controlCapabilityId: undefined,
        controlModel: 'stepped_load',
        steppedLoadProfile: setStep.profile,
        reportedStepId: 'high',
      }),
      'temperature',
      { action: 'set_step', temperature: null, stepId: 'low' },
      [],
    );
    expect(command).toMatchObject({
      kind: 'set_step',
      targetStepId: 'low',
      previousStepId: 'high',
    });
  });

  it('still emits set_temperature when the primary target exists but its value is transiently absent', () => {
    // A PRESENT target whose `value` is only temporarily unreadable must keep its
    // setpoint command: `applyShedBehavior` no-ops while the observation is
    // non-numeric and the disarm grace keeps the task alive, so the setpoint
    // self-heals on the next snapshot. Falling through to binary-off (or skip)
    // here would abandon the configured setpoint shed — the guard keys on
    // capability PRESENCE, not on the value being readable this tick.
    const command = resolveTerminalShedCommand(
      deviceWithoutTarget({
        targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
      }),
      'temperature',
      { action: 'set_temperature', temperature: 5 },
      [],
    );
    expect(command).toEqual({ kind: 'set_temperature', targetValue: 5 });
  });

  it('emits set_temperature (not skip) for a target-only device whose value is transiently absent', () => {
    // The regression guard: a target-only thermostat (no binary handle) with a
    // present capability but a transiently-missing value must NOT resolve to
    // `skip` — `planTerminalEnding` disarms skip commands immediately, which would
    // drop the diagnostic before the value reappears and never apply the setpoint.
    const command = resolveTerminalShedCommand(
      deviceWithoutTarget({
        controlCapabilityId: undefined,
        targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
      }),
      'temperature',
      { action: 'set_temperature', temperature: 5 },
      [],
    );
    expect(command).toEqual({ kind: 'set_temperature', targetValue: 5 });
  });
});

describe('applyShedBehavior — stepped terminal release', () => {
  it('requests the target step and records the pending step when observed above target', async () => {
    const requestSteppedLoadStep = vi.fn(async () => ({ requested: true as const, transport: 'flow' as const }));
    const markSteppedLoadDesiredStepIssued = vi.fn();
    const actuator = createDeviceActuator({
      setCapability: vi.fn(async () => undefined),
      applyDeviceTargets: vi.fn(async () => undefined),
      triggerFlowBackedBinaryControl: vi.fn(async () => undefined),
      requestSteppedLoadStep,
    });

    const wrote = await applyShedBehavior({
      deviceId: 'stepped-1',
      name: 'Stepped heater',
      command: setStep,
      observed: { stepId: 'high' },
      actuator,
      markSteppedLoadDesiredStepIssued,
    });

    expect(wrote).toBe(true);
    expect(requestSteppedLoadStep).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'stepped-1',
      desiredStepId: 'low',
      planningPowerW: 1000,
      previousStepId: 'high',
    }));
    expect(markSteppedLoadDesiredStepIssued).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'stepped-1',
      desiredStepId: 'low',
      previousStepId: 'high',
    }));
  });

  it('does not step up when the observed step is already below the target', async () => {
    const requestSteppedLoadStep = vi.fn(async () => ({ requested: true as const, transport: 'flow' as const }));
    const actuator = createDeviceActuator({
      setCapability: vi.fn(async () => undefined),
      applyDeviceTargets: vi.fn(async () => undefined),
      triggerFlowBackedBinaryControl: vi.fn(async () => undefined),
      requestSteppedLoadStep,
    });

    const wrote = await applyShedBehavior({
      deviceId: 'stepped-1',
      name: 'Stepped heater',
      command: setStep,
      observed: { stepId: 'off' },
      actuator,
    });

    expect(wrote).toBe(false);
    expect(requestSteppedLoadStep).not.toHaveBeenCalled();
  });

  it('omits the optional stepped request wrapper when the device manager does not expose it', async () => {
    const ctx = {
      deviceManager: {
        setCapability: vi.fn(async () => undefined),
        applyDeviceTargets: vi.fn(async () => undefined),
      },
      deviceControlHelpers: {
        markSteppedLoadDesiredStepIssued: vi.fn(),
      },
      homey: {
        flow: { getTriggerCard: vi.fn() },
      },
    } as unknown as AppContext;

    const actuator = buildShedActuator(ctx);

    expect(actuator).not.toBeNull();
    // No stepped-load surface on the device manager → the actuator cannot issue a
    // step command, so applying one resolves false (the wrapper is omitted inside).
    await expect(applyShedBehavior({
      deviceId: 'stepped-1',
      name: 'Stepped heater',
      command: setStep,
      observed: observed({ stepId: 'high' }),
      actuator: actuator as Actuator,
      markSteppedLoadDesiredStepIssued: vi.fn(),
    })).resolves.toBe(false);
  });

  it('binds the optional stepped request wrapper to the device manager receiver', async () => {
    type StepRequestParams = Parameters<NonNullable<ActuatorTransport['requestSteppedLoadStep']>>[0];
    const deviceManager = {
      setCapability: vi.fn(async () => undefined),
      applyDeviceTargets: vi.fn(async () => undefined),
      requestSteppedLoadStep: vi.fn(async function request(this: unknown, _params: StepRequestParams) {
        if (this !== deviceManager) throw new Error('lost device manager receiver');
        return { requested: true as const, transport: 'flow' as const };
      }),
    };
    const ctx = {
      deviceManager,
      deviceControlHelpers: {
        markSteppedLoadDesiredStepIssued: vi.fn(),
      },
      homey: {
        flow: { getTriggerCard: vi.fn() },
      },
    } as unknown as AppContext;

    const actuator = buildShedActuator(ctx) as Actuator;
    const wrote = await applyShedBehavior({
      deviceId: 'stepped-1',
      name: 'Stepped heater',
      command: setStep,
      observed: observed({ stepId: 'high' }),
      actuator,
      markSteppedLoadDesiredStepIssued: vi.fn(),
    });

    expect(wrote).toBe(true);
    expect(deviceManager.requestSteppedLoadStep).toHaveBeenCalledTimes(1);
  });
});
