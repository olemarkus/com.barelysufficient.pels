import {
  isBinaryRestoreCandidate,
  getEvRestoreStateBlockReason,
  getEvUnknownPowerBlockReason,
  getInactiveReason,
  getOffDevices,
  getOnDevices,
  isRestoreLiveEligibleDevice,
  getSteppedRestoreCandidates,
  markOffDevicesStayOff,
} from '../lib/plan/planRestoreDevices';
import type { DevicePlanDevice } from '../lib/plan/planTypes';
import { legacyDeviceReason, reasonText } from './utils/deviceReasonTestUtils';

const makeDevice = (
  overrides: Partial<DevicePlanDevice> & { reason?: DevicePlanDevice['reason'] | string },
): DevicePlanDevice => {
  const reason = typeof overrides.reason === 'string' ? legacyDeviceReason(overrides.reason) : overrides.reason;
  return {
    id: overrides.id ?? 'dev',
    name: overrides.name ?? 'Device',
    currentState: overrides.currentState ?? 'off',
    plannedState: overrides.plannedState ?? 'keep',
    currentTarget: overrides.currentTarget ?? null,
    plannedTarget: overrides.plannedTarget ?? null,
    ...overrides,
    reason,
  };
};

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

  it('ignores stale observations when selecting restore and swap candidates', () => {
    const devices = [
      makeDevice({ id: 'fresh-off', priority: 1, currentState: 'off' }),
      makeDevice({ id: 'stale-off', priority: 2, currentState: 'off', observationStale: true }),
      makeDevice({
        id: 'fresh-step',
        priority: 3,
        currentState: 'on',
        controlModel: 'stepped_load',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1250 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'low',
      }),
      makeDevice({
        id: 'stale-step',
        priority: 4,
        currentState: 'on',
        observationStale: true,
        controlModel: 'stepped_load',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1250 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'low',
      }),
      makeDevice({
        id: 'unknown-step-off',
        priority: 2,
        currentState: 'off',
        controlModel: 'stepped_load',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1250 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: undefined,
      }),
      makeDevice({
        id: 'high-step-off',
        priority: 5,
        currentState: 'off',
        controlModel: 'stepped_load',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1250 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: 'max',
      }),
      makeDevice({
        id: 'unknown-step-on',
        priority: 3,
        currentState: 'on',
        controlModel: 'stepped_load',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1250 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
        selectedStepId: undefined,
      }),
      makeDevice({ id: 'fresh-on', priority: 5, currentState: 'on' }),
      makeDevice({ id: 'stale-on', priority: 6, currentState: 'on', observationStale: true }),
    ];

    expect(getOffDevices(devices).map((device) => device.id)).toEqual(['fresh-off']);
    expect(getSteppedRestoreCandidates(devices).map((device) => device.id))
      .toEqual(['unknown-step-off', 'fresh-step', 'high-step-off']);
    expect(getOnDevices(devices, () => ({ action: 'turn_off', temperature: null, stepId: null }))
      .map((device) => device.id)).toEqual(['fresh-on']);
  });

  it('evaluates EV restore blocks and marks off devices as staying off', () => {
    expect(getEvRestoreStateBlockReason(makeDevice({
      controlCapabilityId: 'evcharger_charging',
    }))).toBe('charger state unknown');
    expect(getEvRestoreStateBlockReason(makeDevice({
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_out',
    }))).toBe('charger is unplugged');
    expect(getEvRestoreStateBlockReason(makeDevice({
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in',
    }))).toBe('charger is not resumable');
    expect(getEvUnknownPowerBlockReason(makeDevice({
      controlCapabilityId: 'evcharger_charging',
      expectedPowerSource: 'default',
    }))).toBeNull();
    expect(getEvUnknownPowerBlockReason(makeDevice({
      controlCapabilityId: 'onoff',
      expectedPowerSource: 'default',
    }))).toBeNull();
    expect(reasonText(getInactiveReason(makeDevice({
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_out',
    })))).toBe('inactive (charger is unplugged)');
    expect(getInactiveReason(makeDevice({
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in_paused',
      expectedPowerSource: 'default',
    }))).toBeNull();

    const deviceMap = new Map<string, DevicePlanDevice>([
      ['dev1', makeDevice({ id: 'dev1', name: 'Device 1', powerKw: 1.1 })],
      ['dev2', makeDevice({ id: 'dev2', name: 'Device 2', reason: 'shed due to capacity', powerKw: 2.2 })],
      ['ev1', makeDevice({
        id: 'ev1',
        name: 'EV 1',
        controlCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_out',
        expectedPowerSource: 'load-setting',
      })],
    ]);
    const setDevice = vi.fn((id: string, updates: Partial<DevicePlanDevice>) => {
      const current = deviceMap.get(id);
      if (current) deviceMap.set(id, { ...current, ...updates });
    });
    markOffDevicesStayOff({
      deviceMap,
      timing: {
        activeOvershoot: false,
        inCooldown: true,
        restoreCooldownSeconds: 12,
        shedCooldownRemainingSec: 7,
      },
      setDevice,
    });
    expect(setDevice).toHaveBeenCalledWith(
      'dev1',
      expect.objectContaining({ reason: legacyDeviceReason('cooldown (shedding, 7s remaining)') }),
    );
    expect(setDevice).toHaveBeenCalledWith('ev1', expect.objectContaining({
      plannedState: 'inactive',
      reason: legacyDeviceReason('inactive (charger is unplugged)'),
    }));
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
      setDevice,
      reasonOverride: (device) => ({ code: 'other', text: `blocked ${device.id}` }),
    });
    expect(setDevice).toHaveBeenCalledWith(
      'dev2',
      expect.objectContaining({ reason: { code: 'other', text: 'blocked dev2' } }),
    );
  });

  it('shares the same live eligibility gate across restore candidate paths', () => {
    const eligible = makeDevice({ id: 'eligible', currentState: 'off' });
    const stale = makeDevice({ id: 'stale', currentState: 'off', observationStale: true });
    const shed = makeDevice({ id: 'shed', currentState: 'off', plannedState: 'shed' });

    expect(isRestoreLiveEligibleDevice(eligible)).toBe(true);
    expect(isBinaryRestoreCandidate(eligible)).toBe(true);
    expect(isBinaryRestoreCandidate(stale)).toBe(false);
    expect(isBinaryRestoreCandidate(shed)).toBe(false);
  });

  it('treats target-only devices with an explicit observed off state as off restore candidates', () => {
    const targetOnlyOff = makeDevice({
      id: 'target-only-off',
      currentState: 'not_applicable',
      currentOn: false,
    });

    expect(isBinaryRestoreCandidate(targetOnlyOff)).toBe(true);
  });
});
