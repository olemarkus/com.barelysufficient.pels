/**
 * Unit coverage for the device-configuration resolver (`DeviceConfigurationStore`
 * in `lib/device/deviceConfiguration.ts`): the one place the inventory class
 * becomes the planner's identity facts. Downstream code reads `isEvCharger`,
 * `isBatteryOrSolar` and `starvationSupported` and never the class, so a wrong mapping
 * here is invisible everywhere else.
 *
 * The snapshots carry the identity the parse producer resolves from the class
 * (`transportSnapshotFixture`); that the real parser agrees for every class is
 * pinned in `test/integration/deviceIdentityFromClass.test.ts`. The shapes vary
 * the binary axis, the temperature facet and the charger axis independently of
 * the class, so resolving a flag from any field other than its owner fails a row.
 */
import { describe, expect, it } from 'vitest';
import {
  DeviceConfigurationStore,
  isStarvationSupportedDeviceClass,
} from '../../lib/device/deviceConfiguration';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import { transportSnapshotFixture } from '../utils/deviceSnapshotFixture';

const target = { id: 'target_temperature', value: 21, unit: '°C' } as const;

type Shape =
  | 'temperature_only'
  | 'temperature_onoff'
  | 'onoff'
  | 'observe_only'
  | 'charger_switch'
  | 'charger_target_power';

const SHAPE_FIELDS: Record<Shape, Partial<TransportDeviceSnapshot>> = {
  // A thermostat with a setpoint and no on/off switch.
  temperature_only: {
    deviceType: 'temperature',
    targets: [target],
    temperature: { currentTemperature: 20, target },
    capabilities: ['target_temperature', 'measure_temperature', 'measure_power'],
  },
  temperature_onoff: {
    deviceType: 'temperature',
    targets: [target],
    temperature: { currentTemperature: 20, target },
    binaryCapabilityId: 'onoff',
    binaryControl: { on: true },
    capabilities: ['onoff', 'target_temperature', 'measure_temperature', 'measure_power'],
  },
  onoff: {
    binaryCapabilityId: 'onoff',
    binaryControl: { on: true },
    capabilities: ['onoff', 'measure_power'],
  },
  // A battery or panel: no control axis at all.
  observe_only: {
    capabilities: ['measure_power'],
  },
  charger_switch: {
    binaryCapabilityId: 'evcharger_charging',
    binaryControl: { on: false },
    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
  },
  // A charger driven only through its amp ladder: still a charger, with no
  // charging switch to read it from.
  charger_target_power: {
    capabilities: ['target_power', 'evcharger_charging_state', 'measure_power'],
    steppedLoadProfile: {
      steps: [{ id: 'off', planningPowerW: 0 }, { id: '6a', planningPowerW: 1_380 }],
    },
  },
};

const snapshotFor = (deviceClass: string, shape: Shape, id = deviceClass): TransportDeviceSnapshot => (
  transportSnapshotFixture({
    id,
    name: `${deviceClass} device`,
    available: true,
    targets: [],
    expectedPowerKw: 1,
    expectedPowerSource: 'default',
    deviceClass,
    ...SHAPE_FIELDS[shape],
  } as Parameters<typeof transportSnapshotFixture>[0])
);

const resolve = (snapshot: TransportDeviceSnapshot) => {
  const store = new DeviceConfigurationStore();
  store.set(snapshot);
  return store.get(snapshot.id);
};

describe('DeviceConfigurationStore identity resolution', () => {
  it.each([
    ['thermostat', 'temperature_only', { isEvCharger: false, isBatteryOrSolar: false, starvationSupported: true }],
    ['heater', 'onoff', { isEvCharger: false, isBatteryOrSolar: false, starvationSupported: true }],
    ['heatpump', 'temperature_onoff', { isEvCharger: false, isBatteryOrSolar: false, starvationSupported: true }],
    ['airconditioning', 'temperature_onoff', { isEvCharger: false, isBatteryOrSolar: false, starvationSupported: true }],
    ['airtreatment', 'onoff', { isEvCharger: false, isBatteryOrSolar: false, starvationSupported: true }],
    ['battery', 'observe_only', { isEvCharger: false, isBatteryOrSolar: true, starvationSupported: false }],
    ['solarpanel', 'observe_only', { isEvCharger: false, isBatteryOrSolar: true, starvationSupported: false }],
    ['evcharger', 'charger_switch', { isEvCharger: true, isBatteryOrSolar: false, starvationSupported: false }],
    ['evcharger', 'charger_target_power', { isEvCharger: true, isBatteryOrSolar: false, starvationSupported: false }],
    ['socket', 'onoff', { isEvCharger: false, isBatteryOrSolar: false, starvationSupported: false }],
  ] as const)('resolves a %s (%s) to its identity facts', (deviceClass, shape, expected) => {
    expect(resolve(snapshotFor(deviceClass, shape))).toMatchObject(expected);
  });

  it('keeps the resolved facts per device across a replace', () => {
    const store = new DeviceConfigurationStore();
    store.replace([
      snapshotFor('evcharger', 'charger_switch', 'ev-1'),
      snapshotFor('battery', 'observe_only', 'battery-1'),
      snapshotFor('heatpump', 'temperature_onoff', 'heatpump-1'),
    ]);

    expect(store.get('ev-1')).toMatchObject({ isEvCharger: true, isBatteryOrSolar: false, starvationSupported: false });
    expect(store.get('battery-1')).toMatchObject({ isEvCharger: false, isBatteryOrSolar: true, starvationSupported: false });
    expect(store.get('heatpump-1')).toMatchObject({
      isEvCharger: false, isBatteryOrSolar: false, starvationSupported: true,
    });
  });

  it('resolves starvation support from the class case-insensitively and ignoring surrounding whitespace', () => {
    for (const deviceClass of ['thermostat', 'heater', 'heatpump', 'airconditioning', 'airtreatment']) {
      expect(resolve(snapshotFor(deviceClass.toUpperCase(), 'onoff'))?.starvationSupported).toBe(true);
      expect(resolve(snapshotFor(`  ${deviceClass}  `, 'onoff'))?.starvationSupported).toBe(true);
    }
  });
});

describe('isStarvationSupportedDeviceClass', () => {
  it('matches the thermostat-family classes, case-insensitively', () => {
    for (const cls of ['thermostat', 'heater', 'heatpump', 'airconditioning', 'airtreatment']) {
      expect(isStarvationSupportedDeviceClass(cls)).toBe(true);
      expect(isStarvationSupportedDeviceClass(cls.toUpperCase())).toBe(true);
      expect(isStarvationSupportedDeviceClass(`  ${cls}  `)).toBe(true);
    }
  });

  it('rejects non-thermostat classes and the empty class', () => {
    for (const cls of ['evcharger', 'socket', 'light', 'battery', 'solarpanel', '']) {
      expect(isStarvationSupportedDeviceClass(cls)).toBe(false);
    }
  });
});
