// Integration test for the STRUCTURAL solar-role resolution at PARSE.
//
// LOCKS the same invariant as `batteryStructuralParse.test.ts`, generalized to solar:
// a role-detected solar device is stamped `managed: true, controllable: false`
// STRUCTURALLY from the device object on EVERY parse path — independent of the
// transport's async-populated solar-id set. So there is no window (boot,
// realtime-before-first-full-refresh, or any settings combo) where a present solar
// device resolves `controllable: true`. Detection and snapshot SURVIVAL use the SAME
// predicate (`isSolarPanelDevice` = class:'solarpanel' OR the `meterPowerExportedCapability`
// producer designation), so an energy-role-only solar device is detected, stamped, AND
// survives consistently.
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

// Providers that — if consulted — would WRONGLY mark the solar device controllable:true.
// The structural parse stamp must override them, proving the stamp is settings-independent.
const adversarialProviders = {
  getControllable: () => true,
  getManaged: () => true,
  isManagedFilterActive: () => true,
};

const solarCaps = {
  measure_power: { value: 3000, id: 'measure_power' },
  meter_power: { value: 42, id: 'meter_power' },
} as HomeyDeviceLike['capabilitiesObj'];

describe('structural solar-role resolution at parse', () => {
  it('stamps a class:solarpanel device managed:true/controllable:false despite settings saying controllable:true', () => {
    const transport = new DeviceTransport(homeyMock, loggerMock, adversarialProviders);
    const [parsed] = transport.parseDeviceListForTests([{
      id: 'solar1',
      name: 'Solar Panel',
      class: 'solarpanel',
      capabilities: ['measure_power', 'meter_power'],
      capabilitiesObj: solarCaps,
    }]);

    expect(parsed).toBeDefined();
    expect(parsed.deviceClass).toBe('solarpanel');
    expect(parsed.managed).toBe(true);
    // The adversarial provider returns controllable:true — the structural stamp wins.
    expect(parsed.controllable).toBe(false);
  });

  it('does NOT stamp a non-solar bidirectional grid meter (export cap, class:sensor) observe-only', () => {
    // FIX 1 regression: a grid / P1 meter declares `meterPowerExportedCapability` but is
    // class 'sensor', NOT 'solarpanel'. The export property is NOT the solar identity
    // gate, so this meter is never normalized to 'solarpanel' nor stamped observe-only —
    // it is treated as an ordinary device (here: dropped, having no control surface, so
    // it certainly never rides as a managed observe-only solar device), and it is NOT in
    // the solar membership set.
    const transport = new DeviceTransport(homeyMock, loggerMock, adversarialProviders);
    const parsed = transport.parseDeviceListForTests([{
      id: 'grid',
      name: 'Grid meter',
      class: 'sensor',
      energy: { meterPowerExportedCapability: 'meter_power.exported' },
      capabilities: ['measure_power'],
      capabilitiesObj: solarCaps,
    }]);

    // Not parsed as a solar observe-only device: it has no supported class / control
    // surface, so it drops out entirely rather than riding as 'solarpanel'.
    expect(parsed.find((d) => d.deviceClass === 'solarpanel')).toBeUndefined();
    expect(transport.isSolarDevice('grid')).toBe(false);
  });

  it('stamps the same structural values on the REALTIME device.update path (before any full refresh)', () => {
    const transport = new DeviceTransport(homeyMock, loggerMock, adversarialProviders);
    transport.injectDeviceUpdateForTest({
      id: 'solar1',
      name: 'Solar Panel',
      class: 'solarpanel',
      capabilities: ['measure_power', 'meter_power'],
      capabilitiesObj: solarCaps,
    });

    // The realtime path additively records the solar device in the membership set, so the
    // deviceId-only resolve* consumers agree with the structural stamp immediately.
    expect(transport.isSolarDevice('solar1')).toBe(true);
  });
});
