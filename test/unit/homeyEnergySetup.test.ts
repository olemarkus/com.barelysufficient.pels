import { needsHomeyEnergySetup } from '../../packages/shared-domain/src/homeyEnergySetup';

const unconfiguredSocket = {
  binaryControllable: true, isEvCharger: false, powerCapable: false, capabilities: ['onoff'],
};

describe('Homey Energy device setup', () => {
  it('requires setup for a native binary device without power support', () => {
    expect(needsHomeyEnergySetup(unconfiguredSocket)).toBe(true);
  });

  it('clears after Homey power information becomes available', () => {
    expect(needsHomeyEnergySetup({ ...unconfiguredSocket, powerCapable: true })).toBe(false);
  });

  it('also advises on/off devices that have a temperature target', () => {
    expect(needsHomeyEnergySetup({
      ...unconfiguredSocket, capabilities: ['onoff', 'target_temperature'],
    })).toBe(true);
  });

  it('does not invent a setup requirement for absent devices, rejected binary state or chargers', () => {
    expect(needsHomeyEnergySetup(undefined)).toBe(false);
    expect(needsHomeyEnergySetup({ ...unconfiguredSocket, binaryControllable: false })).toBe(false);
    expect(needsHomeyEnergySetup({ ...unconfiguredSocket, capabilities: ['target_temperature'] })).toBe(false);
    expect(needsHomeyEnergySetup({ ...unconfiguredSocket, isEvCharger: true })).toBe(false);
  });
});
