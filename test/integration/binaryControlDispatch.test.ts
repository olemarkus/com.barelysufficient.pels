import { createPlanEngineState } from '../../lib/plan/planState';
import { decideBinaryControl } from '../../lib/plan/planBinaryControl';
import {
  type BinaryControlTransport,
  decideAndDispatchBinaryControl,
  dispatchBinaryControlDecision,
} from '../../lib/executor/binaryControlDispatch';
import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import type { ActuatorTransport } from '../../lib/actuator/deviceCommand';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { withGetSnapshotByDeviceId } from '../utils/deviceObservationMock';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';

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

/**
 * Build a `BinaryControlTransport` whose write seam is a real actuator over the
 * provided `setCapability` / `triggerFlowBackedBinaryControl` mocks. Binary
 * dispatch routes through `actuator.apply`, so the underlying-mock assertions
 * (native → setCapability, flow → trigger-not-setCapability) are identical to
 * the pre-actuator transport's direct-method assertions.
 */
const buildTransport = (
  state: ReturnType<typeof createPlanEngineState>,
  ports: {
    setCapability: ActuatorTransport['setCapability'];
    triggerFlowBackedBinaryControl?: ActuatorTransport['triggerFlowBackedBinaryControl'];
  },
): BinaryControlTransport => {
  const rejectMissingTrigger = () => Promise.reject(new Error('Flow-backed control trigger is unavailable'));
  const actuator = createDeviceActuator({
    setCapability: ports.setCapability,
    applyDeviceTargets: () => Promise.resolve(),
    triggerFlowBackedBinaryControl: ports.triggerFlowBackedBinaryControl ?? rejectMissingTrigger,
  });
  return {
    observation: buildObservation(),
    pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
    actuator,
  };
};

describe('decideBinaryControl (plan-side decision producer)', () => {
  it('returns a populated decision without recording pending state (observer owns the writes)', () => {
    const state = createPlanEngineState();
    const observation = buildObservation();

    const decision = decideBinaryControl({
      pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
      deviceObservation: observation,
      deviceId: 'socket1',
      name: 'Socket',
      desired: true,
      snapshot: {
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        binaryControl: { on: false },
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
    });
    // Plan no longer touches pending state — dispatcher records it.
    expect(state.pendingBinaryCommands.socket1).toBeUndefined();
  });

  it('returns null and leaves pending state untouched when the snapshot already matches', () => {
    const state = createPlanEngineState();
    const observation = buildObservation();

    const decision = decideBinaryControl({
      pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
      deviceObservation: observation,
      deviceId: 'socket1',
      name: 'Socket',
      desired: true,
      snapshot: {
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        binaryControl: { on: true },
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
      pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
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
      flowBackedControl: true,
      reason: 'shedding',
    });
  });
});

describe('dispatchBinaryControlDecision (executor-side dispatcher)', () => {
  it('records pending, routes a native decision to setCapability, and emits success', async () => {
    const state = createPlanEngineState();
    const setCapability = vi.fn().mockResolvedValue(undefined);
    const transport = buildTransport(state, { setCapability });

    const result = await dispatchBinaryControlDecision({
      decision: {
        deviceId: 'socket1',
        name: 'Socket',
        capabilityId: 'onoff',
        desired: true,
        flowBackedControl: false,
        logContext: 'capacity',
        actuationMode: 'plan',
      },
      transport,
      snapshot: {
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
      },
    });

    expect(result).toEqual({ ok: true });
    expect(setCapability).toHaveBeenCalledWith('socket1', 'onoff', true);
    expect(state.pendingBinaryCommands.socket1).toMatchObject({
      capabilityId: 'onoff',
      desired: true,
      flowBackedControl: false,
      actuationMode: 'plan',
    });
    expect(logCapture.findEvent('binary_command_succeeded')).toMatchObject({
      deviceName: 'Socket',
      capabilityId: 'onoff',
      desired: true,
    });
  });

  it('routes a flow-backed decision through the trigger and skips setCapability', async () => {
    const state = createPlanEngineState();
    const setCapability = vi.fn().mockResolvedValue(undefined);
    const triggerFlowBackedBinaryControl = vi.fn().mockResolvedValue(undefined);
    const transport = buildTransport(state, { setCapability, triggerFlowBackedBinaryControl });

    const result = await dispatchBinaryControlDecision({
      decision: {
        deviceId: 'socket1',
        name: 'Socket',
        capabilityId: 'onoff',
        desired: false,
        flowBackedControl: true,
        logContext: 'capacity',
        actuationMode: 'plan',
      },
      transport,
      snapshot: {
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        flowBackedCapabilityIds: ['onoff'],
      },
    });

    expect(result).toEqual({ ok: true });
    expect(setCapability).not.toHaveBeenCalled();
    expect(triggerFlowBackedBinaryControl).toHaveBeenCalledWith('socket1', 'onoff', false);
    // The rich-param log line (formerly the trigger-call args) is hoisted to the
    // success path and read off the decision.
    expect(logCapture.findEvent('flow_backed_binary_command_requested')).toMatchObject({
      deviceId: 'socket1',
      deviceName: 'Socket',
      capabilityId: 'onoff',
      desired: false,
      logContext: 'capacity',
      actuationMode: 'plan',
    });
    expect(state.pendingBinaryCommands.socket1).toMatchObject({
      capabilityId: 'onoff',
      desired: false,
      flowBackedControl: true,
    });
  });

  it('clears the recorded pending entry when dispatch fails', async () => {
    const state = createPlanEngineState();
    const setCapability = vi.fn().mockRejectedValue(new Error('device unavailable'));
    const transport = buildTransport(state, { setCapability });

    const result = await dispatchBinaryControlDecision({
      decision: {
        deviceId: 'socket1',
        name: 'Socket',
        capabilityId: 'onoff',
        desired: true,
        flowBackedControl: false,
        logContext: 'capacity',
        actuationMode: 'plan',
      },
      transport,
      snapshot: {
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
      },
    });

    expect(result).toEqual({ ok: false, reason: 'dispatch_failed' });
    expect(state.pendingBinaryCommands.socket1).toBeUndefined();
    expect(logCapture.findEvent('binary_command_failed')).toMatchObject({
      reasonCode: 'device_manager_write_failed',
      deviceId: 'socket1',
    });
  });

  it('returns dispatch_failed when the flow trigger is missing', async () => {
    const state = createPlanEngineState();
    // No flow trigger wired: the actuator's flow-backed branch rejects, so the
    // dispatch fails the same way the old missing-trigger guard did.
    const transport = buildTransport(state, { setCapability: vi.fn() });

    const result = await dispatchBinaryControlDecision({
      decision: {
        deviceId: 'socket1',
        name: 'Socket',
        capabilityId: 'onoff',
        desired: true,
        flowBackedControl: true,
        logContext: 'capacity',
        actuationMode: 'plan',
      },
      transport,
      snapshot: {
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        flowBackedCapabilityIds: ['onoff'],
      },
    });

    expect(result).toEqual({ ok: false, reason: 'dispatch_failed' });
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
    const transport = buildTransport(state, { setCapability });

    const ok = await decideAndDispatchBinaryControl({
      transport,
      deviceId: 'socket1',
      name: 'Socket',
      desired: true,
      snapshot: {
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        canSetControl: true,
        binaryControl: { on: true }, // already matches
      },
      logContext: 'capacity',
    });

    expect(ok).toBe(false);
    expect(setCapability).not.toHaveBeenCalled();
  });
});
