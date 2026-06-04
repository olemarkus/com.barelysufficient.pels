/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import {
  buildCreateSmartTaskDevicesPayload,
  EMPTY_NO_DEVICES_HINT,
  EMPTY_NO_DEVICES_SUBTITLE,
} from '../../widgets/create_smart_task/src/createSmartTaskWidgetPayload';

const buildDevice = (overrides: Partial<TargetDeviceSnapshot> & { id: string; name: string }): TargetDeviceSnapshot => ({
  targets: [],
  currentOn: false,
  ...overrides,
} as TargetDeviceSnapshot);

describe('buildCreateSmartTaskDevicesPayload', () => {
  it('returns the empty state with hint when no eligible devices', () => {
    const payload = buildCreateSmartTaskDevicesPayload({
      devices: [buildDevice({ id: 'plug', name: 'Plug', deviceType: 'onoff' })],
    });
    expect(payload).toEqual({
      state: 'empty',
      subtitle: EMPTY_NO_DEVICES_SUBTITLE,
      hint: EMPTY_NO_DEVICES_HINT,
    });
  });

  it('maps a temperature device to a °C goal with device target bounds', () => {
    const payload = buildCreateSmartTaskDevicesPayload({
      devices: [buildDevice({
        id: 'heater',
        name: 'Hot water',
        deviceType: 'temperature',
        currentTemperature: 48,
        targets: [{ id: 'target_temperature', value: 50, unit: 'C', min: 30, max: 85, step: 0.5 }],
      })],
    });
    if (payload.state !== 'ready') throw new Error('expected ready');
    expect(payload.devices).toHaveLength(1);
    const device = payload.devices[0];
    expect(device).toMatchObject({
      deviceId: 'heater',
      deviceName: 'Hot water',
      kind: 'temperature',
      // Every temperature device groups as heating.
      group: 'heating',
      unitSymbol: '°C',
      goalMin: 30,
      goalMax: 85,
      goalStep: 0.5,
      currentValue: 48,
    });
    // Default goal is goal-oriented (the 60 °C common case, above current 48).
    expect(device.defaultGoal).toBe(60);
  });

  it('maps an EV charger to a % goal with a 1..100 battery range', () => {
    const payload = buildCreateSmartTaskDevicesPayload({
      devices: [buildDevice({
        id: 'ev',
        name: 'Driveway',
        deviceClass: 'evcharger',
        stateOfCharge: { percent: 42, status: 'fresh' },
      })],
    });
    if (payload.state !== 'ready') throw new Error('expected ready');
    expect(payload.devices[0]).toMatchObject({
      deviceId: 'ev',
      kind: 'ev_soc',
      group: 'ev_charger',
      unitSymbol: '%',
      goalMin: 1,
      goalMax: 100,
      goalStep: 1,
      currentValue: 42,
      // EV default seeds at the 80% common-case target, not the 42% current SoC.
      defaultGoal: 80,
    });
  });

  it('falls back to a thermostat range when a temperature device has no target bounds', () => {
    const payload = buildCreateSmartTaskDevicesPayload({
      devices: [buildDevice({
        id: 'heater',
        name: 'Radiator',
        deviceType: 'temperature',
        targets: [{ id: 'target_temperature', value: 20, unit: 'C' }],
      })],
    });
    if (payload.state !== 'ready') throw new Error('expected ready');
    expect(payload.devices[0]).toMatchObject({ goalMin: 5, goalMax: 95, goalStep: 0.5 });
  });

  it('orders by device group (heating → EV chargers) then name, dropping ineligible ones', () => {
    const payload = buildCreateSmartTaskDevicesPayload({
      devices: [
        buildDevice({ id: 'ev-z', name: 'Zoe', deviceClass: 'evcharger' }),
        buildDevice({ id: 'plug', name: 'Lamp', deviceType: 'onoff' }),
        buildDevice({ id: 'ev-a', name: 'Audi', deviceClass: 'evcharger' }),
        buildDevice({ id: 'tank', name: 'Tank', deviceClass: 'waterheater', deviceType: 'temperature', targets: [{ id: 't', value: 60, unit: 'C' }] }),
        buildDevice({ id: 'attic', name: 'Attic', deviceType: 'temperature', targets: [{ id: 't', value: 20, unit: 'C' }] }),
        buildDevice({ id: 'boiler', name: 'Cellar', deviceClass: 'boiler', deviceType: 'temperature', targets: [{ id: 't', value: 60, unit: 'C' }] }),
      ],
    });
    if (payload.state !== 'ready') throw new Error('expected ready');
    // All temperature devices group as heating (water heaters can't be told
    // apart from thermostats at runtime), ordered by name (Attic, Cellar,
    // Tank), then EV chargers by name (Audi, Zoe); the on/off plug is dropped.
    expect(payload.devices.map((d) => [d.deviceName, d.group])).toEqual([
      ['Attic', 'heating'],
      ['Cellar', 'heating'],
      ['Tank', 'heating'],
      ['Audi', 'ev_charger'],
      ['Zoe', 'ev_charger'],
    ]);
  });

  it('uses the device id as the name when the snapshot name is blank', () => {
    const payload = buildCreateSmartTaskDevicesPayload({
      devices: [buildDevice({ id: 'ev-1', name: '   ', deviceClass: 'evcharger' })],
    });
    if (payload.state !== 'ready') throw new Error('expected ready');
    expect(payload.devices[0].deviceName).toBe('ev-1');
  });

  describe('supportsLimitLowerPriority (gate-on-effect)', () => {
    const steppedHeater = (overrides: Partial<TargetDeviceSnapshot>): TargetDeviceSnapshot => buildDevice({
      id: 'heater',
      name: 'Hot water',
      deviceType: 'temperature',
      currentTemperature: 48,
      targets: [{ id: 'target_temperature', value: 50, unit: 'C', min: 30, max: 85, step: 0.5 }],
      controlModel: 'stepped_load',
      steppedLoadProfile: { model: 'stepped_load' } as TargetDeviceSnapshot['steppedLoadProfile'],
      ...overrides,
    });
    const firstDevice = (device: TargetDeviceSnapshot): boolean => {
      const payload = buildCreateSmartTaskDevicesPayload({ devices: [device] });
      if (payload.state !== 'ready') throw new Error('expected ready');
      return payload.devices[0].supportsLimitLowerPriority;
    };

    it('is true for a stepped-load device at top priority (1)', () => {
      expect(firstDevice(steppedHeater({ priority: 1 }))).toBe(true);
    });

    it('is false for a stepped-load device below top priority (inert there)', () => {
      expect(firstDevice(steppedHeater({ priority: 100 }))).toBe(false);
    });

    it('is false for a stepped-load device with no priority set', () => {
      expect(firstDevice(steppedHeater({ priority: undefined }))).toBe(false);
    });

    it('is false for a non-stepped (binary) device even at top priority', () => {
      expect(firstDevice(steppedHeater({ controlModel: undefined, steppedLoadProfile: undefined, priority: 1 })))
        .toBe(false);
    });
  });
});
