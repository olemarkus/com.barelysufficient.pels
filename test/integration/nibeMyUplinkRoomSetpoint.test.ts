import Homey from 'homey';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { getLogger } from '../../lib/logging/logger';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { emitCapability } from '../helpers/liveFeedSocketHarness';
import { mockHomeyInstance } from '../mocks/homey';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';
import { ownWriteTransactionId } from '../helpers/ownCapabilityWrites';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import type { TemperatureObservedProbe } from '../../packages/contracts/src/types';

const temperatureOf = (snapshot: unknown) => (snapshot as TemperatureObservedProbe | undefined)?.temperature;

const logger: Logger = { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('devices') };
const STAMP = '2026-11-11T06:00:00.000Z';

// NIBE myUplink 1.9.2: the room setpoint and reading sit on `.room` sub-capabilities,
// with no plain temperature pair.
const nibe = (overrides: Partial<HomeyDeviceLike> = {}): HomeyDeviceLike => ({
  ...HOMEY_DEVICE_FIELDS,
  id: 'nibe', name: 'Heat pump', class: 'heatpump', driverId: 'homey:app:com.nibe.myuplink:heatpump',
  ownerUri: 'homey:app:com.nibe.myuplink',
  capabilities: ['target_temperature.room', 'measure_temperature.room', 'measure_temperature.outdoor', 'measure_power'],
  capabilitiesObj: {
    'target_temperature.room': { value: 21, setable: true, min: 5, max: 30, units: '°C', lastUpdated: STAMP },
    'measure_temperature.room': { value: 20.4, lastUpdated: STAMP },
    'measure_temperature.outdoor': { value: -3, lastUpdated: STAMP },
    measure_power: { value: 1800, lastUpdated: STAMP },
  },
  settings: {},
  available: true, ready: true,
  ...overrides,
});

const seed = async (device: HomeyDeviceLike) => {
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger);
  await initWithLiveFeed(transport);
  const [snapshot] = await seedTransportDevices(transport, [device]);
  return { transport, snapshot };
};

describe('NIBE myUplink room setpoint', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('reads the room setpoint and room reading as the pump\'s temperature', async () => {
    const { snapshot } = await seed(nibe());
    expect(temperatureOf(snapshot)?.currentTemperature).toBe(20.4);
    expect(snapshot?.targets).toEqual([expect.objectContaining({ id: 'target_temperature', value: 21, min: 5, max: 30 })]);
  });

  it('reads the S-series zone setpoint the same way', async () => {
    const { snapshot } = await seed(nibe({ driverId: 'homey:app:com.nibe.myuplink:s-series' }));
    expect(snapshot?.targets).toEqual([expect.objectContaining({ id: 'target_temperature', value: 21 })]);
  });

  it('leaves a pump without a room reading as Homey reports it', async () => {
    const device = nibe();
    const { snapshot } = await seed(nibe({
      capabilities: device.capabilities.filter((id) => id !== 'measure_temperature.room'),
    }));
    expect(snapshot?.targets ?? []).toEqual([]);
  });

  it('follows live room setpoint and room reading reports', async () => {
    const { transport } = await seed(nibe());
    await emitCapability('nibe', 'target_temperature.room', 19.5);
    await emitCapability('nibe', 'measure_temperature.room', 20.9);
    const snapshot = transport.getSnapshotByDeviceId('nibe');
    expect(snapshot?.targets).toEqual([expect.objectContaining({ id: 'target_temperature', value: 19.5 })]);
    expect(temperatureOf(snapshot)?.currentTemperature).toBe(20.9);
  });

  it('writes the setpoint to the room capability, and recognises Homey\'s echo of it as PELS\'s own', async () => {
    const { transport } = await seed(nibe());
    const put = vi.spyOn(mockHomeyInstance.api, 'put').mockResolvedValue(undefined);
    await transport.requestTemperatureTarget('nibe', 18);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0]).toBe('manager/devices/device/nibe/capability/target_temperature.room');
    const echoTransactionId = ownWriteTransactionId(put as unknown as Mock, 'nibe', 'target_temperature.room');
    await emitCapability('nibe', 'target_temperature.room', 18, echoTransactionId);
    // The pump's own later report is an observation like any thermostat's.
    await emitCapability('nibe', 'target_temperature.room', 18.5);
    expect(transport.getSnapshotByDeviceId('nibe')?.targets)
      .toEqual([expect.objectContaining({ id: 'target_temperature', value: 18.5 })]);
  });

  it('reads and writes a pump that declares its own plain pair beside the room pair as declared', async () => {
    const device = nibe();
    const { transport, snapshot } = await seed(nibe({
      capabilities: [...device.capabilities, 'target_temperature', 'measure_temperature'],
      capabilitiesObj: {
        ...device.capabilitiesObj,
        target_temperature: { value: 22, setable: true, min: 5, max: 30, units: '°C', lastUpdated: STAMP },
        measure_temperature: { value: 21.1, lastUpdated: STAMP },
      },
    }));
    expect(snapshot?.targets).toEqual([expect.objectContaining({ id: 'target_temperature', value: 22 })]);
    const put = vi.spyOn(mockHomeyInstance.api, 'put').mockResolvedValue(undefined);
    await transport.requestTemperatureTarget('nibe', 18);
    expect(put.mock.calls[0]?.[0]).toBe('manager/devices/device/nibe/capability/target_temperature');
    // A room-setpoint report stays the room capability's; the declared setpoint keeps its own value.
    await emitCapability('nibe', 'target_temperature.room', 25);
    expect(transport.getSnapshotByDeviceId('nibe')?.targets)
      .toEqual([expect.objectContaining({ id: 'target_temperature', value: 22 })]);
  });

  it('keeps its own setpoint over a read Homey dated before the write, then takes the pump\'s newer one', async () => {
    const { transport } = await seed(nibe());
    vi.spyOn(mockHomeyInstance.api, 'put').mockResolvedValue(undefined);
    await transport.requestTemperatureTarget('nibe', 18);
    await seedTransportDevices(transport, [nibe()]);
    expect(transport.getSnapshotByDeviceId('nibe')?.targets)
      .toEqual([expect.objectContaining({ id: 'target_temperature', value: 18 })]);
    const later = new Date(Date.now() + 60_000).toISOString();
    await seedTransportDevices(transport, [nibe({ capabilitiesObj: {
      ...nibe().capabilitiesObj,
      'target_temperature.room': { value: 19, setable: true, min: 5, max: 30, units: '°C', lastUpdated: later },
    } })]);
    expect(transport.getSnapshotByDeviceId('nibe')?.targets)
      .toEqual([expect.objectContaining({ id: 'target_temperature', value: 19 })]);
  });
});
