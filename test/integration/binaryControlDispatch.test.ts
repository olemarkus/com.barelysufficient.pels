import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayMeterObservation } from '../../lib/ports/nativeRelay';
import { RelayShedRecovery } from '../../lib/executor/relayShedRecovery';
import type { PlannedBinaryCommand, RelayShedDecision } from '../../lib/planContract/executionPlan';
import { createDeviceActuator, type Actuator } from '../../lib/actuator/deviceActuator';
import {
  decideAndDispatchBinaryControl,
  dispatchBinaryControlDecision,
  type BinaryControlTransport,
} from '../../lib/executor/binaryControlDispatch';
import {
  createPendingBinaryCommandStore,
  syncPendingBinaryCommands,
} from '../../lib/observer/pendingBinaryCommands';
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../../lib/ports/controlCommandConfirmation';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { HomeyRequestTimeoutError } from '../../lib/utils/errorUtils';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import { noStorageTransport } from '../helpers/storageTransportStub';

let logs: LoggerCapture;
beforeEach(() => { logs = captureLogger(); });
afterEach(() => { logs.restore(); });

const buildTransport = (
  requestBinaryControl = vi.fn(async () => undefined),
) => {
  const state = createPlanEngineState();
  const transport: BinaryControlTransport = {
    getObservedState: () => undefined,
    pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
    actuator: createDeviceActuator({
requestChargingPhaseControl: async () => false,
requestProductionControl: async () => { throw new Error('Unexpected inverter control'); },
requestTargetPowerControlClaim: async () => ({ kind: 'not_sent' as const }),
      requestBinaryControl,
      requestTemperatureTarget: vi.fn(async (_deviceId: string, desired: number) => desired),
      canTurnOnDevice: () => true,
      resolveTemperatureTarget: (_deviceId, desired) => desired,
      requestSteppedLoadStep: vi.fn(async () => ({ requested: false as const })),
      ...noStorageTransport,
    }),
    isAuthorityCurrent: () => true,
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
    })).resolves.toEqual({ ok: true });

    expect(requestBinaryControl).toHaveBeenCalledWith('device-1', true);
    expect(state.pendingBinaryCommands['device-1']).toMatchObject({ desired: true });
    expect(accepted).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'device-1', desired: true }));
    expect(logs.findEvent('binary_command_succeeded')).toMatchObject({
      deviceId: 'device-1', desired: true, controlAxis: 'binary',
    });
  });

  it.each([
    ['Connected 300', 'heater-1'],
    ['Elbillader', 'charger-1'],
  ])('runs %s through the identical semantic decision and pending path', async (name, deviceId) => {
    const { requestBinaryControl, state, transport } = buildTransport();
    await expect(decideAndDispatchBinaryControl(
      transport,
      { deviceId, name, desired: true, logContext: 'capacity' },
      { targets: [], currentOn: false, canSetControl: true },
    )).resolves.toEqual({ applied: true });

    expect(requestBinaryControl).toHaveBeenCalledWith(deviceId, true);
    expect(state.pendingBinaryCommands[deviceId]).toMatchObject({ desired: true });
  });

  it('clears pending state and reports failure when transport rejects the semantic command', async () => {
    const failure = new Error('SDK write failed');
    const { state, transport } = buildTransport(vi.fn(async () => { throw failure; }));

    await expect(dispatchBinaryControlDecision({
      decision: {
        deviceId: 'device-1', name: 'Load', desired: false, logContext: 'capacity',
      },
      transport,
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
    })).resolves.toEqual({ ok: true });

    expect(state.pendingBinaryCommands['device-1']).toMatchObject({ desired: true });
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
    await expect(decideAndDispatchBinaryControl(
      transport,
      { deviceId: 'device-1', name: 'Load', desired: true, logContext: 'capacity' },
      { targets: [], currentOn: true, binaryControl: { on: true }, canSetControl: true },
    )).resolves.toEqual({ applied: false });
    expect(requestBinaryControl).not.toHaveBeenCalled();
  });

  it.each([
    [false, false],
    [true, true],
  ])('uses the supplied snapshot only for lifecycle release=%s', async (lifecycleRelease, applied) => {
    const { requestBinaryControl, transport } = buildTransport();
    transport.getObservedState = () => ({ binaryControl: { on: false } });

    await expect(decideAndDispatchBinaryControl(
      transport,
      { deviceId: 'device-1', name: 'Load', desired: false, logContext: 'capacity', lifecycleRelease },
      { targets: [], binaryControl: { on: true }, canSetControl: true },
    )).resolves.toEqual({ applied });
    expect(requestBinaryControl).toHaveBeenCalledTimes(applied ? 1 : 0);
  });

  it('suppresses a matching pending command before it is observed', async () => {
    const { requestBinaryControl, transport } = buildTransport();
    transport.pendingBinaryCommandStore.record('device-1', { desired: true, startedMs: Date.now() });

    await expect(decideAndDispatchBinaryControl(
      transport,
      { deviceId: 'device-1', name: 'Load', desired: true, logContext: 'capacity' },
      { targets: [], binaryControl: { on: false }, canSetControl: true },
    )).resolves.toEqual({ applied: false });
    expect(requestBinaryControl).not.toHaveBeenCalled();
    expect(logs.findEvent('binary_command_skipped')).toMatchObject({ reasonCode: 'already_pending' });
  });

  it('supersedes an opposite pending command even when observation already matches', async () => {
    const { requestBinaryControl, state, transport } = buildTransport();
    transport.pendingBinaryCommandStore.record('device-1', { desired: true, startedMs: Date.now() });

    await expect(decideAndDispatchBinaryControl(
      transport,
      { deviceId: 'device-1', name: 'Load', desired: false, logContext: 'capacity' },
      { targets: [], binaryControl: { on: false }, canSetControl: true },
    )).resolves.toEqual({ applied: true });
    expect(requestBinaryControl).toHaveBeenCalledWith('device-1', false);
    expect(state.pendingBinaryCommands['device-1']).toMatchObject({ desired: false });
  });

  it('settles a binary command from the producer-confirmed control-capability read', () => {
    const state = createPlanEngineState();
    const store = createPendingBinaryCommandStore(state.pendingBinaryCommands);
    const startedMs = Date.now();
    store.record('charger-1', { desired: true, startedMs });
    store.recordDispatchAccepted('charger-1', { deviceId: 'charger-1', desired: true });

    expect(syncPendingBinaryCommands(
      store,
      [{
        id: 'charger-1',
        name: 'Elbillader',
        binaryCommandConfirmation: {
          state: 'observed',
          observedValue: true,
          observedAtMs: startedMs + 1_000,
        },
      }],
      'device_update',
    )).toBe(true);
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
    })).resolves.toEqual({ ok: true });
    expect(store.peek('device-1')).toMatchObject({ desired: true });

    // Age the entry past its own window; no telemetry ever arrived.
    const pending = state.pendingBinaryCommands['device-1'];
    state.pendingBinaryCommands['device-1'] = { ...pending, startedMs: pending.startedMs - 91_000 };

    syncPendingBinaryCommands(
      store,
      [{
        id: 'device-1', name: 'Load', binaryCommandConfirmation: { state: 'unavailable' },
      }],
      'rebuild',
    );

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
requestChargingPhaseControl: async () => false,
requestProductionControl: async () => { throw new Error('Unexpected inverter control'); },
requestTargetPowerControlClaim: async () => ({ kind: 'not_sent' as const }),
      requestBinaryControl: async () => {
        const pending = store.peek('flow-load');
        expect(pending).toMatchObject({ desired: true });
        observedAtMs = pending?.startedMs ?? 0;
        syncPendingBinaryCommands(
          store,
          [{
            id: 'flow-load',
            name: 'Flow load',
            binaryCommandConfirmation: {
              state: 'observed',
              observedValue: true,
              observedAtMs,
            },
          }],
          'device_update',
        );
      },
      requestTemperatureTarget: async (_deviceId, desired) => desired,
      canTurnOnDevice: () => true,
      resolveTemperatureTarget: (_deviceId, desired) => desired,
      requestSteppedLoadStep: async () => ({ requested: false }),
      ...noStorageTransport,
    });
    const transport: BinaryControlTransport = {
      getObservedState: () => undefined,
      pendingBinaryCommandStore: store,
      actuator,
      isAuthorityCurrent: () => true,
    };

    await expect(dispatchBinaryControlDecision({
      decision: {
        deviceId: 'flow-load', name: 'Flow load', desired: true, logContext: 'capacity',
      },
      transport,
    })).resolves.toEqual({ ok: true });

    // The echo landed while the request was still dispatching, so it did not
    // settle inside the call — observer settlement may only commit once
    // transport has accepted. It is not lost, and nothing was parked to replay
    // it: `binaryCommandConfirmation` projects the device's CURRENT value, so
    // the next sweep sees the same echo against an accepted entry and confirms
    // it there. The pending entry survives the gap, so
    // `isBinaryChangeAttributableToPels` stays true throughout and no
    // PELS-actuation provenance window opens.
    expect(confirmed).not.toHaveBeenCalled();
    syncPendingBinaryCommands(
      store,
      [{
        id: 'flow-load',
        name: 'Flow load',
        binaryCommandConfirmation: { state: 'observed', observedValue: true, observedAtMs: observedAtMs },
      }],
      'rebuild',
    );

    expect(confirmed).toHaveBeenCalledOnce();
    expect(store.peek('flow-load')).toBeUndefined();
  });

  it('does not settle an early echo when the transport later rejects', async () => {
    const state = createPlanEngineState();
    const confirmed = vi.fn();
    const store = createPendingBinaryCommandStore(state.pendingBinaryCommands, { onConfirmed: confirmed });
    const { transport } = buildTransport(vi.fn(async () => {
      const pending = store.peek('flow-load');
      syncPendingBinaryCommands(
        store,
        [{
          id: 'flow-load', name: 'Flow load',
          binaryCommandConfirmation: {
            state: 'observed', observedValue: true, observedAtMs: pending?.startedMs ?? 0,
          },
        }],
        'device_update',
      );
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
    let timedOutStartedMs = 0;
    const store = createPendingBinaryCommandStore(state.pendingBinaryCommands, { onConfirmed: confirmed });
    const { transport } = buildTransport(vi.fn(async () => {
      const pending = store.peek('flow-load');
      timedOutStartedMs = pending?.startedMs ?? 0;
      syncPendingBinaryCommands(
        store,
        [{
          id: 'flow-load', name: 'Flow load',
          binaryCommandConfirmation: {
            state: 'observed', observedValue: true, observedAtMs: pending?.startedMs ?? 0,
          },
        }],
        'device_update',
      );
      throw new HomeyRequestTimeoutError('PUT', '/api/manager/devices/device/flow-load/capability/onoff');
    }));
    transport.pendingBinaryCommandStore = store;

    await expect(dispatchBinaryControlDecision({
      decision: { deviceId: 'flow-load', name: 'Flow load', desired: true, logContext: 'capacity' },
      transport,
    })).resolves.toEqual({ ok: true });

    // The echo landed while the request was still dispatching, so it did not
    // settle inside the call — observer settlement may only commit once
    // transport has accepted. It is not lost, and nothing was parked to replay
    // it: `binaryCommandConfirmation` projects the device's CURRENT value, so
    // the next sweep sees the same echo against an accepted entry and confirms
    // it there. The pending entry survives the gap, so
    // `isBinaryChangeAttributableToPels` stays true throughout and no
    // PELS-actuation provenance window opens.
    expect(confirmed).not.toHaveBeenCalled();
    syncPendingBinaryCommands(
      store,
      [{
        id: 'flow-load',
        name: 'Flow load',
        binaryCommandConfirmation: { state: 'observed', observedValue: true, observedAtMs: timedOutStartedMs },
      }],
      'rebuild',
    );

    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(store.peek('flow-load')).toBeUndefined();
  });

  it('does not settle an early echo after command authority is lost', async () => {
    const state = createPlanEngineState();
    const confirmed = vi.fn();
    const store = createPendingBinaryCommandStore(state.pendingBinaryCommands, { onConfirmed: confirmed });
    const { transport } = buildTransport(vi.fn(async () => {
      const pending = store.peek('flow-load');
      syncPendingBinaryCommands(
        store,
        [{
          id: 'flow-load', name: 'Flow load',
          binaryCommandConfirmation: {
            state: 'observed', observedValue: true, observedAtMs: pending?.startedMs ?? 0,
          },
        }],
        'device_update',
      );
    }));
    transport.pendingBinaryCommandStore = store;
    transport.isAuthorityCurrent = () => false;

    await expect(dispatchBinaryControlDecision({
      decision: { deviceId: 'flow-load', name: 'Flow load', desired: true, logContext: 'capacity' },
      transport,
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
      syncPendingBinaryCommands(
        store,
        [{
          id: 'flow-load', name: 'Flow load',
          binaryCommandConfirmation: { state: 'observed', observedValue: true, observedAtMs },
        }],
        'device_update',
      );
      syncPendingBinaryCommands(
        store,
        [{
          id: 'flow-load', name: 'Flow load',
          binaryCommandConfirmation: { state: 'observed', observedValue: false, observedAtMs: observedAtMs + 1 },
        }],
        'device_update',
      );
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

// The paths where the mechanism does NOT complete. An echo arriving before
// transport acceptance used to park a closure that `recordDispatchAccepted`
// replayed; nothing is parked now, so these pin what happens when acceptance
// never arrives, when the evidence is contradicted, and when a newer command
// takes the entry over.
describe('binary command settlement — when the handshake does not complete', () => {
  const echo = (observedValue: boolean, observedAtMs: number) => ([{
    id: 'flow-load',
    name: 'Flow load',
    binaryCommandConfirmation: { state: 'observed' as const, observedValue, observedAtMs },
  }]);

  const sweep = (
    store: ReturnType<typeof createPendingBinaryCommandStore>,
    observedValue: boolean,
    observedAtMs: number,
  ): boolean => syncPendingBinaryCommands(
    store,
    echo(observedValue, observedAtMs),
    'rebuild',
  );

  it('never confirms while transport acceptance never arrives, then times out once', () => {
    const state = createPlanEngineState();
    const confirmed = vi.fn();
    const timedOut = vi.fn();
    const store = createPendingBinaryCommandStore(
      state.pendingBinaryCommands,
      { onConfirmed: confirmed, onTimedOut: timedOut },
    );
    const startedMs = Date.now();
    store.record('flow-load', { desired: true, startedMs });

    // Matching echo, but the request is still 'dispatching' — settlement waits.
    expect(sweep(store, true, startedMs)).toBe(false);
    expect(confirmed).not.toHaveBeenCalled();
    expect(store.peek('flow-load')).toBeDefined();

    // The window expires with acceptance still absent. Exactly one timeout.
    // Restored below: the repo's Vitest config clears mocks but does not RESTORE
    // them, so a lingering `Date.now` stub would bleed into later specs.
    const nowSpy = vi.spyOn(Date, 'now')
      .mockReturnValue(startedMs + CONTROL_COMMAND_CONFIRMATION_MS + 1);
    expect(sweep(store, true, startedMs)).toBe(true);
    expect(timedOut).toHaveBeenCalledTimes(1);
    expect(confirmed).not.toHaveBeenCalled();
    expect(store.peek('flow-load')).toBeUndefined();
    // The entry is gone, so a further sweep re-fires nothing.
    expect(sweep(store, true, startedMs)).toBe(false);
    expect(timedOut).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });

  it('lets a later contradiction supersede an echo seen before acceptance', () => {
    const state = createPlanEngineState();
    const confirmed = vi.fn();
    const store = createPendingBinaryCommandStore(
      state.pendingBinaryCommands,
      { onConfirmed: confirmed },
    );
    const startedMs = Date.now();
    store.record('flow-load', { desired: true, startedMs });

    sweep(store, true, startedMs);
    sweep(store, false, startedMs + 1);
    // Acceptance now arrives. With nothing parked there is no stale evidence to
    // replay, and the device's current value disagrees, so it stays pending.
    store.recordDispatchAccepted('flow-load', { deviceId: 'flow-load', desired: true });
    expect(confirmed).not.toHaveBeenCalled();
    expect(store.peek('flow-load')).toMatchObject({ desired: true, lastObservedValue: false });
  });

  it('does not let a superseded command confirm against the one that replaced it', () => {
    // `record` replaces the entry. The old design left a parked closure behind
    // it, so acceptance of the NEW command could fire the OLD one's confirm —
    // stamping PELS-actuation provenance from a stale desired value and
    // clearing the live entry. Nothing outlives its entry now.
    const state = createPlanEngineState();
    const confirmed = vi.fn();
    const store = createPendingBinaryCommandStore(
      state.pendingBinaryCommands,
      { onConfirmed: confirmed },
    );
    const startedMs = Date.now();
    store.record('flow-load', { desired: false, startedMs });
    sweep(store, false, startedMs);

    // A newer command for the same device takes the entry over.
    store.record('flow-load', { desired: true, startedMs: startedMs + 10 });
    store.recordDispatchAccepted('flow-load', { deviceId: 'flow-load', desired: true });

    expect(confirmed).not.toHaveBeenCalled();
    expect(store.peek('flow-load')).toMatchObject({ desired: true });
    // No OFF provenance was stamped from the superseded command.
    expect(store.hasRecentConfirmedOff('flow-load')).toBe(false);
  });

  it('does not let a superseded command\'s acceptance flip its replacement', () => {
    // Only a SAME-direction command is skipped as already pending, so an
    // opposite-direction decision replaces the entry while the older write is
    // still in flight. That older write's acceptance must not vouch for the
    // replacement.
    const state = createPlanEngineState();
    const confirmed = vi.fn();
    const store = createPendingBinaryCommandStore(
      state.pendingBinaryCommands,
      { onConfirmed: confirmed },
    );
    const startedMs = Date.now();
    store.record('flow-load', { desired: false, startedMs });
    store.record('flow-load', { desired: true, startedMs: startedMs + 10 });
    // The superseded OFF write finally returns.
    store.recordDispatchAccepted('flow-load', { deviceId: 'flow-load', desired: false });
    expect(store.isDispatchAccepted('flow-load')).toBe(false);
    // So an echo of the replacement's desired value cannot settle it yet.
    expect(sweep(store, true, startedMs + 20)).toBe(false);
    expect(confirmed).not.toHaveBeenCalled();
    // The replacement's own acceptance does vouch for it.
    store.recordDispatchAccepted('flow-load', { deviceId: 'flow-load', desired: true });
    expect(sweep(store, true, startedMs + 20)).toBe(true);
    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it('rejects an echo older than the command it would settle', () => {
    const state = createPlanEngineState();
    const confirmed = vi.fn();
    const store = createPendingBinaryCommandStore(
      state.pendingBinaryCommands,
      { onConfirmed: confirmed },
    );
    const startedMs = Date.now();
    store.record('flow-load', { desired: true, startedMs });
    store.recordDispatchAccepted('flow-load', { deviceId: 'flow-load', desired: true });
    // Pre-dispatch evidence cannot settle a command issued after it.
    expect(sweep(store, true, startedMs - 1)).toBe(false);
    expect(confirmed).not.toHaveBeenCalled();
  });
});

describe('native relay shed delivery and electrical evidence', () => {
  const id = 'metered-switch';
  const start = 1_000_000;
  const settle = start + CONTROL_COMMAND_CONFIRMATION_MS;
  const dated = (value: number, atMs: number) => ({ value, atMs, receivedAtMs: atMs, sourceDated: true });
  const makeIntent = (facts: RelayShedDecision): PlannedBinaryCommand => ({
    ...facts, deviceId: id, name: 'Metered switch', source: 'controlled', desiredOn: false,
  });

  function harness() {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const { transport } = buildTransport();
    const binding = { binding: 'switch-driver', zwave: true };
    const bindingRead = vi.fn<() => typeof binding | undefined>(() => binding);
    const observed: RelayMeterObservation = { on: true, binaryAtMs: start - 50, watts: dated(1000, start - 50) };
    const revision = vi.fn(() => 1);
    const recovery = new RelayShedRecovery({
      binding: bindingRead, observation: () => observed, pending: () => Boolean(transport.pendingBinaryCommandStore.get(id)),
      revision, noteNoAck: vi.fn(), household: () => undefined, overlappingSheds: () => false,
    });
    transport.relayShed = recovery;
    transport.getObservedState = () => ({ binaryControl: { on: observed.on } });
    const apply = vi.fn<Actuator['apply']>(async () => ({
      requested: true, kind: 'binary', acknowledged: true, relayBinding: binding.binding,
    }));
    transport.actuator.apply = apply;
    const retain = (intent?: PlannedBinaryCommand, member = true, nonCapacityHoldShed = false) => {
      const commands = { id, name: 'Metered switch', projection: 'decided' as const, commandAuthority: true,
        ...(intent ? { binary: intent } : {}) };
      recovery.retain({
        devices: member ? [{ commands, stableOperations: [], nonCapacityHoldShed }] : [], hasShedDevices: true,
        storageDevices: [], storageReleases: [], inverterDecisions: [], droppedSteppedSheds: [], chargingPhaseDecisions: [],
      }, revision());
    };
    const send = (capacityShed: PlannedBinaryCommand) => decideAndDispatchBinaryControl(transport, {
      desired: false, deviceId: id, name: 'Metered switch', logContext: 'capacity', capacityShed,
    }, { targets: [], binaryControl: { on: observed.on }, canSetControl: true });
    const sample = (watts: number, stamp: number, sourceDated = true) => {
      vi.setSystemTime(Math.max(Date.now(), stamp));
      observed.watts = { ...dated(watts, stamp), sourceDated };
      recovery.observe(id);
    };
    const off = () => {
      observed.on = false;
      observed.binaryAtMs = Date.now();
      transport.pendingBinaryCommandStore.clear(id);
      recovery.observe(id);
    };
    return { apply, recovery, binding, bindingRead, observed, revision, retain, send, sample, off, store: transport.pendingBinaryCommandStore };
  }

  afterEach(() => { vi.useRealTimers(); });

  it('reports NO_ACK outside pending, gates ON retries against the selected decision, and retires it on acceptance', async () => {
    const h = harness();
    h.binding.zwave = false;
    h.apply.mockResolvedValueOnce({
      requested: true, kind: 'binary', acknowledged: false, reason: 'zwave_no_ack',
      relayBinding: h.binding.binding, err: new Error('TRANSMIT_COMPLETE_NO_ACK'),
    });
    const first = makeIntent({ shedDecisionAtMs: start });
    h.retain(first);
    expect(await h.send(first)).toEqual({ applied: false, issued: true });
    expect(h.store.get(id)).toBeUndefined();
    expect(h.recovery.getNoAck(id)).toEqual({ decisionAtMs: start, retryAtMs: settle });
    vi.setSystemTime(settle);
    expect(await h.send(first)).toEqual({ applied: false });
    const retry = makeIntent({ shedDecisionAtMs: settle });
    h.retain(retry);
    h.apply.mockResolvedValueOnce({ requested: true, kind: 'binary', acknowledged: true,
      relayBinding: h.binding.binding, unflaggedRelay: true });
    expect(await h.send(retry)).toEqual({ applied: true });
    expect(h.recovery.getNoAck(id)).toBeUndefined();
    expect(h.store.get(id)?.dispatchState).toBe('accepted');
    expect(h.apply).toHaveBeenCalledTimes(2);
  });

  it('preserves uncertainty when the retry returns a generic success without the native binding', async () => {
    const h = harness();
    h.binding.zwave = false;
    h.apply.mockResolvedValueOnce({ requested: true, kind: 'binary', acknowledged: false,
      reason: 'zwave_no_ack', relayBinding: h.binding.binding, err: new Error('TRANSMIT_COMPLETE_NO_ACK') });
    const first = makeIntent({ shedDecisionAtMs: start });
    h.retain(first);
    await h.send(first);
    h.apply.mockResolvedValueOnce({ requested: true, kind: 'binary', acknowledged: true });
    const retry = makeIntent({ shedDecisionAtMs: settle });
    vi.setSystemTime(settle);
    h.retain(retry);
    await h.send(retry);
    expect(h.recovery.getNoAck(id)).toMatchObject({ decisionAtMs: start, retryAtMs: settle + CONTROL_COMMAND_CONFIRMATION_MS });
  });

  it.each([true, false])('lets a separate OFF decision through NO_ACK pacing (non-capacity hold %s)', async (hold) => {
    const h = harness();
    h.apply.mockResolvedValueOnce({ requested: true, kind: 'binary', acknowledged: false,
      reason: 'zwave_no_ack', relayBinding: h.binding.binding, err: new Error('TRANSMIT_COMPLETE_NO_ACK') });
    const first = makeIntent({ shedDecisionAtMs: start });
    h.retain(first);
    await h.send(first);
    const paced = makeIntent({ relayNoAckPosture: true });
    h.retain(paced);
    expect(await h.send(paced)).toEqual({ applied: false });
    const independentOff = makeIntent({});
    h.retain(independentOff, true, hold);
    expect(await h.send(independentOff)).toEqual({ applied: true });
  });

  it('requires a full settle interval after an ordinary retry while preserving the original baseline', async () => {
    const h = harness();
    h.apply.mockResolvedValueOnce({ requested: true, kind: 'binary', acknowledged: false,
      reason: 'zwave_no_ack', relayBinding: h.binding.binding, err: new Error('TRANSMIT_COMPLETE_NO_ACK') });
    const first = makeIntent({ shedDecisionAtMs: start });
    h.retain(first);
    await h.send(first);
    h.sample(2300, settle);
    const retry = makeIntent({ shedDecisionAtMs: settle });
    h.retain(retry);
    await h.send(retry);
    h.off();
    h.sample(950, settle + 1);
    h.sample(940, settle + 2);
    expect(h.recovery.status(id)?.powerEvidence).toBe('post_command');
    h.sample(900, settle + CONTROL_COMMAND_CONFIRMATION_MS);
    expect(h.recovery.status(id)?.powerEvidence).toBe('off_with_draw');
    const repeat = makeIntent({ relayRecoveryMeterAtMs: settle + CONTROL_COMMAND_CONFIRMATION_MS + 1 });
    h.retain(repeat);
    expect(h.recovery.allowsRepeat(repeat)).toBe(false);
    h.sample(901, settle + CONTROL_COMMAND_CONFIRMATION_MS + 1);
    expect(await h.send(repeat)).toEqual({ applied: true });
    expect(h.store.peek(id)?.relayRepeat).toBe(true);
    h.bindingRead.mockReturnValue(undefined);
    expect(h.recovery.status(id)).toBeUndefined();
    h.bindingRead.mockReturnValue(h.binding);
    expect(h.recovery.status(id)?.repeatIssued).toBe(true);
  });

  it('retries an observed OFF once after two independently dated readings and a fresh meter decision', async () => {
    const h = harness();
    const first = makeIntent({ shedDecisionAtMs: start });
    h.retain(first);
    await h.send(first);
    h.off();
    expect(h.recovery.status(id)?.powerEvidence).toBe('pre_command');
    h.sample(1000, settle, false);
    expect(h.recovery.status(id)?.powerEvidence).toBe('post_command');
    h.sample(701, settle);
    const repeat = makeIntent({ relayRecoveryMeterAtMs: settle + 5 });
    h.retain(repeat);
    h.sample(701, settle);
    h.sample(950, settle + 1, false);
    expect(h.recovery.status(id)?.powerEvidence).toBe('off_with_draw');
    expect(await h.send(repeat)).toEqual({ applied: false });
    h.sample(700, settle + 2); // Exactly 30% relief breaks the high-draw run.
    h.sample(900, settle + 3);
    expect(await h.send(repeat)).toEqual({ applied: false });
    h.sample(901, settle + 4);
    vi.setSystemTime(settle + 5);
    h.revision.mockReturnValue(2);
    expect(await h.send(repeat)).toEqual({ applied: false });
    h.retain(repeat);
    expect(await h.send(repeat)).toEqual({ applied: true });
    h.store.clear(id);
    expect(await h.send(repeat)).toEqual({ applied: false });
    expect(h.apply).toHaveBeenCalledTimes(2);
  });

  it('requires a second dated watt reading even when energy advances or resets', async () => {
    const h = harness();
    const first = makeIntent({ shedDecisionAtMs: start });
    h.retain(first);
    await h.send(first);
    h.off();
    h.sample(1000, settle);
    for (const [index, kwh] of [10, 10.02, 0, 0.05].entries()) {
      const atMs = settle + index * 60_000;
      vi.setSystemTime(atMs);
      h.observed.energy = { kwh, atMs, receivedAtMs: atMs };
      h.recovery.observe(id);
      const current = makeIntent({ relayRecoveryMeterAtMs: atMs });
      h.retain(current);
      expect(h.recovery.allowsRepeat(current)).toBe(false);
    }
    expect(h.apply).toHaveBeenCalledTimes(1);
  });

  it('treats a low-power relay as outside the high-draw detector', async () => {
    const h = harness();
    h.observed.watts = dated(249, start - 50);
    const first = makeIntent({ shedDecisionAtMs: start });
    h.retain(first);
    await h.send(first);
    h.off();
    h.sample(300, settle);
    h.sample(300, settle + 1);
    const current = makeIntent({ relayRecoveryMeterAtMs: settle + 1 });
    h.retain(current);
    expect(h.recovery.allowsRepeat(current)).toBe(false);
    expect(h.recovery.status(id)?.powerEvidence).toBe('post_command');
  });

  it('keeps an early OFF echo and consumes the repeat before a delayed second NO_ACK', async () => {
    const h = harness();
    const first = makeIntent({ shedDecisionAtMs: start });
    h.retain(first);
    let complete!: (result: Awaited<ReturnType<Actuator['apply']>>) => void;
    h.apply.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const initialWrite = h.send(first);
    h.off();
    complete({ requested: true, kind: 'binary', acknowledged: true, relayBinding: h.binding.binding });
    expect(await initialWrite).toEqual({ applied: true });
    h.sample(1000, settle);
    h.sample(1000, settle + 1);
    const repeat = makeIntent({ relayRecoveryMeterAtMs: settle + 1 });
    h.retain(repeat);
    h.apply.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const secondWrite = h.send(repeat);
    expect(h.recovery.status(id)?.repeatIssued).toBe(true);
    h.off();
    const next = makeIntent({ relayRecoveryMeterAtMs: settle + 2 });
    h.retain(next);
    expect(await h.send(next)).toEqual({ applied: false });
    complete({ requested: true, kind: 'binary', acknowledged: false, reason: 'zwave_no_ack',
      relayBinding: h.binding.binding, err: new Error('TRANSMIT_COMPLETE_NO_ACK') });
    expect(await secondWrite).toEqual({ applied: false, issued: true });
    expect(await h.send(next)).toEqual({ applied: false });
    expect(h.apply).toHaveBeenCalledTimes(2);
  });

  it('waits for samples from the OFF interval when the first OFF report arrives late', async () => {
    const h = harness();
    const first = makeIntent({ shedDecisionAtMs: start });
    h.retain(first);
    await h.send(first);
    h.sample(990, settle);
    vi.setSystemTime(settle + 10);
    h.off();
    expect(h.recovery.status(id)?.powerEvidence).toBe('post_command');
    h.sample(991, settle + 20);
    const repeat = makeIntent({ relayRecoveryMeterAtMs: settle + 30 });
    h.retain(repeat);
    expect(h.recovery.allowsRepeat(repeat)).toBe(false);
    h.sample(992, settle + 30);
    expect(h.recovery.allowsRepeat(repeat)).toBe(true);
    h.observed.lastOpposingOnAtMs = settle + 31;
    h.observed.binaryAtMs = settle + 32;
    h.recovery.observe(id);
    expect(h.recovery.allowsRepeat(repeat)).toBe(false);
  });

  it('retains spent allowance across omitted intents and closes it when the device leaves the home plan', async () => {
    const h = harness();
    const first = makeIntent({ shedDecisionAtMs: start });
    h.retain(first);
    await h.send(first);
    h.off();
    h.sample(800, settle);
    h.sample(900, settle + 1);
    const repeat = makeIntent({ relayRecoveryMeterAtMs: settle + 1 });
    h.retain(repeat);
    expect(await h.send(repeat)).toEqual({ applied: true });
    h.retain();
    expect(h.recovery.status(id)?.repeatIssued).toBe(true);
    h.retain(undefined, false);
    expect(h.recovery.status(id)).toBeUndefined();
    h.retain(repeat);
    expect(h.recovery.allowsRepeat(repeat)).toBe(false);
  });

  it('withdraws the repeat on a zero, an opposing pending command, replacement binding or missing pressure', async () => {
    const h = harness();
    const first = makeIntent({ shedDecisionAtMs: start });
    h.retain(first);
    await h.send(first);
    h.off();
    h.sample(920, settle);
    h.sample(920, settle + 1);
    const repeat = makeIntent({ relayRecoveryMeterAtMs: settle + 2 });
    h.retain(repeat);
    expect(h.recovery.allowsRepeat(repeat)).toBe(true);
    const lastWatts = h.observed.watts;
    h.observed.watts = undefined;
    expect(h.recovery.allowsRepeat(repeat)).toBe(false);
    h.observed.watts = lastWatts;
    h.store.record(id, { desired: true, startedMs: Date.now() });
    expect(h.recovery.allowsRepeat(repeat)).toBe(false);
    h.store.clear(id);
    const hold = makeIntent({});
    h.retain(hold);
    expect(h.recovery.allowsRepeat(repeat)).toBe(false);
    expect(h.recovery.allowsRepeat(hold)).toBe(false);
    h.retain(repeat);
    h.sample(0, settle + 2, false);
    expect(h.recovery.status(id)?.powerEvidence).toBe('relieved');
    expect(h.recovery.allowsRepeat(repeat)).toBe(false);
    h.binding.binding = 'replacement';
    expect(h.recovery.status(id)).toBeUndefined();
  });
});
