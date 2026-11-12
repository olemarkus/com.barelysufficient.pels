import Homey from 'homey';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLogger } from '../../lib/logging/logger';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { emitCapability, emitDeviceUpdate } from '../helpers/liveFeedSocketHarness';
import { DEVICES_API_PATH, setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { mockHomeyInstance } from '../mocks/homey';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';
import type { DeviceTransport } from '../../lib/device/deviceTransport';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import type { HomeBatteryDescriptorProbe } from '../../packages/contracts/src/types';

const logger: Logger = { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('devices') };
const STAMP = '2026-11-12T06:00:00.000Z';
const GROUP = 'p1~battery_group';
const MODES = ['zero', 'zero_charge_only', 'zero_discharge_only', 'standby', 'to_full', 'predictive'];

// HomeWizard 3.20.3: the P1 meter (`energy_v2`) carries the group of Plug-In
// Batteries it steers, next to the household's own import and export.
const p1 = (overrides: Partial<HomeyDeviceLike> = {}, mode = 'zero'): HomeyDeviceLike => ({
  ...HOMEY_DEVICE_FIELDS,
  id: 'p1', name: 'P1 meter', class: 'sensor', driverId: 'homey:app:com.homewizard:energy_v2',
  ownerUri: 'homey:app:com.homewizard',
  capabilities: [
    'measure_power', 'meter_power.consumed', 'meter_power.returned',
    'measure_power.battery_group_power_w', 'measure_power.battery_group_target_power_w',
    'measure_power.battery_group_max_consumption_w', 'measure_power.battery_group_max_production_w',
    'battery_group_total_capacity_kwh', 'battery_group_average_soc', 'battery_group_state', 'battery_group_charge_mode',
  ],
  capabilitiesObj: {
    measure_power: { value: 1450, lastUpdated: STAMP },
    'meter_power.consumed': { value: 12000, lastUpdated: STAMP },
    'meter_power.returned': { value: 3000, lastUpdated: STAMP },
    'measure_power.battery_group_power_w': { value: -320, lastUpdated: STAMP },
    'measure_power.battery_group_target_power_w': { value: -320, lastUpdated: STAMP },
    'measure_power.battery_group_max_consumption_w': { value: 800, lastUpdated: STAMP },
    'measure_power.battery_group_max_production_w': { value: 800, lastUpdated: STAMP },
    battery_group_total_capacity_kwh: { value: 2.7, lastUpdated: STAMP },
    battery_group_average_soc: { value: 64, units: '%', lastUpdated: STAMP },
    battery_group_state: { value: 'discharging', lastUpdated: STAMP },
    battery_group_charge_mode: {
      value: mode, setable: true, lastUpdated: STAMP, ...({ values: MODES.map((id) => ({ id })) } as object),
    },
  },
  settings: {},
  available: true, ready: true,
  ...overrides,
});

const plainP1 = (): HomeyDeviceLike => {
  const meter = p1();
  const keep = (id: string) => !id.includes('battery_group');
  return {
    ...meter,
    capabilities: meter.capabilities.filter(keep),
    capabilitiesObj: Object.fromEntries(Object.entries(meter.capabilitiesObj).filter(([id]) => keep(id))),
  };
};

const plugInBattery = (id = 'battery-1'): HomeyDeviceLike => ({
  ...HOMEY_DEVICE_FIELDS,
  id, name: 'Plug-In Battery', class: 'battery', driverId: 'homey:app:com.homewizard:plugin_battery',
  ownerUri: 'homey:app:com.homewizard',
  capabilities: ['measure_battery', 'battery_charging_state', 'measure_power', 'target_power_mode'],
  capabilitiesObj: {
    measure_battery: { value: 64, lastUpdated: STAMP },
    battery_charging_state: { value: 'discharging', lastUpdated: STAMP },
    measure_power: { value: -320, lastUpdated: STAMP },
    target_power_mode: { value: 'device', setable: true, lastUpdated: STAMP, ...({ values: [{ id: 'device' }] } as object) },
  },
  settings: {}, available: true, ready: true,
});

const seed = async (devices: readonly HomeyDeviceLike[]) => {
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger);
  await initWithLiveFeed(transport);
  await seedTransportDevices(transport, devices);
  return transport;
};

const view = (transport: DeviceTransport, id: string) => transport.getSnapshotByDeviceId(id);
const surfaceOf = (transport: DeviceTransport, id: string) => (
  (view(transport, id) as HomeBatteryDescriptorProbe | undefined)?.homeBattery?.controlSurface
);

describe('HomeWizard Plug-In Batteries as one group battery', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('reads the P1 as the meter it is and its battery group as one battery, and drops the batteries\' own devices', async () => {
    const transport = await seed([p1(), plugInBattery('battery-1'), plugInBattery('battery-2')]);
    // The P1 stays a meter: Homey Energy reads it by its own id, and PELS lists no device for it.
    expect(transport.getSnapshot().map((device) => device.id)).toEqual([GROUP]);
    expect(view(transport, GROUP)).toMatchObject({ name: 'P1 meter batteries', batteryLevel: { percent: 64 } });
    expect(view(transport, GROUP)?.batteryPower?.signedW).toBe(-320);
    expect(view(transport, 'battery-1')).toBeUndefined();
    expect(view(transport, 'battery-2')).toBeUndefined();
  });

  it('drives the group by its mode, with its limits as the range and its charge limit as its grid charge', async () => {
    const transport = await seed([p1()]);
    expect(surfaceOf(transport, GROUP)).toEqual({
      kind: 'setpoint',
      response: {
        kind: 'follows_meter',
        modes: {
          discharge: 'zero_discharge_only', hold: 'standby', chargeSurplus: 'zero_charge_only', chargeGrid: 'to_full',
          gridChargeW: 800, gridChargingModes: ['to_full', 'predictive'],
        },
      },
      claim: { capabilityId: 'battery_group_charge_mode', values: MODES, rejection: 'unanswered' },
      range: { minW: -800, maxW: 800, stepW: 1, excludeMinW: 0, excludeMaxW: 0 },
    });
    expect(view(transport, GROUP)?.batteryClaim).toMatchObject({ value: 'zero' });
  });

  it('only watches a group whose limits the P1 has not reported', async () => {
    const meter = p1();
    const transport = await seed([p1({
      capabilitiesObj: {
        ...meter.capabilitiesObj,
        'measure_power.battery_group_max_consumption_w': { value: 0, lastUpdated: STAMP },
      },
    })]);
    expect(surfaceOf(transport, GROUP)).toMatchObject({ kind: 'observe_only' });
  });

  it('leaves a P1 with no batteries as the meter alone', async () => {
    const transport = await seed([plainP1()]);
    expect(transport.getSnapshot()).toEqual([]);
  });

  it('routes the group\'s live reports to the group battery, and the meter\'s to the P1', async () => {
    const transport = await seed([p1()]);
    await emitCapability('p1', 'measure_power.battery_group_power_w', 640);
    await emitCapability('p1', 'battery_group_average_soc', 66);
    await emitCapability('p1', 'battery_group_charge_mode', 'to_full');
    // The household's own power stays the meter's: the group battery's power is its own.
    await emitCapability('p1', 'measure_power', 2100);
    expect(view(transport, GROUP)?.batteryPower?.signedW).toBe(640);
    expect(view(transport, GROUP)?.batteryLevel?.percent).toBe(66);
    expect(view(transport, GROUP)?.batteryClaim).toMatchObject({ value: 'to_full' });
    expect(transport.getSnapshot().map((device) => device.id)).toEqual([GROUP]);
  });

  it('writes each command as the group\'s mode on the P1, and hands back to the recorded mode alone', async () => {
    const transport = await seed([p1()]);
    const put = vi.spyOn(mockHomeyInstance.api, 'put').mockResolvedValue(undefined);
    const command = (setpointW: number) => transport.requestStoragePower({
      kind: 'storage_power', deviceId: GROUP, setpointW, control: { kind: 'capability' },
    });
    await command(-400);
    await command(0);
    await command(300);
    await command(800);
    await transport.releaseStorageControl({
      kind: 'storage_release', deviceId: GROUP, handBack: 'claim_capability', restoreClaimValue: 'zero',
    });
    const writes = put.mock.calls.map(([path, body]) => [path, (body as { value: unknown }).value]);
    const path = 'manager/devices/device/p1/capability/battery_group_charge_mode';
    expect(writes).toEqual([
      [path, 'zero_discharge_only'], [path, 'standby'], [path, 'zero_charge_only'], [path, 'to_full'], [path, 'zero'],
    ]);
  });

  it('splits a device standing in for the P1 through its compatibility settings the same way', async () => {
    const mock = p1({
      id: 'mock-p1', driverId: 'homey:app:com.olemarkus.testdevices:p1', ownerUri: 'homey:app:com.olemarkus.testdevices',
      settings: {
        pelsCompatibilityOwnerUri: 'homey:app:com.homewizard',
        pelsCompatibilityDriverId: 'homey:app:com.homewizard:energy_v2',
      },
    });
    const transport = await seed([mock]);
    expect(surfaceOf(transport, 'mock-p1~battery_group')).toMatchObject({ response: { kind: 'follows_meter' } });
    await emitCapability('mock-p1', 'battery_group_average_soc', 70);
    expect(view(transport, 'mock-p1~battery_group')?.batteryLevel?.percent).toBe(70);
  });

  it('removes the group battery at once when a device update shows its P1 no longer has one', async () => {
    const transport = await seed([p1()]);
    expect(view(transport, GROUP)).toBeDefined();
    // Homey now serves the P1 without its batteries, and says so with a device update.
    setRestClient({
      get: async (path) => (path === DEVICES_API_PATH ? { p1: plainP1() } : mockHomeyInstance.api.get(path)),
      put: (path, body) => mockHomeyInstance.api.put(path, body),
    });
    emitDeviceUpdate(plainP1());
    await vi.waitFor(() => expect(view(transport, GROUP)).toBeUndefined());
    expect(transport.isDeviceConfirmedRemoved(GROUP)).toBe(true);
  });

  it('keeps the group battery through a device update that still has it', async () => {
    const transport = await seed([p1()]);
    const get = vi.fn(async (path: string) => (path === DEVICES_API_PATH ? { p1: p1() } : mockHomeyInstance.api.get(path)));
    setRestClient({ get, put: (path, body) => mockHomeyInstance.api.put(path, body) });
    emitDeviceUpdate(p1());
    await Promise.resolve();
    expect(view(transport, GROUP)).toBeDefined();
    expect(get).not.toHaveBeenCalledWith(DEVICES_API_PATH);
  });
});
