import { createPlanEngineState } from '../lib/plan/planState';
import {
  prunePendingTargetCommandsForPlan,
  recordFailedPendingTargetCommandAttempt,
  recordPendingTargetCommandAttempt,
  syncPendingTargetCommands,
} from '../lib/plan/planTargetControl';
import type { DevicePlan, PlanInputDevice } from '../lib/plan/planTypes';
import { TARGET_WAITING_LOG_REPEAT_MS } from '../lib/plan/planConstants';

const buildLiveDevice = (deviceId: string, name: string, target: number): PlanInputDevice => ({
  id: deviceId,
  name,
  deviceType: 'temperature',
  currentOn: true,
  currentTemperature: 21,
  targets: [{ id: 'target_temperature', value: target, unit: '°C' }],
});

const buildPlanDevice = (
  deviceId: string,
  name: string,
  currentTarget: number,
  plannedTarget: number,
): DevicePlan['devices'][number] => ({
  id: deviceId,
  name,
  currentState: 'on',
  plannedState: 'keep',
  currentTarget,
  plannedTarget,
  controllable: true,
});

describe('syncPendingTargetCommands', () => {
  it('logs a user-visible waiting message on the first unresolved observation', () => {
    const state = createPlanEngineState();
    state.pendingTargetCommands['dev-1'] = {
      capabilityId: 'target_temperature',
      desired: 23,
      startedMs: Date.now() - 1_000,
      lastAttemptMs: Date.now() - 1_000,
      retryCount: 0,
      nextRetryAtMs: Date.now() + 30_000,
      status: 'waiting_confirmation',
    };
    const log = jest.fn();
    const logDebug = jest.fn();

    const changed = syncPendingTargetCommands({
      state,
      liveDevices: [buildLiveDevice('dev-1', 'Heater', 27)],
      source: 'realtime_capability',
      log,
      logDebug,
    });

    expect(changed).toBe(true);
    expect(log).toHaveBeenCalledWith(
      'Target still waiting for target_temperature confirmation for Heater: observed 27°C via realtime_capability; expected 23°C',
    );
  });

  it('logs the observed transition when the unresolved target changes again', () => {
    const state = createPlanEngineState();
    state.pendingTargetCommands['dev-1'] = {
      capabilityId: 'target_temperature',
      desired: 23,
      startedMs: Date.now() - 10_000,
      lastAttemptMs: Date.now() - 10_000,
      retryCount: 0,
      nextRetryAtMs: Date.now() + 30_000,
      status: 'waiting_confirmation',
      lastObservedValue: 25.5,
      lastObservedSource: 'realtime_capability',
      lastObservedAtMs: Date.now() - 1_000,
    };
    const log = jest.fn();
    const logDebug = jest.fn();

    const changed = syncPendingTargetCommands({
      state,
      liveDevices: [buildLiveDevice('dev-1', 'Heater', 27)],
      source: 'realtime_capability',
      log,
      logDebug,
    });

    expect(changed).toBe(true);
    expect(log).toHaveBeenCalledWith(
      'Target still waiting for target_temperature confirmation for Heater: 25.5°C -> 27°C via realtime_capability; expected 23°C',
    );
  });

  it('does not emit a user-visible waiting log when only the source changes', () => {
    const state = createPlanEngineState();
    state.pendingTargetCommands['dev-1'] = {
      capabilityId: 'target_temperature',
      desired: 23,
      startedMs: Date.now() - 10_000,
      lastAttemptMs: Date.now() - 10_000,
      retryCount: 0,
      nextRetryAtMs: Date.now() + 30_000,
      status: 'waiting_confirmation',
      lastObservedValue: 27,
      lastObservedSource: 'realtime_capability',
      lastObservedAtMs: Date.now() - 1_000,
    };
    const log = jest.fn();
    const logDebug = jest.fn();

    const changed = syncPendingTargetCommands({
      state,
      liveDevices: [buildLiveDevice('dev-1', 'Heater', 27)],
      source: 'snapshot_refresh',
      log,
      logDebug,
    });

    expect(changed).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it('repeats the user-visible waiting log after the repeat interval even when the observation is unchanged', () => {
    jest.useFakeTimers();
    try {
      const nowMs = new Date('2026-03-20T06:00:00.000Z').getTime();
      jest.setSystemTime(nowMs);
      const state = createPlanEngineState();
      state.pendingTargetCommands['dev-1'] = {
        capabilityId: 'target_temperature',
        desired: 23,
        startedMs: nowMs - 90_000,
        lastAttemptMs: nowMs - 90_000,
        retryCount: 0,
        nextRetryAtMs: nowMs + 30_000,
        status: 'waiting_confirmation',
        lastObservedValue: 27,
        lastObservedSource: 'snapshot_refresh',
        lastObservedAtMs: nowMs - 70_000,
        lastWaitingLogAtMs: nowMs - TARGET_WAITING_LOG_REPEAT_MS - 1,
      };
      const log = jest.fn();
      const logDebug = jest.fn();

      const changed = syncPendingTargetCommands({
        state,
        liveDevices: [buildLiveDevice('dev-1', 'Heater', 27)],
        source: 'snapshot_refresh',
        log,
        logDebug,
      });

      expect(changed).toBe(false);
      expect(log).toHaveBeenCalledWith(
        'Target still waiting for target_temperature confirmation for Heater: observed 27°C via snapshot_refresh; expected 23°C',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('tracks confirmations independently across multiple devices', () => {
    const state = createPlanEngineState();
    state.pendingTargetCommands['dev-1'] = {
      capabilityId: 'target_temperature',
      desired: 23,
      startedMs: Date.now() - 5_000,
      lastAttemptMs: Date.now() - 5_000,
      retryCount: 0,
      nextRetryAtMs: Date.now() + 30_000,
      status: 'waiting_confirmation',
    };
    state.pendingTargetCommands['dev-2'] = {
      capabilityId: 'target_temperature',
      desired: 21,
      startedMs: Date.now() - 5_000,
      lastAttemptMs: Date.now() - 5_000,
      retryCount: 0,
      nextRetryAtMs: Date.now() + 30_000,
      status: 'waiting_confirmation',
    };
    const log = jest.fn();
    const logDebug = jest.fn();

    const changed = syncPendingTargetCommands({
      state,
      liveDevices: [
        buildLiveDevice('dev-1', 'Heater A', 23),
        buildLiveDevice('dev-2', 'Heater B', 25),
      ],
      source: 'realtime_capability',
      log,
      logDebug,
    });

    expect(changed).toBe(true);
    expect(state.pendingTargetCommands['dev-1']).toBeUndefined();
    expect(state.pendingTargetCommands['dev-2']).toMatchObject({
      desired: 21,
      lastObservedValue: 25,
      lastObservedSource: 'realtime_capability',
    });
    expect(log).toHaveBeenCalledWith(
      'Target still waiting for target_temperature confirmation for Heater B: observed 25°C via realtime_capability; expected 21°C',
    );
  });

  it('clears a pending target command when the device is missing during snapshot refresh', () => {
    const state = createPlanEngineState();
    state.pendingTargetCommands['dev-1'] = {
      capabilityId: 'target_temperature',
      desired: 23,
      startedMs: Date.now() - 5_000,
      lastAttemptMs: Date.now() - 5_000,
      retryCount: 0,
      nextRetryAtMs: Date.now() + 30_000,
      status: 'waiting_confirmation',
    };
    const log = jest.fn();
    const logDebug = jest.fn();

    const changed = syncPendingTargetCommands({
      state,
      liveDevices: [],
      source: 'snapshot_refresh',
      log,
      logDebug,
    });

    expect(changed).toBe(true);
    expect(state.pendingTargetCommands['dev-1']).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
    expect(logDebug).toHaveBeenCalledWith(
      'Capacity: cleared pending target_temperature for dev-1, device missing from live state during snapshot_refresh',
    );
  });

  it('keeps a pending target command when the device is only missing from a realtime pass', () => {
    const state = createPlanEngineState();
    state.pendingTargetCommands['dev-1'] = {
      capabilityId: 'target_temperature',
      desired: 23,
      startedMs: Date.now() - 5_000,
      lastAttemptMs: Date.now() - 5_000,
      retryCount: 0,
      nextRetryAtMs: Date.now() + 30_000,
      status: 'waiting_confirmation',
    };
    const log = jest.fn();
    const logDebug = jest.fn();

    const changed = syncPendingTargetCommands({
      state,
      liveDevices: [],
      source: 'realtime_capability',
      log,
      logDebug,
    });

    expect(changed).toBe(false);
    expect(state.pendingTargetCommands['dev-1']).toMatchObject({
      desired: 23,
    });
    expect(log).not.toHaveBeenCalled();
    expect(logDebug).not.toHaveBeenCalled();
  });

  it('does not emit confirmation waiting logs for temporarily unavailable targets', () => {
    const state = createPlanEngineState();
    state.pendingTargetCommands['dev-1'] = {
      capabilityId: 'target_temperature',
      desired: 23,
      startedMs: Date.now() - 10_000,
      lastAttemptMs: Date.now() - 10_000,
      retryCount: 1,
      nextRetryAtMs: Date.now() + 30_000,
      status: 'temporary_unavailable',
      lastObservedValue: 27,
      lastObservedSource: 'realtime_capability',
      lastObservedAtMs: Date.now() - 1_000,
    };
    const log = jest.fn();
    const logDebug = jest.fn();

    const changed = syncPendingTargetCommands({
      state,
      liveDevices: [buildLiveDevice('dev-1', 'Heater', 27)],
      source: 'snapshot_refresh',
      log,
      logDebug,
    });

    expect(changed).toBe(true);
    expect(log).not.toHaveBeenCalled();
    expect(logDebug).toHaveBeenCalledWith(
      expect.stringContaining('temporarily unavailable'),
    );
  });
});

describe('prunePendingTargetCommandsForPlan', () => {
  it('clears a pending target command when the plan changes to a different desired target', () => {
    const state = createPlanEngineState();
    state.pendingTargetCommands['dev-1'] = {
      capabilityId: 'target_temperature',
      desired: 23,
      startedMs: Date.now() - 5_000,
      lastAttemptMs: Date.now() - 5_000,
      retryCount: 0,
      nextRetryAtMs: Date.now() + 30_000,
      status: 'waiting_confirmation',
      lastObservedValue: 25,
      lastObservedSource: 'realtime_capability',
      lastObservedAtMs: Date.now() - 1_000,
    };
    const logDebug = jest.fn();

    const changed = prunePendingTargetCommandsForPlan({
      state,
      plan: {
        meta: {
          totalKw: 1,
          softLimitKw: 5,
          headroomKw: 4,
        },
        devices: [buildPlanDevice('dev-1', 'Heater', 25, 18)],
      },
      logDebug,
    });

    expect(changed).toBe(true);
    expect(state.pendingTargetCommands['dev-1']).toBeUndefined();
    expect(logDebug).toHaveBeenCalledWith(
      'Capacity: cleared pending target_temperature for Heater, current plan no longer wants 23°C',
    );
  });
});

describe('recordPendingTargetCommandAttempt', () => {
  it('does not carry stale observed metadata into a fresh non-retry pending command', () => {
    const state = createPlanEngineState();
    state.pendingTargetCommands['dev-1'] = {
      capabilityId: 'target_temperature',
      desired: 23,
      startedMs: Date.now() - 10_000,
      lastAttemptMs: Date.now() - 10_000,
      retryCount: 1,
      nextRetryAtMs: Date.now() + 20_000,
      status: 'waiting_confirmation',
      lastObservedValue: 27,
      lastObservedSource: 'realtime_capability',
      lastObservedAtMs: Date.now() - 1_000,
    };

    const pending = recordPendingTargetCommandAttempt({
      state,
      deviceId: 'dev-1',
      capabilityId: 'target_temperature',
      desired: 18,
      nowMs: Date.now(),
    });

    expect(pending).toMatchObject({
      capabilityId: 'target_temperature',
      desired: 18,
      retryCount: 0,
    });
    expect(pending.lastObservedValue).toBeUndefined();
    expect(pending.lastObservedSource).toBeUndefined();
    expect(pending.lastObservedAtMs).toBeUndefined();
  });

  it('records failed target commands as temporarily unavailable with retry backoff', () => {
    const state = createPlanEngineState();

    const pending = recordFailedPendingTargetCommandAttempt({
      state,
      deviceId: 'dev-1',
      capabilityId: 'target_temperature',
      desired: 18,
      nowMs: Date.now(),
      observedValue: 21,
    });

    expect(pending).toMatchObject({
      capabilityId: 'target_temperature',
      desired: 18,
      retryCount: 0,
      status: 'temporary_unavailable',
      lastObservedValue: 21,
    });
  });
});
