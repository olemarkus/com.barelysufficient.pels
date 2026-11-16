import Homey from 'homey';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLogger } from '../../lib/logging/logger';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { mockHomeyInstance } from '../mocks/homey';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';
import * as homeyApi from '../../lib/device/transport/managerHomeyApi';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';

const logger: Logger = { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('devices') };
const STAMP = '2026-11-16T06:00:00.000Z';

const meter = (
  id: string,
  driverId: string,
  values: Record<string, number>,
): HomeyDeviceLike => ({
  ...HOMEY_DEVICE_FIELDS,
  id, name: id, class: 'sensor', driverId, ownerUri: driverId.split(':').slice(0, 3).join(':'),
  capabilities: Object.keys(values),
  capabilitiesObj: Object.fromEntries(Object.entries(values).map(([capabilityId, value]) => (
    [capabilityId, { id: capabilityId, value, lastUpdated: STAMP }]
  ))),
  settings: {},
  available: true, ready: true,
});

// LiXee ZLinky_TIC on a three-phase Linky: per-phase apparent power beside the total.
const zlinky = (values: Record<string, number> = {
  measure_power: 4_600,
  phase_1_apparent_power_capability: 2_000,
  phase_2_apparent_power_capability: 1_500,
  phase_3_apparent_power_capability: 1_100,
}) => meter('zlinky', 'homey:app:com.lixee:zlinky_tic', values);

// Nous Smart Energy Monitor D4Z: phases suffixed _x, _y and _z.
const d4z = () => meter('d4z', 'homey:app:net.franceweb.nous:smart-energy-monitor-d4z', {
  measure_power: 3_000,
  measure_power_x: 1_200, measure_power_y: 1_000, measure_power_z: 800,
  measure_current_x: 5.2, measure_current_y: 4.4, measure_current_z: 3.5,
  measure_voltage_x: 231, measure_voltage_y: 229, measure_voltage_z: 230,
});

const readPhases = async (device: HomeyDeviceLike) => {
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger);
  await initWithLiveFeed(transport);
  await seedTransportDevices(transport, [device]);
  // The meter is read on its own, as the poll does, from Homey's device endpoint.
  vi.spyOn(homeyApi, 'getRawDevice').mockResolvedValue(device);
  return transport.readMeterPhases(device.id, null);
};

describe('meter phases under an app\'s own capability names', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('reads a three-phase ZLinky\'s per-phase apparent power as L1 to L3', async () => {
    await expect(readPhases(zlinky())).resolves.toMatchObject({
      state: 'read',
      powerW: [2_000, 1_500, 1_100],
      capabilityIds: expect.arrayContaining(['measure_power.l1', 'measure_power.l2', 'measure_power.l3']),
    });
  });

  it('reads no phases from a single-phase ZLinky', async () => {
    await expect(readPhases(zlinky({ measure_power: 2_300 }))).resolves.toMatchObject({ state: 'none' });
  });

  it('reads no phases when the ZLinky reports only some of them', async () => {
    await expect(readPhases(zlinky({
      measure_power: 3_500, phase_2_apparent_power_capability: 2_000, phase_3_apparent_power_capability: 1_500,
    }))).resolves.toMatchObject({ state: 'none' });
  });

  it('reads the D4Z\'s power, current and voltage per phase', async () => {
    await expect(readPhases(d4z())).resolves.toMatchObject({
      state: 'read',
      powerW: [1_200, 1_000, 800],
      currentA: [5.2, 4.4, 3.5],
      voltageV: [231, 229, 230],
    });
  });

  it('leaves another meter\'s look-alike names unread', async () => {
    const other = meter('other', 'homey:app:com.example:meter', {
      measure_power: 3_000, measure_power_x: 1_200, measure_power_y: 1_000, measure_power_z: 800,
    });
    await expect(readPhases(other)).resolves.toMatchObject({ state: 'none' });
  });
});
