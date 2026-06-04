import {
  buildShedActuator,
  planTerminalEnding,
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
    currentOn: true,
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

  it('falls back to binary_off via binaryControlObservation when controlCapabilityId is absent', () => {
    const command = resolveTerminalShedCommand(
      deviceWithoutTarget({
        controlCapabilityId: undefined,
        binaryControlObservation: {
          valid: true,
          capabilityId: 'onoff',
          observedValue: true,
          observedCapabilityIds: ['onoff'],
          observedAtMs: 0,
          source: 'snapshot_refresh',
        },
      }),
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
