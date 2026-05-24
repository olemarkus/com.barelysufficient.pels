import { createPlanEngineState } from '../lib/plan/planState';
import { decideBinaryControl } from '../lib/plan/planBinaryControl';
import {
  type BinaryControlTransport,
  decideAndDispatchBinaryControl,
  dispatchBinaryControlDecision,
} from '../lib/executor/binaryControlDispatch';
import { withGetSnapshotByDeviceId } from './utils/deviceObservationMock';
import { captureLogger, type LoggerCapture } from './utils/loggerCapture';

let logCapture: LoggerCapture;

beforeEach(() => {
  logCapture = captureLogger();
});

afterEach(() => {
  logCapture.restore();
});

const buildObservation = (snapshots: { id: string; currentOn?: boolean }[] = []) =>
  withGetSnapshotByDeviceId({
    getSnapshot: vi.fn().mockReturnValue(snapshots),
  });

describe('decideBinaryControl (plan-side decision producer)', () => {
  it('returns a populated decision and records pending state when the device should actuate', () => {
    const state = createPlanEngineState();
    const observation = buildObservation();

    const decision = decideBinaryControl({
      state,
      deviceObservation: observation,
      deviceId: 'socket1',
      name: 'Socket',
      desired: true,
      snapshot: {
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        currentOn: false,
      },
      logContext: 'capacity',
    });

    expect(decision).toEqual({
      deviceId: 'socket1',
      name: 'Socket',
      capabilityId: 'onoff',
      desired: true,
      flowBackedControl: false,
      logContext: 'capacity',
      actuationMode: 'plan',
      restoreSource: undefined,
      reason: undefined,
      isEv: false,
    });
    expect(state.pendingBinaryCommands.socket1).toMatchObject({
      capabilityId: 'onoff',
      desired: true,
      flowBackedControl: false,
      actuationMode: 'plan',
    });
  });

  it('returns null and leaves pending state untouched when the snapshot already matches', () => {
    const state = createPlanEngineState();
    const observation = buildObservation();

    const decision = decideBinaryControl({
      state,
      deviceObservation: observation,
      deviceId: 'socket1',
      name: 'Socket',
      desired: true,
      snapshot: {
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        currentOn: true,
      },
      logContext: 'capacity',
    });

    expect(decision).toBeNull();
    expect(state.pendingBinaryCommands.socket1).toBeUndefined();
  });

  it('marks EV decisions as flow-backed when the snapshot says so', () => {
    const state = createPlanEngineState();
    const observation = buildObservation();

    const decision = decideBinaryControl({
      state,
      deviceObservation: observation,
      deviceId: 'ev1',
      name: 'EV',
      desired: false,
      snapshot: {
        id: 'ev1',
        name: 'EV',
        controlCapabilityId: 'evcharger_charging',
        canSetControl: true,
        flowBackedCapabilityIds: ['evcharger_charging'],
        evChargingState: 'plugged_in_charging',
      },
      logContext: 'capacity',
      reason: 'shedding',
    });

    expect(decision).toMatchObject({
      isEv: true,
      flowBackedControl: true,
      reason: 'shedding',
    });
  });
});

describe('dispatchBinaryControlDecision (executor-side dispatcher)', () => {
  it('routes a native decision to setCapability and emits success', async () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands.socket1 = {
      capabilityId: 'onoff',
      desired: true,
      startedMs: Date.now(),
      pendingMs: 75_000,
      flowBackedControl: false,
      logContext: 'capacity',
      actuationMode: 'plan',
    };
    const setCapability = vi.fn().mockResolvedValue(undefined);
    const transport: BinaryControlTransport = {
      observation: buildObservation(),
      setCapability,
    };

    const ok = await dispatchBinaryControlDecision({
      decision: {
        deviceId: 'socket1',
        name: 'Socket',
        capabilityId: 'onoff',
        desired: true,
        flowBackedControl: false,
        logContext: 'capacity',
        actuationMode: 'plan',
        isEv: false,
      },
      transport,
      state,
    });

    expect(ok).toBe(true);
    expect(setCapability).toHaveBeenCalledWith('socket1', 'onoff', true);
    expect(state.pendingBinaryCommands.socket1).toBeDefined(); // pending stays until telemetry confirms
    expect(logCapture.findEvent('binary_command_succeeded')).toMatchObject({
      deviceName: 'Socket',
      capabilityId: 'onoff',
      desired: true,
    });
  });

  it('routes a flow-backed decision through the trigger and skips setCapability', async () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands.socket1 = {
      capabilityId: 'onoff',
      desired: false,
      startedMs: Date.now(),
      pendingMs: 75_000,
      flowBackedControl: true,
      logContext: 'capacity',
      actuationMode: 'plan',
    };
    const setCapability = vi.fn().mockResolvedValue(undefined);
    const triggerFlowBackedBinaryControlRequest = vi.fn().mockResolvedValue(undefined);
    const transport: BinaryControlTransport = {
      observation: buildObservation(),
      setCapability,
      triggerFlowBackedBinaryControlRequest,
    };

    const ok = await dispatchBinaryControlDecision({
      decision: {
        deviceId: 'socket1',
        name: 'Socket',
        capabilityId: 'onoff',
        desired: false,
        flowBackedControl: true,
        logContext: 'capacity',
        actuationMode: 'plan',
        isEv: false,
      },
      transport,
      state,
    });

    expect(ok).toBe(true);
    expect(setCapability).not.toHaveBeenCalled();
    expect(triggerFlowBackedBinaryControlRequest).toHaveBeenCalledWith({
      deviceId: 'socket1',
      name: 'Socket',
      capabilityId: 'onoff',
      desired: false,
      logContext: 'capacity',
      actuationMode: 'plan',
    });
  });

  it('clears the pre-recorded pending entry when dispatch fails', async () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands.socket1 = {
      capabilityId: 'onoff',
      desired: true,
      startedMs: Date.now(),
      pendingMs: 75_000,
      flowBackedControl: false,
      logContext: 'capacity',
      actuationMode: 'plan',
    };
    const setCapability = vi.fn().mockRejectedValue(new Error('device unavailable'));
    const transport: BinaryControlTransport = {
      observation: buildObservation(),
      setCapability,
    };

    const ok = await dispatchBinaryControlDecision({
      decision: {
        deviceId: 'socket1',
        name: 'Socket',
        capabilityId: 'onoff',
        desired: true,
        flowBackedControl: false,
        logContext: 'capacity',
        actuationMode: 'plan',
        isEv: false,
      },
      transport,
      state,
    });

    expect(ok).toBe(false);
    expect(state.pendingBinaryCommands.socket1).toBeUndefined();
    expect(logCapture.findEvent('binary_command_failed')).toMatchObject({
      reasonCode: 'device_manager_write_failed',
      deviceId: 'socket1',
    });
  });

  it('throws-and-clears when the flow trigger is missing', async () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands.socket1 = {
      capabilityId: 'onoff',
      desired: true,
      startedMs: Date.now(),
      pendingMs: 75_000,
      flowBackedControl: true,
      logContext: 'capacity',
      actuationMode: 'plan',
    };
    const transport: BinaryControlTransport = {
      observation: buildObservation(),
      setCapability: vi.fn(),
    };

    const ok = await dispatchBinaryControlDecision({
      decision: {
        deviceId: 'socket1',
        name: 'Socket',
        capabilityId: 'onoff',
        desired: true,
        flowBackedControl: true,
        logContext: 'capacity',
        actuationMode: 'plan',
        isEv: false,
      },
      transport,
      state,
    });

    expect(ok).toBe(false);
    expect(state.pendingBinaryCommands.socket1).toBeUndefined();
    expect(logCapture.findEvent('flow_backed_binary_command_failed')).toMatchObject({
      reasonCode: 'flow_trigger_failed',
    });
  });
});

describe('decideAndDispatchBinaryControl (executor-side convenience)', () => {
  it('returns false without invoking dispatch when the decision is null', async () => {
    const state = createPlanEngineState();
    const setCapability = vi.fn();
    const transport: BinaryControlTransport = {
      observation: buildObservation(),
      setCapability,
    };

    const ok = await decideAndDispatchBinaryControl({
      state,
      transport,
      deviceId: 'socket1',
      name: 'Socket',
      desired: true,
      snapshot: {
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        currentOn: true, // already matches
      },
      logContext: 'capacity',
    });

    expect(ok).toBe(false);
    expect(setCapability).not.toHaveBeenCalled();
  });
});
