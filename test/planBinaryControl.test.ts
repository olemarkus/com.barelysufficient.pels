import { createPlanEngineState } from '../lib/plan/planState';
import {
  formatEvSnapshot,
  getBinaryControlPlan,
  getEvRestoreBlockReason,
  setBinaryControl,
} from '../lib/plan/planBinaryControl';

describe('plan binary control helpers', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves binary control plans and EV restore blocks', () => {
    expect(getBinaryControlPlan()).toBeNull();
    expect(getBinaryControlPlan({
      id: 'dev1',
      name: 'Socket',
      controlCapabilityId: 'onoff',
      canSetControl: true,
    })).toEqual({ capabilityId: 'onoff', isEv: false, canSet: true });
    expect(getBinaryControlPlan({
      id: 'ev1',
      name: 'EV',
      capabilities: ['evcharger_charging'],
      canSetControl: false,
    })).toEqual({ capabilityId: 'evcharger_charging', isEv: true, canSet: false });

    expect(getEvRestoreBlockReason({ id: 'ev1', name: 'EV', controlCapabilityId: 'evcharger_charging', expectedPowerSource: 'default' })).toBe('charger power unknown');
    expect(getEvRestoreBlockReason({ id: 'ev1', name: 'EV', controlCapabilityId: 'evcharger_charging' })).toBe('charger state unknown');
    expect(getEvRestoreBlockReason({ id: 'ev1', name: 'EV', controlCapabilityId: 'evcharger_charging', evChargingState: 'plugged_out' })).toBe('charger is unplugged');
    expect(getEvRestoreBlockReason({ id: 'ev1', name: 'EV', controlCapabilityId: 'evcharger_charging', evChargingState: 'plugged_in' })).toBeNull();
    expect(getEvRestoreBlockReason({ id: 'ev1', name: 'EV', controlCapabilityId: 'evcharger_charging', evChargingState: 'mystery' })).toBe("unknown charging state 'mystery'");
    expect(formatEvSnapshot()).toBe('snapshot=missing');
  });

  it('handles EV and standard binary control actions', async () => {
    const state = createPlanEngineState();
    const updateLocalSnapshot = jest.fn();
    const log = jest.fn();
    const logDebug = jest.fn();
    const error = jest.fn();
    const deviceManager = {
      setCapability: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn().mockReturnValue([
        { id: 'ev1', name: 'EV', currentOn: true, evChargingState: 'plugged_in_charging', controlCapabilityId: 'evcharger_charging' },
      ]),
    };

    await expect(setBinaryControl({
      state,
      deviceManager: deviceManager as never,
      updateLocalSnapshot,
      log,
      logDebug,
      error,
      deviceId: 'ev1',
      name: 'EV',
      desired: true,
      snapshot: {
        id: 'ev1',
        name: 'EV',
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        canSetControl: true,
        evChargingState: 'plugged_in_paused',
      },
      logContext: 'capacity',
    })).resolves.toBe(true);
    expect(deviceManager.setCapability).toHaveBeenCalledWith('ev1', 'evcharger_charging', true);
    expect(updateLocalSnapshot).toHaveBeenCalledWith('ev1', { on: true });
    expect(log).toHaveBeenCalledWith('Capacity: resumed charging for EV');

    await expect(setBinaryControl({
      state,
      deviceManager: deviceManager as never,
      updateLocalSnapshot,
      log,
      logDebug,
      error,
      deviceId: 'ev1',
      name: 'EV',
      desired: true,
      snapshot: {
        id: 'ev1',
        name: 'EV',
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        canSetControl: true,
      },
      logContext: 'capacity',
    })).resolves.toBe(false);
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('already pending'));

    jest.spyOn(Date, 'now').mockReturnValue(state.pendingBinaryCommands.ev1.startedMs + 20_000);
    await expect(setBinaryControl({
      state,
      deviceManager: deviceManager as never,
      updateLocalSnapshot,
      log,
      logDebug,
      error,
      deviceId: 'socket1',
      name: 'Socket',
      desired: false,
      snapshot: {
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        canSetControl: true,
      },
      logContext: 'capacity',
      reason: 'shedding',
    })).resolves.toBe(true);
    expect(deviceManager.setCapability).toHaveBeenCalledWith('socket1', 'onoff', false);
    expect(log).toHaveBeenCalledWith('Capacity: turned off Socket (shedding)');
  });

  it('handles missing, blocked, and failing binary control requests', async () => {
    const state = createPlanEngineState();
    const updateLocalSnapshot = jest.fn();
    const log = jest.fn();
    const logDebug = jest.fn();
    const error = jest.fn();
    const failingManager = {
      setCapability: jest.fn().mockRejectedValue(new Error('kaput')),
      getSnapshot: jest.fn().mockReturnValue([]),
    };

    await expect(setBinaryControl({
      state,
      deviceManager: failingManager as never,
      updateLocalSnapshot,
      log,
      logDebug,
      error,
      deviceId: 'ev1',
      name: 'EV',
      desired: false,
      snapshot: { id: 'ev1', name: 'EV', deviceClass: 'evcharger' },
      logContext: 'capacity',
    })).resolves.toBe(false);
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('no binary control plan'));

    await expect(setBinaryControl({
      state,
      deviceManager: failingManager as never,
      updateLocalSnapshot,
      log,
      logDebug,
      error,
      deviceId: 'ev1',
      name: 'EV',
      desired: false,
      snapshot: {
        id: 'ev1',
        name: 'EV',
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        canSetControl: false,
      },
      logContext: 'capacity',
    })).resolves.toBe(false);
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('capability not setable'));

    await expect(setBinaryControl({
      state,
      deviceManager: failingManager as never,
      updateLocalSnapshot,
      log,
      logDebug,
      error,
      deviceId: 'socket1',
      name: 'Socket',
      desired: true,
      snapshot: {
        id: 'socket1',
        name: 'Socket',
        controlCapabilityId: 'onoff',
        canSetControl: true,
      },
      logContext: 'capacity_control_off',
    })).resolves.toBe(false);
    expect(error).toHaveBeenCalledWith('Failed to turn on Socket via DeviceManager', expect.any(Error));
  });
});
