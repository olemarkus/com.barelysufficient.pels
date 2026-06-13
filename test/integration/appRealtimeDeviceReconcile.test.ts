import {
  createRealtimeDeviceReconcileState,
  flushRealtimeDeviceReconcileQueue,
  scheduleRealtimeDeviceReconcile,
} from '../../setup/appRealtimeDeviceReconcile';
import { shouldQueueRealtimeDeviceReconcile } from '../../setup/appRealtimeDeviceReconcileRuntime';
import type { Logger, StructuredDebugEmitter } from '../../lib/logging/logger';
import type {
  BinaryControlDiscriminantProbe,
  DevicePlanDevice,
  PlanInputDevice,
  TemperatureDiscriminantProbe,
} from '../../lib/plan/planTypes';
import { withBinaryDiscriminant, withTemperatureDiscriminant } from '../../lib/plan/planTypes';
import type { BinaryControlObservation } from '../../packages/contracts/src/types';
import { buildBinaryObservation } from '../utils/binaryObservationTestUtils';

/**
 * Regroup a loose plan-device fixture (temperature fields carried as plain
 * optionals) onto the discriminated `DevicePlanDevice` shape so `currentTarget` /
 * `plannedTarget` land on `TemperatureKind`.
 */
const planDevice = (
  loose: Partial<DevicePlanDevice> & TemperatureDiscriminantProbe & { id: string; name: string; currentState: string; plannedState: string },
): DevicePlanDevice => withTemperatureDiscriminant(loose) as DevicePlanDevice;

/**
 * Regroup a loose live-device fixture (binary + temperature fields carried as
 * plain optionals) onto the discriminated `PlanInputDevice` shape.
 */
const liveDevice = (
  loose: Partial<PlanInputDevice> & BinaryControlDiscriminantProbe & TemperatureDiscriminantProbe & {
    id: string;
    name: string;
    // Observer-internal binary-settle evidence the fixtures still carry; not a
    // `PlanInputDevice` field, so accept it on the loose input and let it ride
    // through the regroupers (the drift check reads `binaryControl`, not this).
    binaryControlObservation?: BinaryControlObservation;
  },
): PlanInputDevice => withTemperatureDiscriminant(withBinaryDiscriminant(loose)) as PlanInputDevice;

describe('appRealtimeDeviceReconcile', () => {
  const createDebugStructuredMock = (): StructuredDebugEmitter => vi.fn() as unknown as StructuredDebugEmitter;
  const createInfoLoggerMock = (): Logger & { info: ReturnType<typeof vi.fn> } => (
    { info: vi.fn() } as unknown as Logger & { info: ReturnType<typeof vi.fn> }
  );

  it('logs drift details when queueing realtime reconcile', () => {
    vi.useFakeTimers();
    const debugStructured = createDebugStructuredMock();

    const timer = scheduleRealtimeDeviceReconcile({
      state: createRealtimeDeviceReconcileState(),
      hasPendingTimer: false,
      event: {
        deviceId: 'dev-1',
        name: 'Heater',
        capabilityId: 'onoff',
        changes: [{ capabilityId: 'onoff', previousValue: 'on', nextValue: 'off' }],
      },
      debugStructured,
      onTimerFired: vi.fn(),
      onFlush: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn(),
    });

    expect(timer).toBeDefined();
    expect(debugStructured).toHaveBeenCalledWith({
      event: 'realtime_reconcile_queued',
      deviceId: 'dev-1',
      deviceName: 'Heater',
      capabilityId: 'onoff',
      planExpectation: undefined,
      changes: [{ capabilityId: 'onoff', previousValue: 'on', nextValue: 'off' }],
    });

    if (timer) clearTimeout(timer);
    vi.useRealTimers();
  });

  it('omits deviceName from reconcile payloads when no label is known', () => {
    vi.useFakeTimers();
    const debugStructured = createDebugStructuredMock();

    const timer = scheduleRealtimeDeviceReconcile({
      state: createRealtimeDeviceReconcileState(),
      hasPendingTimer: false,
      event: {
        deviceId: 'dev-1',
        capabilityId: 'onoff',
      },
      debugStructured,
      onTimerFired: vi.fn(),
      onFlush: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn(),
    });

    expect(timer).toBeDefined();
    expect(debugStructured).toHaveBeenCalledWith({
      event: 'realtime_reconcile_queued',
      deviceId: 'dev-1',
      capabilityId: 'onoff',
      planExpectation: undefined,
      changes: undefined,
    });

    if (timer) clearTimeout(timer);
    vi.useRealTimers();
  });

  it('skips reconcile when the live device state already matches the current plan', () => {
    const debugStructured = createDebugStructuredMock();

    const shouldQueue = shouldQueueRealtimeDeviceReconcile({
      event: {
        deviceId: 'dev-1',
        name: 'Heater',
        capabilityId: 'onoff',
        changes: [{ capabilityId: 'onoff', previousValue: 'off', nextValue: 'on' }],
      },
      latestPlanSnapshot: {
        meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
        devices: [planDevice({
          id: 'dev-1',
          name: 'Heater',
          currentState: 'on',
          plannedState: 'keep',
          currentTarget: 20,
          plannedTarget: 20,
          controllable: true,
          controlCapabilityId: 'onoff',
        })],
      },
      liveDevices: [liveDevice({
        id: 'dev-1',
        name: 'Heater',
        binaryControl: { on: true },
        controlCapabilityId: 'onoff',
        currentTemperature: 21,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
      })],
      debugStructured,
    });

    expect(shouldQueue).toBe(false);
    expect(debugStructured).toHaveBeenCalledWith({
      event: 'realtime_reconcile_skipped_no_drift',
      deviceId: 'dev-1',
      deviceName: 'Heater',
      capabilityId: 'onoff',
      planExpectation: 'plan state: on',
      changes: [{ capabilityId: 'onoff', previousValue: 'off', nextValue: 'on' }],
    });
  });

  it('does not skip reconcile just because the stored snapshot already drifted away from a keep plan', () => {
    const shouldQueue = shouldQueueRealtimeDeviceReconcile({
      event: {
        deviceId: 'dev-1',
        name: 'Heater',
        capabilityId: 'onoff',
        changes: [{ capabilityId: 'onoff', previousValue: 'on', nextValue: 'off' }],
      },
      latestPlanSnapshot: {
        meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
        devices: [planDevice({
          id: 'dev-1',
          name: 'Heater',
          currentState: 'off',
          plannedState: 'keep',
          currentTarget: 20,
          plannedTarget: 20,
          controllable: true,
          controlCapabilityId: 'onoff',
        })],
      },
      liveDevices: [liveDevice({
        id: 'dev-1',
        name: 'Heater',
        binaryControl: { on: false },
        controlCapabilityId: 'onoff',
        binaryControlObservation: buildBinaryObservation('onoff', false),
        currentTemperature: 21,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
      })],
    });

    expect(shouldQueue).toBe(true);
  });

  it('skips reconcile while a matching binary command is still pending', () => {
    const debugStructured = createDebugStructuredMock();

    const shouldQueue = shouldQueueRealtimeDeviceReconcile({
      event: {
        deviceId: 'dev-1',
        name: 'Heater',
        capabilityId: 'onoff',
        changes: [{ capabilityId: 'onoff', previousValue: 'on', nextValue: 'off' }],
      },
      latestPlanSnapshot: {
        meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
        devices: [planDevice({
          id: 'dev-1',
          name: 'Heater',
          currentState: 'off',
          plannedState: 'keep',
          currentTarget: 20,
          plannedTarget: 20,
          controllable: true,
          controlCapabilityId: 'onoff',
        })],
      },
      liveDevices: [liveDevice({
        id: 'dev-1',
        name: 'Heater',
        binaryControl: { on: false },
        controlCapabilityId: 'onoff',
        binaryCommandPending: true,
        binaryCommandPendingDesired: true,
        currentTemperature: 21,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
      })],
      debugStructured,
    });

    expect(shouldQueue).toBe(false);
    expect(debugStructured).toHaveBeenCalledWith({
      event: 'realtime_reconcile_skipped_no_drift',
      deviceId: 'dev-1',
      deviceName: 'Heater',
      capabilityId: 'onoff',
      planExpectation: 'plan state: on',
      changes: [{ capabilityId: 'onoff', previousValue: 'on', nextValue: 'off' }],
    });
  });

  it('queues reconcile when a keep device has fresh off live binary state', () => {
    const shouldQueue = shouldQueueRealtimeDeviceReconcile({
      event: {
        deviceId: 'dev-1',
        name: 'Heater',
        capabilityId: 'onoff',
        changes: [{ capabilityId: 'onoff', previousValue: 'on', nextValue: 'off' }],
      },
      latestPlanSnapshot: {
        meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
        devices: [planDevice({
          id: 'dev-1',
          name: 'Heater',
          currentState: 'on',
          plannedState: 'keep',
          currentTarget: 20,
          plannedTarget: 20,
          controllable: true,
          controlCapabilityId: 'onoff',
        })],
      },
      liveDevices: [liveDevice({
        id: 'dev-1',
        name: 'Heater',
        controlCapabilityId: 'onoff',
        binaryControl: { on: false },
        binaryControlObservation: buildBinaryObservation('onoff', false),
        currentTemperature: 21,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
      })],
    });

    expect(shouldQueue).toBe(true);
  });

  it('queues reconcile after an off plan observes fresh on realtime drift', () => {
    const debugStructured = createDebugStructuredMock();

    const shouldQueue = shouldQueueRealtimeDeviceReconcile({
      event: {
        deviceId: 'dev-1',
        name: 'Heater',
        capabilityId: 'onoff',
        changes: [{ capabilityId: 'onoff', previousValue: 'off', nextValue: 'on' }],
      },
      latestPlanSnapshot: {
        meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
        devices: [planDevice({
          id: 'dev-1',
          name: 'Heater',
          currentState: 'off',
          plannedState: 'shed',
          shedAction: 'turn_off',
          currentTarget: null,
          controllable: true,
          controlCapabilityId: 'onoff',
        })],
      },
      liveDevices: [liveDevice({
        id: 'dev-1',
        name: 'Heater',
        controlCapabilityId: 'onoff',
        binaryControl: { on: true },
        binaryControlObservation: buildBinaryObservation('onoff', true),
        currentTemperature: 21,
        targets: [],
      })],
      debugStructured,
    });

    expect(shouldQueue).toBe(true);
    expect(debugStructured).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'realtime_reconcile_skipped_no_drift',
    }));
  });

  it('skips reconcile for target drift when a shed device is already off', () => {
    const debugStructured = createDebugStructuredMock();

    const shouldQueue = shouldQueueRealtimeDeviceReconcile({
      event: {
        deviceId: 'dev-1',
        name: 'Heater',
        capabilityId: 'target_temperature',
        changes: [{ capabilityId: 'target_temperature', previousValue: '21°C', nextValue: '23.5°C' }],
      },
      latestPlanSnapshot: {
        meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
        devices: [planDevice({
          id: 'dev-1',
          name: 'Heater',
          deviceType: 'temperature',
          currentState: 'off',
          plannedState: 'shed',
          currentTarget: 21,
          plannedTarget: 21,
          shedAction: 'turn_off',
          controllable: true,
          controlCapabilityId: 'onoff',
        })],
      },
      liveDevices: [liveDevice({
        id: 'dev-1',
        name: 'Heater',
        binaryControl: { on: false },
        controlCapabilityId: 'onoff',
        currentTemperature: 21,
        targets: [{ id: 'target_temperature', value: 23.5, unit: '°C' }],
      })],
      debugStructured,
    });

    expect(shouldQueue).toBe(false);
    expect(debugStructured).toHaveBeenCalledWith({
      event: 'realtime_reconcile_skipped_no_drift',
      deviceId: 'dev-1',
      deviceName: 'Heater',
      capabilityId: 'target_temperature',
      planExpectation: 'plan target: 21°C',
      changes: [{ capabilityId: 'target_temperature', previousValue: '21°C', nextValue: '23.5°C' }],
    });
  });

  it('records breaker attempts only for devices that still drift after reconcile', async () => {
    const state = createRealtimeDeviceReconcileState();
    const structuredLog = createInfoLoggerMock();
    state.pendingEvents.set('dev-1', { deviceId: 'dev-1', name: 'Heater 1', capabilityId: 'onoff' });
    state.pendingEvents.set('dev-2', { deviceId: 'dev-2', name: 'Heater 2', capabilityId: 'onoff' });

    await flushRealtimeDeviceReconcileQueue({
      state,
      reconcile: vi.fn().mockResolvedValue(true),
      shouldRecordAttempt: (event) => event.deviceId === 'dev-2',
      structuredLog,
    });

    expect(state.circuitState.get('dev-1')).toBeUndefined();
    expect(state.circuitState.get('dev-2')).toEqual(expect.objectContaining({
      reconcileCount: 1,
    }));
    expect(structuredLog.info).toHaveBeenCalledWith({
      event: 'realtime_reconcile_applied',
      deviceCount: 1,
      devices: [{
        deviceId: 'dev-2',
        deviceName: 'Heater 2',
        capabilityId: 'onoff',
      }],
    });
  });

  it('does not log or record attempts when shouldRecordAttempt filters out every reconciled event', async () => {
    const state = createRealtimeDeviceReconcileState();
    const structuredLog = createInfoLoggerMock();
    state.pendingEvents.set('dev-1', { deviceId: 'dev-1', name: 'Heater 1', capabilityId: 'onoff' });

    await flushRealtimeDeviceReconcileQueue({
      state,
      reconcile: vi.fn().mockResolvedValue(true),
      shouldRecordAttempt: () => false,
      structuredLog,
    });

    expect(structuredLog.info).not.toHaveBeenCalled();
    expect(state.circuitState.size).toBe(0);
  });

  it('opens the breaker after repeated reconcile attempts for devices that still drift', async () => {
    const state = createRealtimeDeviceReconcileState();
    const structuredLog = createInfoLoggerMock();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      state.pendingEvents.set('dev-1', { deviceId: 'dev-1', name: 'Heater 1', capabilityId: 'onoff' });
      await flushRealtimeDeviceReconcileQueue({
        state,
        reconcile: vi.fn().mockResolvedValue(true),
        shouldRecordAttempt: () => true,
        structuredLog,
      });
    }

    expect(structuredLog.info).toHaveBeenCalledWith({
      event: 'realtime_reconcile_circuit_opened',
      suppressMs: 60_000,
      deviceId: 'dev-1',
      deviceName: 'Heater 1',
      capabilityId: 'onoff',
      planExpectation: undefined,
      changes: undefined,
    });
  });

  it('opens the breaker after repeated target reconcile attempts for devices that still drift', async () => {
    const state = createRealtimeDeviceReconcileState();
    const structuredLog = createInfoLoggerMock();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      state.pendingEvents.set('dev-1', {
        deviceId: 'dev-1',
        name: 'Heater 1',
        capabilityId: 'target_temperature',
        changes: [{ capabilityId: 'target_temperature', previousValue: '25.5°C', nextValue: '26°C' }],
        planExpectation: 'plan target: 20°C',
      });
      await flushRealtimeDeviceReconcileQueue({
        state,
        reconcile: vi.fn().mockResolvedValue(true),
        shouldRecordAttempt: () => true,
        structuredLog,
      });
    }

    expect(structuredLog.info).toHaveBeenCalledWith({
      event: 'realtime_reconcile_circuit_opened',
      suppressMs: 60_000,
      deviceId: 'dev-1',
      deviceName: 'Heater 1',
      capabilityId: 'target_temperature',
      planExpectation: 'plan target: 20°C',
      changes: [{ capabilityId: 'target_temperature', previousValue: '25.5°C', nextValue: '26°C' }],
    });
  });
});
