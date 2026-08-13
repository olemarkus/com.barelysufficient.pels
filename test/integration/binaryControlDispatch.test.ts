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
    expect(store.has('charger-1')).toBe(false);
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
