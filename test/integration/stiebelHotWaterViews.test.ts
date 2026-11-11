import Homey from 'homey';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { getLogger } from '../../lib/logging/logger';
import { DEVICES_API_PATH, setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { emitCapability } from '../helpers/liveFeedSocketHarness';
import { mockHomeyInstance } from '../mocks/homey';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';
import { ownWriteTransactionId } from '../helpers/ownCapabilityWrites';
import type { DeviceTransport } from '../../lib/device/deviceTransport';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import type { TemperatureObservedProbe } from '../../packages/contracts/src/types';

const temperatureOf = (snapshot: unknown) => (snapshot as TemperatureObservedProbe | undefined)?.temperature;

const logger: Logger = { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('devices') };
const STAMP = '2026-11-11T06:00:00.000Z';
const HOT_WATER = 'stiebel~hot_water';

// Stiebel Eltron Heat Pumps 1.5.3, `heatpump` driver: room heating and the
// hot-water tank on one device, with the power split into its two parts.
const stiebel = (overrides: Partial<HomeyDeviceLike> = {}): HomeyDeviceLike => ({
  ...HOMEY_DEVICE_FIELDS,
  id: 'stiebel', name: 'Heat pump', class: 'heatpump', driverId: 'homey:app:Stiebel.heatpump:heatpump',
  ownerUri: 'homey:app:Stiebel.heatpump',
  capabilities: [
    'target_temperature', 'measure_temperature',
    'target_temperature.warmwater_temp', 'measure_temperature.warmwater_temp',
    'measure_power', 'measure_power.heating', 'measure_power.warmwater',
  ],
  capabilitiesObj: {
    target_temperature: { value: 21, setable: true, min: 5, max: 30, units: '°C', lastUpdated: STAMP },
    measure_temperature: { value: 20.5, lastUpdated: STAMP },
    'target_temperature.warmwater_temp': {
      value: 48, setable: true, min: 10, max: 60, units: '°C', lastUpdated: STAMP,
    },
    'measure_temperature.warmwater_temp': { value: 46.2, lastUpdated: STAMP },
    measure_power: { value: 2400, lastUpdated: STAMP },
    'measure_power.heating': { value: 900, lastUpdated: STAMP },
    'measure_power.warmwater': { value: 1500, lastUpdated: STAMP },
  },
  settings: {},
  available: true, ready: true,
  ...overrides,
});

const neighbour = (): HomeyDeviceLike => ({
  ...HOMEY_DEVICE_FIELDS,
  id: 'heater', name: 'Panel heater', class: 'heater', driverId: 'homey:app:com.example:heater',
  ownerUri: 'homey:app:com.example',
  capabilities: ['onoff', 'measure_power'],
  capabilitiesObj: {
    onoff: { value: true, setable: true, lastUpdated: STAMP },
    measure_power: { value: 800, lastUpdated: STAMP },
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

describe('Stiebel Eltron hot water as its own device', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('reads one heat pump as room heating and hot water, each with its own setpoint, temperature and power', async () => {
    const transport = await seed([stiebel()]);
    const room = view(transport, 'stiebel');
    const hotWater = view(transport, HOT_WATER);
    expect(room?.targets).toEqual([expect.objectContaining({ id: 'target_temperature', value: 21, min: 5, max: 30 })]);
    expect(temperatureOf(room)?.currentTemperature).toBe(20.5);
    expect(room?.measuredPowerKw).toBeCloseTo(0.9);
    expect(hotWater?.name).toBe('Heat pump hot water');
    expect(hotWater?.targets)
      .toEqual([expect.objectContaining({ id: 'target_temperature', value: 48, min: 10, max: 60 })]);
    expect(temperatureOf(hotWater)?.currentTemperature).toBe(46.2);
    expect(hotWater?.measuredPowerKw).toBeCloseTo(1.5);
  });

  it('reads the LWZ hot-water pair the same way', async () => {
    const device = stiebel();
    const { capabilitiesObj } = device;
    const transport = await seed([stiebel({
      driverId: 'homey:app:Stiebel.heatpump:heatpump-lwz',
      capabilities: device.capabilities.map((id) => id.replace('.warmwater_temp', '.warmwater')),
      capabilitiesObj: {
        ...capabilitiesObj,
        'target_temperature.warmwater': {
          value: 50, setable: true, min: 10, max: 55, units: '°C', lastUpdated: STAMP,
        },
        'measure_temperature.warmwater': { value: 49, lastUpdated: STAMP },
      },
    })]);
    expect(view(transport, HOT_WATER)?.targets)
      .toEqual([expect.objectContaining({ id: 'target_temperature', value: 50, max: 55 })]);
    expect(temperatureOf(view(transport, HOT_WATER))?.currentTemperature).toBe(49);
  });

  it('gives a view no power when the app has no value for its part, and never the total', async () => {
    const { capabilitiesObj } = stiebel();
    const transport = await seed([stiebel({ capabilitiesObj: {
      ...capabilitiesObj,
      'measure_power.heating': { value: null, lastUpdated: STAMP },
      'measure_power.warmwater': { value: null, lastUpdated: STAMP },
    } })]);
    expect(view(transport, 'stiebel')?.measuredPowerKw).toBeUndefined();
    expect(view(transport, HOT_WATER)?.measuredPowerKw).toBeUndefined();
    expect(view(transport, HOT_WATER)?.targets).toEqual([expect.objectContaining({ value: 48 })]);
  });

  it('leaves a heat pump without the hot-water pair as one device', async () => {
    const device = stiebel();
    const transport = await seed([stiebel({
      capabilities: device.capabilities.filter((id) => id !== 'measure_temperature.warmwater_temp'),
    })]);
    expect(transport.getSnapshot().map(({ id }) => id)).toEqual(['stiebel']);
  });

  it('routes live reports to the view they belong to', async () => {
    const transport = await seed([stiebel()]);
    await emitCapability('stiebel', 'measure_temperature.warmwater_temp', 44.1);
    await emitCapability('stiebel', 'target_temperature.warmwater_temp', 52);
    await emitCapability('stiebel', 'measure_power.heating', 1200);
    // The total is the room's own name for it; it powers neither view.
    await emitCapability('stiebel', 'measure_power', 5000);
    expect(temperatureOf(view(transport, HOT_WATER))?.currentTemperature).toBe(44.1);
    expect(view(transport, HOT_WATER)?.targets).toEqual([expect.objectContaining({ value: 52 })]);
    expect(temperatureOf(view(transport, 'stiebel'))?.currentTemperature).toBe(20.5);
    expect(view(transport, 'stiebel')?.targets).toEqual([expect.objectContaining({ value: 21 })]);
    expect(view(transport, 'stiebel')?.measuredPowerKw).toBeCloseTo(1.2);
    expect(view(transport, HOT_WATER)?.measuredPowerKw).toBeCloseTo(1.5);
  });

  it('writes the hot-water setpoint to the heat pump, and recognises Homey\'s echo of it as PELS\'s own', async () => {
    const transport = await seed([stiebel()]);
    const put = vi.spyOn(mockHomeyInstance.api, 'put').mockResolvedValue(undefined);
    await transport.requestTemperatureTarget(HOT_WATER, 55);
    expect(put.mock.calls.map(([path]) => path))
      .toEqual(['manager/devices/device/stiebel/capability/target_temperature.warmwater_temp']);
    const echo = ownWriteTransactionId(put as unknown as Mock, 'stiebel', 'target_temperature.warmwater_temp');
    await emitCapability('stiebel', 'target_temperature.warmwater_temp', 55, echo);
    await emitCapability('stiebel', 'target_temperature.warmwater_temp', 54);
    expect(view(transport, HOT_WATER)?.targets).toEqual([expect.objectContaining({ value: 54 })]);
    await transport.requestTemperatureTarget('stiebel', 19);
    expect(put.mock.calls.at(-1)?.[0]).toBe('manager/devices/device/stiebel/capability/target_temperature');
  });

  it('fetches the heat pump once on a targeted refresh, and keeps both views', async () => {
    const transport = await seed([stiebel(), neighbour()]);
    const paths: string[] = [];
    const later = new Date(Date.now() + 60_000).toISOString();
    const { capabilitiesObj } = stiebel();
    const refreshed = stiebel({ capabilitiesObj: {
      ...capabilitiesObj, 'measure_temperature.warmwater_temp': { value: 47.5, lastUpdated: later },
    } });
    setRestClient({
      get: async (path) => {
        paths.push(path);
        if (path === `${DEVICES_API_PATH}/stiebel`) return refreshed;
        if (path === `${DEVICES_API_PATH}/heater`) return neighbour();
        return mockHomeyInstance.api.get(path);
      },
      put: (path, body) => mockHomeyInstance.api.put(path, body),
    });
    await transport.refreshSnapshot({ includeLivePower: false, targetedRefresh: true, meterDeviceIds: [] });
    expect(paths.filter((path) => path.startsWith(`${DEVICES_API_PATH}/`)).sort())
      .toEqual([`${DEVICES_API_PATH}/heater`, `${DEVICES_API_PATH}/stiebel`]);
    expect(temperatureOf(view(transport, HOT_WATER))?.currentTemperature).toBe(47.5);
    expect(view(transport, 'stiebel')).toBeDefined();
  });

  it('drops both views when the heat pump leaves Homey, and keeps both in the inventory while it is there', async () => {
    const transport = await seed([stiebel(), neighbour()]);
    expect(transport.isDeviceConfirmedRemoved(HOT_WATER)).toBe(false);
    await seedTransportDevices(transport, [neighbour()]);
    expect(view(transport, 'stiebel')).toBeUndefined();
    expect(view(transport, HOT_WATER)).toBeUndefined();
    expect(transport.isDeviceConfirmedRemoved(HOT_WATER)).toBe(true);
  });
});
