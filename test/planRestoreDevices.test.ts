import {
  getEvRestoreStateBlockReason,
  getEvUnknownPowerBlockReason,
  getOffDevices,
  getOnDevices,
  markOffDevicesStayOff,
} from '../lib/plan/planRestoreDevices';
import type { DevicePlanDevice } from '../lib/plan/planTypes';

const makeDevice = (overrides: Partial<DevicePlanDevice>): DevicePlanDevice => ({
  id: overrides.id ?? 'dev',
  name: overrides.name ?? 'Device',
  currentState: overrides.currentState ?? 'off',
  plannedState: overrides.plannedState ?? 'keep',
  currentTarget: overrides.currentTarget ?? null,
  plannedTarget: overrides.plannedTarget ?? null,
  ...overrides,
});

describe('plan restore device helpers', () => {
  it('filters restore candidates and swap-out devices by priority and shed behavior', () => {
    const devices = [
      makeDevice({ id: 'low', priority: 1, currentState: 'off' }),
      makeDevice({ id: 'high', priority: 5, currentState: 'off' }),
      makeDevice({ id: 'on', priority: 10, currentState: 'on' }),
      makeDevice({ id: 'na', priority: 7, currentState: 'not_applicable' }),
      makeDevice({ id: 'temp-blocked', priority: 8, currentState: 'on', currentTarget: 21, plannedTarget: 21 }),
      makeDevice({ id: 'shed', currentState: 'off', plannedState: 'shed' }),
    ];

    expect(getOffDevices(devices).map((device) => device.id)).toEqual(['low', 'high']);
    expect(getOnDevices(devices, (deviceId) => (
      deviceId === 'temp-blocked'
        ? { action: 'set_temperature', temperature: 21 }
        : { action: 'turn_off', temperature: null }
    )).map((device) => device.id)).toEqual(['on', 'na']);
    expect(getOnDevices(
      [makeDevice({ id: 'temp', currentState: 'on', currentTarget: 23, plannedTarget: 23 })],
      () => ({ action: 'set_temperature', temperature: 20 }),
    ).map((device) => device.id)).toEqual(['temp']);
    expect(getOnDevices(
      [makeDevice({ id: 'temp', currentState: 'on', currentTarget: 20, plannedTarget: 20 })],
      () => ({ action: 'set_temperature', temperature: 20 }),
    )).toEqual([]);
  });

  it('evaluates EV restore blocks and marks off devices as staying off', () => {
    expect(getEvRestoreStateBlockReason(makeDevice({
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_out',
    }))).toBe('charger is unplugged');
    expect(getEvRestoreStateBlockReason(makeDevice({
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in',
    }))).toBeNull();
    expect(getEvUnknownPowerBlockReason(makeDevice({
      controlCapabilityId: 'evcharger_charging',
      expectedPowerSource: 'default',
    }))).toContain('charger power unknown');
    expect(getEvUnknownPowerBlockReason(makeDevice({
      controlCapabilityId: 'onoff',
      expectedPowerSource: 'default',
    }))).toBeNull();

    const deviceMap = new Map<string, DevicePlanDevice>([
      ['dev1', makeDevice({ id: 'dev1', name: 'Device 1', powerKw: 1.1 })],
      ['dev2', makeDevice({ id: 'dev2', name: 'Device 2', reason: 'shed due to capacity', powerKw: 2.2 })],
    ]);
    const setDevice = jest.fn((id: string, updates: Partial<DevicePlanDevice>) => {
      const current = deviceMap.get(id);
      if (current) deviceMap.set(id, { ...current, ...updates });
    });
    const logDebug = jest.fn();

    markOffDevicesStayOff({
      deviceMap,
      timing: {
        activeOvershoot: false,
        inCooldown: true,
        restoreCooldownSeconds: 12,
        shedCooldownRemainingSec: 7,
      },
      logDebug,
      setDevice,
    });
    expect(setDevice).toHaveBeenCalledWith('dev1', expect.objectContaining({ reason: 'cooldown (shedding, 7s remaining)' }));
    setDevice.mockClear();
    deviceMap.set('dev2', makeDevice({ id: 'dev2', name: 'Device 2', reason: 'shed due to capacity', powerKw: 2.2 }));

    markOffDevicesStayOff({
      deviceMap,
      timing: {
        activeOvershoot: false,
        inCooldown: false,
        restoreCooldownSeconds: 9,
        shedCooldownRemainingSec: null,
      },
      logDebug,
      setDevice,
      reasonOverride: (device) => `blocked ${device.id}`,
    });
    expect(setDevice).toHaveBeenCalledWith('dev2', expect.objectContaining({ reason: 'blocked dev2' }));
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining('Plan: skipping restore of Device 1'));
  });
});
