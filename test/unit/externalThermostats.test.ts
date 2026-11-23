import { describe, expect, it } from 'vitest';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import { partialDouble } from '../helpers/partialDouble';
import { ExternalThermostats, type ThermostatSettings } from '../../lib/device/transport/externalThermostats';
import { TransportSnapshotStore } from '../../lib/device/transport/transportSnapshotStore';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';

const load = {
  ...HOMEY_DEVICE_FIELDS,
  id: 'heater', name: 'Heater', class: 'heater', available: true, zone: 'main',
  capabilities: ['onoff', 'measure_power'],
  capabilitiesObj: {
    onoff: { value: true, lastUpdated: 1000, setable: true },
    measure_power: { value: 2200, lastUpdated: 3000 },
  },
} satisfies HomeyDeviceLike;

function thermostat(id = 'thermostat', zone = 'main'): HomeyDeviceLike {
  return {
    ...HOMEY_DEVICE_FIELDS,
    id, name: 'Thermostat', class: 'thermostat', zone, available: true,
    capabilities: ['measure_temperature', 'target_temperature', 'thermostat_mode'],
    capabilitiesObj: {
      measure_temperature: { value: 19, lastUpdated: 1500 },
      target_temperature: { value: 21, lastUpdated: 2000, setable: true, min: 5, max: 35, step: 0.5 },
      thermostat_mode: { value: 'CoOL', lastUpdated: 2000 },
    },
  };
}

function setup() {
  const inventory = new TransportSnapshotStore();
  const source = thermostat();
  const settings = {
    externalThermostats: { heater: source.id },
    managedDevices: { [load.id]: true },
    externalThermostatSettings: partialDouble<NonNullable<ThermostatSettings['externalThermostatSettings']>>({
      revision: () => 1,
      isWriteCurrent: () => true,
      isTemperatureWriteCurrent: () => true,
      allowsBinaryWrite: (id) => id !== load.id,
    }),
  };
  const external = new ExternalThermostats(settings, inventory, (_id, zone) => zone ?? undefined);
  inventory.replaceLatestRawDevices([load, source], [load, source]);
  return { external, inventory, settings, source };
}

function commitRead(external: ExternalThermostats, device = load) {
  const reading = external.read(device);
  const snapshot = partialDouble<TransportDeviceSnapshot>({
    id: device.id,
    externalThermostatDonorId: reading?.donorId,
    temperature: reading?.temperature,
    thermostatMode: reading?.thermostatMode,
  });
  external.commitSnapshot(snapshot);
  return { ...reading, temperature: snapshot.temperature };
}

describe('external thermostats', () => {
  it('uses the donor’s original report dates, target metadata, and thermal mode', () => {
    const { external, source } = setup();
    const reading = commitRead(external);
    expect(reading).toMatchObject({
      donorId: source.id, measuredAtMs: 1500, thermostatMode: 'cool',
      temperature: {
        currentTemperature: 19,
        target: { value: 21, min: 5, max: 35, step: 0.5, temperatureBindingObservedAtMs: 2000 },
      },
    });
    expect(external.resolveWrite(load.id, reading?.temperature?.target.temperatureBindingGeneration)).toBe(source.id);
    expect(external.resolveWrite(load.id, undefined)).toBeUndefined();
    expect(external.allowsBinaryWrite(load.id, false)).toBe(false);
    expect(external.allowsBinaryWrite(source.id, true)).toBe(false);
  });

  it('withdraws the old write authority on reassignment, source removal and native target arrival', () => {
    const { external, inventory, settings, source } = setup();
    const original = commitRead(external).temperature?.target.temperatureBindingGeneration;
    const second = thermostat('other');
    inventory.replaceLatestRawDevices([load, source, second], [load, source, second]);
    settings.externalThermostats.heater = second.id;
    const reassigned = commitRead(external).temperature?.target.temperatureBindingGeneration;
    expect(reassigned).not.toBe(original);
    expect(external.resolveWrite(load.id, original)).toBeUndefined();
    expect(external.resolveWrite(load.id, reassigned)).toBe(second.id);

    const nativeLoad = { ...load, capabilities: [...load.capabilities, 'target_temperature'] };
    inventory.replaceLatestRawDevices([nativeLoad, second], [nativeLoad, second]);
    expect(external.resolveWrite(load.id, reassigned)).toBeUndefined();
    expect(external.read(nativeLoad)?.temperature).toBeUndefined();

    inventory.replaceLatestRawDevices([load], [load]);
    expect(commitRead(external).temperature).toBeUndefined();
  });

  it('preserves newer realtime evidence over an in-flight read and withdraws a rejected temperature', () => {
    const { external, inventory, source } = setup();
    const initial = commitRead(external).temperature?.target.temperatureBindingGeneration;
    external.noteReport(source.id, 'target_temperature', undefined, 3000);
    expect(commitRead(external).temperature).toBeUndefined();
    expect(external.resolveWrite(load.id, initial)).toBeUndefined();

    external.noteReport(source.id, 'target_temperature', 23, 3500);
    const latest = { ...source, capabilitiesObj: {
      ...source.capabilitiesObj, target_temperature: { value: 23, setable: true, lastUpdated: 3500 },
    } };
    inventory.updateAcceptedRawDevice(latest);
    expect(external.mergeRefreshRead(source, 3100)).toBe(latest);
    const recovered = commitRead(external).temperature?.target;
    expect(recovered).toMatchObject({ value: 23, temperatureBindingObservedAtMs: 3500 });
    expect(recovered?.temperatureBindingGeneration).not.toBe(initial);
  });
});
