import { planTerminalEnding, resolveTerminalShedCommand } from '../lib/app/appInit/deferredObjectiveLifecycle';
import { applyShedBehavior } from '../lib/device/shedBehaviorActuation';
import type {
  ShedActuationCommand,
  ShedActuationObservedState,
  ShedActuationTransport,
} from '../lib/device/shedBehaviorActuation';
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
    const transport: ShedActuationTransport = {
      setCapability,
      applyDeviceTargets: vi.fn(async () => undefined),
      triggerFlowBackedBinaryControl: vi.fn(async () => undefined),
    };
    const wrote = await applyShedBehavior({
      deviceId: 'd1',
      name: 'Panel heater',
      command,
      observed: { binaryState: 'on', targetValue: null },
      transport,
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
