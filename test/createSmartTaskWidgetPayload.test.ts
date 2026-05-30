/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';
import {
  buildCreateSmartTaskDevicesPayload,
  EMPTY_NO_DEVICES_HINT,
  EMPTY_NO_DEVICES_SUBTITLE,
} from '../widgets/create_smart_task/src/createSmartTaskWidgetPayload';

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

  it('sorts eligible devices by name and drops ineligible ones', () => {
    const payload = buildCreateSmartTaskDevicesPayload({
      devices: [
        buildDevice({ id: 'ev', name: 'Zoe', deviceClass: 'evcharger' }),
        buildDevice({ id: 'plug', name: 'Lamp', deviceType: 'onoff' }),
        buildDevice({ id: 'heater', name: 'Attic', deviceType: 'temperature', targets: [{ id: 't', value: 20, unit: 'C' }] }),
      ],
    });
    if (payload.state !== 'ready') throw new Error('expected ready');
    expect(payload.devices.map((d) => d.deviceName)).toEqual(['Attic', 'Zoe']);
  });

  it('uses the device id as the name when the snapshot name is blank', () => {
    const payload = buildCreateSmartTaskDevicesPayload({
      devices: [buildDevice({ id: 'ev-1', name: '   ', deviceClass: 'evcharger' })],
    });
    if (payload.state !== 'ready') throw new Error('expected ready');
    expect(payload.devices[0].deviceName).toBe('ev-1');
  });
});
