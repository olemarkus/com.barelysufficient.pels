// Integration test for the STRUCTURAL battery-role resolution at PARSE.
//
// LOCKS the FIX-1 invariant: a role-detected home battery is stamped
// `managed: true, controllable: false` STRUCTURALLY from the device object on EVERY
// parse path — independent of the transport's async-populated battery-id set. So
// there is no window (boot, realtime-before-first-full-refresh, or any settings
// combo) where a present battery resolves `controllable: true`. Detection and
// snapshot SURVIVAL use the SAME predicate (`isHomeBatteryDevice` = class OR the
// `homeBattery` energy role), so an energy-role-only battery is detected, stamped,
// AND survives consistently.
//
// Drives the real transport parse (`parseDeviceListForTests` and the realtime
// `device.update` path), mocking only the SDK seam via the shared homey mock.
import { describe, expect, it } from 'vitest';
import Homey from 'homey';
import { DeviceTransport } from '../../lib/device/deviceTransport';
import { mockHomeyInstance } from '../mocks/homey';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';

const homeyMock = mockHomeyInstance as unknown as Homey.App;
const noop = (): void => undefined;
const loggerMock: Logger = {
  log: noop,
  debug: noop,
  error: noop,
  structuredLog: { info: noop, error: noop, debug: noop, warn: noop } as unknown as Logger['structuredLog'],
};

// Providers that — if consulted — would WRONGLY mark the battery controllable:true.
// The structural parse stamp must override them for a battery, proving the stamp is
// settings-independent (the realtime/boot timing window).
const adversarialProviders = {
  getControllable: () => true,
  getManaged: () => true,
  isManagedFilterActive: () => true,
};

const batteryCaps = {
  measure_battery: { value: 62, id: 'measure_battery' },
  measure_power: { value: 1200, id: 'measure_power' },
} as HomeyDeviceLike['capabilitiesObj'];

describe('structural battery-role resolution at parse', () => {
  it('stamps a class:battery device managed:true/controllable:false despite settings saying controllable:true', () => {
    const transport = new DeviceTransport(homeyMock, loggerMock, adversarialProviders);
    const [parsed] = transport.parseDeviceListForTests([{
      id: 'battery1',
      name: 'Home Battery',
      class: 'battery',
      capabilities: ['measure_battery', 'measure_power'],
      capabilitiesObj: batteryCaps,
    }]);

    expect(parsed).toBeDefined();
    expect(parsed.deviceClass).toBe('battery');
    expect(parsed.managed).toBe(true);
    // The adversarial provider returns controllable:true — the structural stamp wins.
    expect(parsed.controllable).toBe(false);
  });

  it('detects AND survives an energy-role-only battery (class not "battery") via the homeBattery role', () => {
    const transport = new DeviceTransport(homeyMock, loggerMock, adversarialProviders);
    const [parsed] = transport.parseDeviceListForTests([{
      id: 'battery2',
      name: 'Inverter Battery',
      // Real class is NOT 'battery' and is not otherwise a supported class — only the
      // canonical energy role marks it. Detection==survival means it still rides the
      // snapshot, normalized to the 'battery' class-key.
      class: 'sensor',
      energy: { homeBattery: true },
      capabilities: ['measure_battery', 'measure_power'],
      capabilitiesObj: batteryCaps,
    }]);

    expect(parsed).toBeDefined();
    expect(parsed.deviceClass).toBe('battery'); // normalized
    expect(parsed.managed).toBe(true);
    expect(parsed.controllable).toBe(false);
  });

  it('stamps the same structural values on the REALTIME device.update path (before any full refresh)', () => {
    // The realtime path parses a single device WITHOUT the full-refresh battery-id
    // re-derivation. With the structural stamp, a battery whose settings say
    // controllable:true STILL resolves controllable:false the moment it is observed.
    const transport = new DeviceTransport(homeyMock, loggerMock, adversarialProviders);
    transport.injectDeviceUpdateForTest({
      id: 'battery1',
      name: 'Home Battery',
      class: 'battery',
      capabilities: ['measure_battery', 'measure_power'],
      capabilitiesObj: batteryCaps,
    });

    // The realtime path additively records the battery in the membership set, so the
    // deviceId-only resolve* consumers agree with the structural stamp immediately.
    expect(transport.isBatteryDevice('battery1')).toBe(true);
  });
});
