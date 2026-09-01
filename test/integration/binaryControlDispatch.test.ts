import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeviceActuator } from '../../lib/actuator/deviceActuator';
import {
  decideAndDispatchBinaryControl,
  dispatchBinaryControlDecision,
  type BinaryControlTransport,
} from '../../lib/executor/binaryControlDispatch';
import {
  createPendingBinaryCommandStore,
  syncPendingBinaryCommands,
} from '../../lib/observer/pendingBinaryCommands';
import { createPlanEngineState } from '../../lib/plan/planState';
import { HomeyRequestTimeoutError } from '../../lib/utils/errorUtils';
import { withGetSnapshotByDeviceId } from '../utils/deviceObservationMock';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';

let logs: LoggerCapture;
beforeEach(() => { logs = captureLogger(); });
afterEach(() => { logs.restore(); });

const buildTransport = (
  requestBinaryControl = vi.fn(async () => undefined),
) => {
  const state = createPlanEngineState();
  const transport: BinaryControlTransport = {
    observation: withGetSnapshotByDeviceId({ getSnapshot: vi.fn(() => []) }),
    pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
    actuator: createDeviceActuator({
      requestBinaryControl,
      requestTemperatureTarget: vi.fn(async (_deviceId: string, desired: number) => desired),
      resolveTemperatureTarget: (_deviceId, desired) => desired,
      requestSteppedLoadStep: vi.fn(async () => ({ requested: false as const })),
    }),
  };
  return { requestBinaryControl, state, transport };
};

describe('binary command dispatch', () => {
  it('hands a semantic binary command to the actuator and records accepted dispatch immediately', async () => {
    const accepted = vi.fn();
    const { requestBinaryControl, state, transport } = buildTransport();
    transport.pendingBinaryCommandStore = createPendingBinaryCommandStore(
      state.pendingBinaryCommands,
      { onDispatchAccepted: accepted },
    );

    await expect(dispatchBinaryControlDecision({
      decision: {
        deviceId: 'device-1', name: 'Load', desired: true, logContext: 'capacity',
      },
      transport,
      snapshot: {
        targets: [], currentOn: false, canSetControl: true, communicationModel: 'local',
      },
    })).resolves.toEqual({ ok: true });

    expect(requestBinaryControl).toHaveBeenCalledWith('device-1', true);
    expect(state.pendingBinaryCommands['device-1']).toMatchObject({ desired: true, pendingMs: 90_000 });
    expect(accepted).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'device-1', desired: true }));
    expect(logs.findEvent('binary_command_succeeded')).toMatchObject({
      deviceId: 'device-1', desired: true, controlAxis: 'binary',
    });
  });

  it('uses the cloud confirmation window without changing the command path', async () => {
    const { requestBinaryControl, state, transport } = buildTransport();
    await dispatchBinaryControlDecision({
      decision: {
        deviceId: 'cloud-load', name: 'Cloud load', desired: false, logContext: 'capacity',
      },
      transport,
      snapshot: {
        targets: [], currentOn: true, canSetControl: true, communicationModel: 'cloud',
      },
    });

    expect(requestBinaryControl).toHaveBeenCalledWith('cloud-load', false);
    expect(state.pendingBinaryCommands['cloud-load']).toMatchObject({ desired: false, pendingMs: 180_000 });
  });

  it.each([
    ['Connected 300', 'heater-1'],
    ['Elbillader', 'charger-1'],
  ])('runs %s through the identical semantic decision and pending path', async (name, deviceId) => {
    const { requestBinaryControl, state, transport } = buildTransport();
    await expect(decideAndDispatchBinaryControl({
      transport,
      deviceId,
      name,
      desired: true,
      snapshot: { targets: [], currentOn: false, canSetControl: true, communicationModel: 'cloud' },
      logContext: 'capacity',
    })).resolves.toEqual({ applied: true });

    expect(requestBinaryControl).toHaveBeenCalledWith(deviceId, true);
    expect(state.pendingBinaryCommands[deviceId]).toMatchObject({ desired: true, pendingMs: 180_000 });
  });

  it('clears pending state and reports failure when transport rejects the semantic command', async () => {
    const failure = new Error('SDK write failed');
    const { state, transport } = buildTransport(vi.fn(async () => { throw failure; }));

    await expect(dispatchBinaryControlDecision({
      decision: {
        deviceId: 'device-1', name: 'Load', desired: false, logContext: 'capacity',
      },
      transport,
      snapshot: { targets: [], currentOn: true, binaryControl: { on: true }, canSetControl: true },
    })).resolves.toEqual({ ok: false, reason: 'dispatch_failed' });

    expect(state.pendingBinaryCommands['device-1']).toBeUndefined();
    expect(logs.findEvent('binary_command_failed')).toMatchObject({
      deviceId: 'device-1', desired: false, reasonCode: 'control_request_failed',
    });
  });

  // A timeout is the one rejection that does NOT mean "the command did not
  // happen": the socket was abandoned at our end while Homey may still be
  // pushing the write. Clearing pending here would claim knowledge PELS has not
  // earned and hand the next cycle a duplicate re-issue.
  it('keeps pending state and reports an unknown outcome when the write times out', async () => {
    const failed = vi.fn();
    const accepted = vi.fn();
    const timeout = new HomeyRequestTimeoutError('PUT', '/api/manager/devices/device/device-1/capability/onoff');
    const { state, transport } = buildTransport(vi.fn(async () => { throw timeout; }));
    transport.pendingBinaryCommandStore = createPendingBinaryCommandStore(
      state.pendingBinaryCommands,
      { onDispatchAccepted: accepted, onDispatchFailed: failed },
    );

    await expect(dispatchBinaryControlDecision({
      decision: {
        deviceId: 'device-1', name: 'Load', desired: true, logContext: 'capacity',
      },
      transport,
      snapshot: {
        targets: [], currentOn: false, canSetControl: true, communicationModel: 'local',
      },
    })).resolves.toEqual({ ok: true });

    expect(state.pendingBinaryCommands['device-1']).toMatchObject({ desired: true, pendingMs: 90_000 });
    expect(logs.findEvent('binary_command_outcome_unknown')).toMatchObject({
      deviceId: 'device-1', desired: true, reasonCode: 'control_request_timed_out', controlAxis: 'binary',
    });
    expect(logs.findEvent('binary_command_failed')).toBeUndefined();
    expect(logs.findEvent('binary_command_succeeded')).toBeUndefined();
    // The reachability backoff must come from the settle window expiring
    // (`onTimedOut`), not from a dispatch failure we cannot substantiate.
    expect(failed).not.toHaveBeenCalled();
    expect(accepted).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'device-1', desired: true }));
  });

  it('does not dispatch when the observer already reports the desired state', async () => {
    const { requestBinaryControl, transport } = buildTransport();
    await expect(decideAndDispatchBinaryControl({
      transport,
      deviceId: 'device-1',
      name: 'Load',
      desired: true,
      snapshot: { targets: [], currentOn: true, binaryControl: { on: true }, canSetControl: true },
      logContext: 'capacity',
    })).resolves.toEqual({ applied: false });
    expect(requestBinaryControl).not.toHaveBeenCalled();
  });

  it('settles a binary command from the producer-confirmed control-capability read', () => {
    const state = createPlanEngineState();
    const store = createPendingBinaryCommandStore(state.pendingBinaryCommands);
    const startedMs = Date.now();
    store.record('charger-1', { desired: true, startedMs, pendingMs: 90_000 });
    store.recordDispatchAccepted('charger-1', { deviceId: 'charger-1', desired: true });

    expect(syncPendingBinaryCommands({
      store,
      liveDevices: [{
        id: 'charger-1',
        name: 'Elbillader',
        binaryCommandConfirmation: {
          state: 'observed',
          observedValue: true,
          observedAtMs: startedMs + 1_000,
        },
      }],
      source: 'device_update',
    })).toBe(true);
    expect(store.peek('charger-1')).toBeUndefined();
  });

  // The load-bearing safety net. Keeping the entry armed on a timeout must not
  // cost PELS the escalating reachability backoff — it only defers it from the
  // transport timeout to the settle window, and `onTimedOut` reaches the very
  // same `recordFailure` that `onDispatchFailed` would have.
  it('still escalates an unacknowledged command when the settle window expires', async () => {
    const timedOut = vi.fn();
    const timeout = new HomeyRequestTimeoutError('PUT', '/api/manager/devices/device/device-1/capability/onoff');
    const { state, transport } = buildTransport(vi.fn(async () => { throw timeout; }));
    const store = createPendingBinaryCommandStore(
      state.pendingBinaryCommands,
      { onTimedOut: timedOut },
    );
    transport.pendingBinaryCommandStore = store;

    await expect(dispatchBinaryControlDecision({
      decision: {
        deviceId: 'device-1', name: 'Load', desired: true, logContext: 'capacity',
      },
      transport,
      snapshot: {
        targets: [], currentOn: false, canSetControl: true, communicationModel: 'local',
      },
    })).resolves.toEqual({ ok: true });
    expect(store.peek('device-1')).toMatchObject({ desired: true });

    // Age the entry past its own window; no telemetry ever arrived.
    const pending = state.pendingBinaryCommands['device-1'];
    state.pendingBinaryCommands['device-1'] = { ...pending, startedMs: pending.startedMs - 91_000 };

    syncPendingBinaryCommands({
      store,
      liveDevices: [{
        id: 'device-1', name: 'Load', binaryCommandConfirmation: { state: 'unavailable' },
      }],
      source: 'rebuild',
    });

    expect(timedOut).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'device-1' }));
    expect(store.peek('device-1')).toBeUndefined();
  });

  it('records pending before a fast asynchronous confirmation', async () => {
    const state = createPlanEngineState();
    const confirmed = vi.fn();
    let observedAtMs = 0;
    const store = createPendingBinaryCommandStore(state.pendingBinaryCommands, {
      onConfirmed: confirmed,
    });
    const actuator = createDeviceActuator({
      requestBinaryControl: async () => {
        const pending = store.peek('flow-load');
        expect(pending).toMatchObject({ desired: true });
        observedAtMs = pending?.startedMs ?? 0;
        syncPendingBinaryCommands({
          store,
          liveDevices: [{
            id: 'flow-load',
            name: 'Flow load',
            binaryCommandConfirmation: {
              state: 'observed',
              observedValue: true,
              observedAtMs,
            },
          }],
          source: 'device_update',
        });
      },
      requestTemperatureTarget: async (_deviceId, desired) => desired,
      resolveTemperatureTarget: (_deviceId, desired) => desired,
      requestSteppedLoadStep: async () => ({ requested: false }),
    });
    const transport: BinaryControlTransport = {
      observation: withGetSnapshotByDeviceId({ getSnapshot: vi.fn(() => []) }),
      pendingBinaryCommandStore: store,
      actuator,
    };

    await expect(dispatchBinaryControlDecision({
      decision: {
        deviceId: 'flow-load', name: 'Flow load', desired: true, logContext: 'capacity',
      },
      transport,
      snapshot: { targets: [], currentOn: false, canSetControl: true },
    })).resolves.toEqual({ ok: true });

    expect(confirmed).toHaveBeenCalledOnce();
    expect(store.peek('flow-load')).toBeUndefined();
  });

  it('does not settle an early echo when the transport later rejects', async () => {
    const state = createPlanEngineState();
    const confirmed = vi.fn();
    const store = createPendingBinaryCommandStore(state.pendingBinaryCommands, { onConfirmed: confirmed });
    const { transport } = buildTransport(vi.fn(async () => {
      const pending = store.peek('flow-load');
      syncPendingBinaryCommands({
        store,
        liveDevices: [{
          id: 'flow-load', name: 'Flow load',
          binaryCommandConfirmation: {
            state: 'observed', observedValue: true, observedAtMs: pending?.startedMs ?? 0,
          },
        }],
        source: 'device_update',
      });
      throw new Error('rejected after echo');
    }));
    transport.pendingBinaryCommandStore = store;

    await expect(dispatchBinaryControlDecision({
      decision: { deviceId: 'flow-load', name: 'Flow load', desired: true, logContext: 'capacity' },
      transport,
    })).resolves.toEqual({ ok: false, reason: 'dispatch_failed' });

    expect(confirmed).not.toHaveBeenCalled();
    expect(store.peek('flow-load')).toBeUndefined();
  });

  // The mirror image of the test above, and the reason the two branches must be
  // told apart. A rejection makes the early echo untrustworthy — the transport
  // said the command did not happen. A timeout says nothing, so the echo is the
  // best evidence available: the device reporting the value we asked for.
  it('settles an early echo when the write times out', async () => {
    const state = createPlanEngineState();
    const confirmed = vi.fn();
    const store = createPendingBinaryCommandStore(state.pendingBinaryCommands, { onConfirmed: confirmed });
    const { transport } = buildTransport(vi.fn(async () => {
      const pending = store.peek('flow-load');
      syncPendingBinaryCommands({
        store,
        liveDevices: [{
          id: 'flow-load', name: 'Flow load',
          binaryCommandConfirmation: {
            state: 'observed', observedValue: true, observedAtMs: pending?.startedMs ?? 0,
          },
        }],
        source: 'device_update',
      });
      throw new HomeyRequestTimeoutError('PUT', '/api/manager/devices/device/flow-load/capability/onoff');
    }));
    transport.pendingBinaryCommandStore = store;

    await expect(dispatchBinaryControlDecision({
      decision: { deviceId: 'flow-load', name: 'Flow load', desired: true, logContext: 'capacity' },
      transport,
    })).resolves.toEqual({ ok: true });

    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it('does not settle an early echo after command authority is lost', async () => {
    const state = createPlanEngineState();
    const confirmed = vi.fn();
    const store = createPendingBinaryCommandStore(state.pendingBinaryCommands, { onConfirmed: confirmed });
    const { transport } = buildTransport(vi.fn(async () => {
      const pending = store.peek('flow-load');
      syncPendingBinaryCommands({
        store,
        liveDevices: [{
          id: 'flow-load', name: 'Flow load',
          binaryCommandConfirmation: {
            state: 'observed', observedValue: true, observedAtMs: pending?.startedMs ?? 0,
          },
        }],
        source: 'device_update',
      });
    }));
    transport.pendingBinaryCommandStore = store;

    await expect(dispatchBinaryControlDecision({
      decision: { deviceId: 'flow-load', name: 'Flow load', desired: true, logContext: 'capacity' },
      transport,
      isAuthorityCurrent: () => false,
    })).resolves.toEqual({ ok: false, reason: 'not_requested' });

    expect(confirmed).not.toHaveBeenCalled();
    expect(store.peek('flow-load')).toBeUndefined();
  });

  it('does not replay an early match after newer contradictory telemetry', async () => {
    const state = createPlanEngineState();
    const confirmed = vi.fn();
    const store = createPendingBinaryCommandStore(state.pendingBinaryCommands, { onConfirmed: confirmed });
    const { transport } = buildTransport(vi.fn(async () => {
      const pending = store.peek('flow-load');
      const observedAtMs = pending?.startedMs ?? 0;
      syncPendingBinaryCommands({
        store,
        liveDevices: [{
          id: 'flow-load', name: 'Flow load',
          binaryCommandConfirmation: { state: 'observed', observedValue: true, observedAtMs },
        }],
        source: 'device_update',
      });
      syncPendingBinaryCommands({
        store,
        liveDevices: [{
          id: 'flow-load', name: 'Flow load',
          binaryCommandConfirmation: { state: 'observed', observedValue: false, observedAtMs: observedAtMs + 1 },
        }],
        source: 'device_update',
      });
    }));
    transport.pendingBinaryCommandStore = store;

    await expect(dispatchBinaryControlDecision({
      decision: { deviceId: 'flow-load', name: 'Flow load', desired: true, logContext: 'capacity' },
      transport,
    })).resolves.toEqual({ ok: true });

    expect(confirmed).not.toHaveBeenCalled();
    expect(store.peek('flow-load')).toMatchObject({ dispatchState: 'accepted', desired: true });
  });
});
