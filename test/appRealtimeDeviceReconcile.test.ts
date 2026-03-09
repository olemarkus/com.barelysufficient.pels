import {
  createRealtimeDeviceReconcileState,
  formatRealtimeDeviceReconcileEvent,
  flushRealtimeDeviceReconcileQueue,
  scheduleRealtimeDeviceReconcile,
} from '../lib/app/appRealtimeDeviceReconcile';
import { shouldQueueRealtimeDeviceReconcile } from '../lib/app/appRealtimeDeviceReconcileRuntime';

describe('appRealtimeDeviceReconcile', () => {
  it('formats reconcile events with old and new values', () => {
    expect(formatRealtimeDeviceReconcileEvent({
      deviceId: 'dev-1',
      name: 'Heater',
      capabilityId: 'onoff',
      changes: [
        { capabilityId: 'onoff', previousValue: 'on', nextValue: 'off' },
        { capabilityId: 'target_temperature', previousValue: '21°C', nextValue: '18°C' },
      ],
    })).toBe('Heater (dev-1) via onoff [onoff: on -> off, target_temperature: 21°C -> 18°C]');
  });

  it('logs drift details when queueing realtime reconcile', () => {
    jest.useFakeTimers();
    const logDebug = jest.fn();

    const timer = scheduleRealtimeDeviceReconcile({
      state: createRealtimeDeviceReconcileState(),
      hasPendingTimer: false,
      event: {
        deviceId: 'dev-1',
        name: 'Heater',
        capabilityId: 'onoff',
        changes: [{ capabilityId: 'onoff', previousValue: 'on', nextValue: 'off' }],
      },
      logDebug,
      onTimerFired: jest.fn(),
      onFlush: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
    });

    expect(timer).toBeDefined();
    expect(logDebug).toHaveBeenCalledWith(
      'Realtime device drift queued for plan reconcile: '
      + 'Heater (dev-1) via onoff [onoff: on -> off]',
    );

    if (timer) clearTimeout(timer);
    jest.useRealTimers();
  });

  it('skips reconcile when the live device state already matches the current plan', () => {
    const logDebug = jest.fn();

    const shouldQueue = shouldQueueRealtimeDeviceReconcile({
      event: {
        deviceId: 'dev-1',
        name: 'Heater',
        capabilityId: 'onoff',
        changes: [{ capabilityId: 'onoff', previousValue: 'off', nextValue: 'on' }],
      },
      latestPlanSnapshot: {
        meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
        devices: [{
          id: 'dev-1',
          name: 'Heater',
          currentState: 'on',
          plannedState: 'keep',
          currentTarget: 20,
          plannedTarget: 20,
          controllable: true,
        }],
      },
      liveDevices: [{
        id: 'dev-1',
        name: 'Heater',
        currentOn: true,
        hasBinaryControl: true,
        currentTemperature: 21,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
      }],
      logDebug,
    });

    expect(shouldQueue).toBe(false);
    expect(logDebug).toHaveBeenCalledWith(
      'Realtime device change matches current plan, skipping reconcile: '
      + 'Heater (dev-1) via onoff [onoff: off -> on]',
    );
  });

  it('records breaker attempts only for devices that still drift after reconcile', async () => {
    const state = createRealtimeDeviceReconcileState();
    state.pendingEvents.set('dev-1', { deviceId: 'dev-1', name: 'Heater 1', capabilityId: 'onoff' });
    state.pendingEvents.set('dev-2', { deviceId: 'dev-2', name: 'Heater 2', capabilityId: 'onoff' });

    await flushRealtimeDeviceReconcileQueue({
      state,
      reconcile: jest.fn().mockResolvedValue(true),
      shouldRecordAttempt: (event) => event.deviceId === 'dev-2',
      logDebug: jest.fn(),
      log: jest.fn(),
    });

    expect(state.circuitState.get('dev-1')).toBeUndefined();
    expect(state.circuitState.get('dev-2')).toEqual(expect.objectContaining({
      reconcileCount: 1,
    }));
  });

  it('opens the breaker after repeated reconcile attempts for devices that still drift', async () => {
    const state = createRealtimeDeviceReconcileState();
    const log = jest.fn();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      state.pendingEvents.set('dev-1', { deviceId: 'dev-1', name: 'Heater 1', capabilityId: 'onoff' });
      await flushRealtimeDeviceReconcileQueue({
        state,
        reconcile: jest.fn().mockResolvedValue(true),
        shouldRecordAttempt: () => true,
        logDebug: jest.fn(),
        log,
      });
    }

    expect(log).toHaveBeenCalledWith(
      'Realtime reconcile circuit breaker opened for Heater 1 (dev-1) via onoff; '
      + 'suppressing automatic reconcile for 60s',
    );
  });
});
