import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBinaryControlPlan } from '../../lib/plan/planBinaryControl';
import {
  createPendingBinaryCommandStore,
  syncPendingBinaryCommands,
} from '../../lib/observer/pendingBinaryCommands';
import { createPlanEngineState } from '../../lib/plan/planState';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';

let logs: LoggerCapture;
beforeEach(() => { logs = captureLogger(); });
afterEach(() => { logs.restore(); vi.restoreAllMocks(); });

describe('generic binary observation and pending confirmation', () => {
  it('resolves a binary control plan from the semantic axis only', () => {
    expect(getBinaryControlPlan({ currentOn: false, canSetControl: true })).toEqual({ canSet: true });
    expect(getBinaryControlPlan({ currentOn: true, canSetControl: false })).toEqual({ canSet: false });
    expect(getBinaryControlPlan({ canSetControl: true })).toBeNull();
  });

  it.each([
    ['Connected 300', 'heater-1'],
    ['Elbillader', 'charger-1'],
  ])('keeps a delayed %s confirmation pending through the same generic observer path', (name, deviceId) => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands[deviceId] = {
      dispatchState: 'accepted',
      desired: true,
      startedMs: 1_000,
      pendingMs: 180_000,
    };
    vi.spyOn(Date, 'now').mockReturnValue(61_000);

    expect(syncPendingBinaryCommands({
      store: createPendingBinaryCommandStore(state.pendingBinaryCommands),
      source: 'snapshot_refresh',
      liveDevices: [{
        id: deviceId,
        name,
        binaryCommandConfirmation: {
          state: 'observed',
          observedValue: false,
          observedAtMs: 61_000,
        },
      }],
    })).toBe(true);
    expect(state.pendingBinaryCommands[deviceId]).toMatchObject({
      desired: true,
      pendingMs: 180_000,
      lastObservedValue: false,
      lastObservedSource: 'snapshot_refresh',
    });
  });

  it('confirms from normalized binary evidence without inspecting device kind', () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands['device-1'] = {
      dispatchState: 'accepted', desired: true, startedMs: 1_000, pendingMs: 90_000,
    };
    vi.spyOn(Date, 'now').mockReturnValue(2_000);

    expect(syncPendingBinaryCommands({
      store: createPendingBinaryCommandStore(state.pendingBinaryCommands),
      source: 'realtime_capability',
      liveDevices: [{
        id: 'device-1',
        name: 'Load',
        binaryCommandConfirmation: {
          state: 'observed',
          observedValue: true,
          observedAtMs: 2_000,
        },
      }],
    })).toBe(true);
    expect(state.pendingBinaryCommands['device-1']).toBeUndefined();
    expect(logs.findEvent('pending_binary_command_confirmed')).toMatchObject({
      deviceId: 'device-1', observedValue: true, source: 'realtime_capability',
    });
  });

  it('expires an unconfirmed command at its pending window', () => {
    const state = createPlanEngineState();
    state.pendingBinaryCommands['device-1'] = {
      dispatchState: 'accepted', desired: false, startedMs: 1_000, pendingMs: 90_000,
    };
    const store = createPendingBinaryCommandStore(state.pendingBinaryCommands);
    vi.spyOn(Date, 'now').mockReturnValue(91_000);
    expect(store.get('device-1')).toBeUndefined();
  });
});
