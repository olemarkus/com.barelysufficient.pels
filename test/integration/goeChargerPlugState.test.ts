import Homey from 'homey';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLogger } from '../../lib/logging/logger';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { emitCapability } from '../helpers/liveFeedSocketHarness';
import { mockHomeyInstance } from '../mocks/homey';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';

const logger: Logger = { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('devices') };
const STAMP = '2026-11-11T06:00:00.000Z';

// go-e Charger 2.11.1: a connected car the charger holds at `station_waiting`;
// the setable `is_allowed` switch decides whether it is paused.
const goe = (): HomeyDeviceLike => ({
  ...HOMEY_DEVICE_FIELDS,
  id: 'goe', name: 'go-e', class: 'evcharger', driverId: 'homey:app:com.go-e.charger:go-eCharger_V3',
  ownerUri: 'homey:app:com.go-e.charger',
  capabilities: ['is_allowed', 'is_charging', 'is_connected', 'status', 'current_limit', 'measure_power'],
  capabilitiesObj: {
    is_allowed: { value: true, setable: true, lastUpdated: STAMP },
    is_charging: { value: false, lastUpdated: STAMP },
    is_connected: { value: true, lastUpdated: STAMP },
    status: { value: 'station_waiting', lastUpdated: STAMP },
    current_limit: { value: 16, lastUpdated: STAMP },
    measure_power: { value: 0, lastUpdated: STAMP },
  },
  settings: {},
  available: true, ready: true,
});

describe('go-e plug state', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('follows a live switch report while the status stays the same, and keeps it over an older full read', async () => {
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger);
    await initWithLiveFeed(transport);
    const [seeded] = await seedTransportDevices(transport, [goe()]);
    expect(seeded?.evChargingState).toBe('plugged_in');

    await emitCapability('goe', 'is_allowed', false);
    expect(transport.getSnapshotByDeviceId('goe')?.evChargingState).toBe('plugged_in_paused');

    await emitCapability('goe', 'is_allowed', true);
    expect(transport.getSnapshotByDeviceId('goe')?.evChargingState).toBe('plugged_in');

    await emitCapability('goe', 'is_allowed', false);
    // A full read Homey dated before the switch report carries the switch's newer value.
    await seedTransportDevices(transport, [{ ...goe(), capabilitiesObj: {
      ...goe().capabilitiesObj,
      is_allowed: { value: false, setable: true, lastUpdated: new Date().toISOString() },
    } }]);
    expect(transport.getSnapshotByDeviceId('goe')?.evChargingState).toBe('plugged_in_paused');
  });
});
