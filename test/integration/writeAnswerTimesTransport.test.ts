import Homey from 'homey';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLogger } from '../../lib/logging/logger';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { mockHomeyInstance } from '../mocks/homey';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';
import { MIN_WINDOW_MS, WARM_UP_MS } from '../../lib/device/transport/writeAnswerTimes';
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../../lib/ports/controlCommandConfirmation';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';

const logger: Logger = { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('devices') };
const STAMP = '2026-11-22T06:00:00.000Z';

const relay = (): HomeyDeviceLike => ({
  ...HOMEY_DEVICE_FIELDS,
  id: 'relay', name: 'Water heater relay', class: 'socket', driverId: 'homey:app:test.zigbee:relay',
  ownerUri: 'homey:app:test.zigbee',
  capabilities: ['onoff', 'measure_power'],
  capabilitiesObj: {
    onoff: { value: true, setable: true, lastUpdated: STAMP },
    measure_power: { value: 2000, lastUpdated: STAMP },
  },
  available: true, ready: true,
});

const seed = async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(STAMP));
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger);
  await initWithLiveFeed(transport);
  await seedTransportDevices(transport, [relay()]);
  vi.setSystemTime(Date.parse(STAMP) + WARM_UP_MS);
  return transport;
};

describe('device write answer times through the transport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('learns a fast relay from Homey answering its on/off writes, by direction, and reports it by name', async () => {
    const transport = await seed();
    vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 300);
      return undefined;
    });
    for (const value of [false, true, false, true, false]) {
      await transport.setCapability('relay', 'onoff', value);
      vi.setSystemTime(Date.now() + 60_000);
    }

    const { writeAnswerTimes } = transport;
    expect(writeAnswerTimes.windowMs('relay', false, Date.now())).toBe(MIN_WINDOW_MS);
    expect(writeAnswerTimes.windowMs('relay', true, Date.now())).toBe(CONTROL_COMMAND_CONFIRMATION_MS);
    expect(writeAnswerTimes.describe(Date.now(), (id) => transport.getSnapshotByDeviceId(id)?.name ?? null))
      .toEqual(expect.arrayContaining([expect.objectContaining({
        deviceId: 'relay', deviceName: 'Water heater relay', kind: 'switch_off', samples: 3, medianAnswerMs: 300,
      })]));
  });

  it('learns nothing from writes Homey refused', async () => {
    const transport = await seed();
    vi.spyOn(mockHomeyInstance.api, 'put').mockRejectedValue(new Error('Device unavailable'));
    for (const value of [false, true, false]) {
      await expect(transport.setCapability('relay', 'onoff', value)).rejects.toThrow();
    }

    expect(transport.writeAnswerTimes.windowMs('relay', false, Date.now())).toBe(CONTROL_COMMAND_CONFIRMATION_MS);
    expect(transport.writeAnswerTimes.describe(Date.now(), (id) => transport.getSnapshotByDeviceId(id)?.name ?? null)).toEqual([]);
  });
});
