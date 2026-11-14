import Homey from 'homey';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLogger } from '../../lib/logging/logger';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { resolveTeslaChargingState } from '../../lib/device/tesla/charging';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { emitCapability } from '../helpers/liveFeedSocketHarness';
import { capabilityReadings, HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';
import { buildZaptecTargetPowerDevice } from '../helpers/zaptecDeviceFixture';
import { mockHomeyInstance } from '../mocks/homey';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';

const logger: Logger = { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('devices') };
const STAMP = '2026-11-14T06:00:00.000Z';

/** A Zaptec on the app's own EV capabilities, in the plug state the app publishes. */
const zaptec = (plugState: string): HomeyDeviceLike => {
  const device = buildZaptecTargetPowerDevice();
  return {
    ...device,
    capabilitiesObj: {
      ...device.capabilitiesObj,
      ...capabilityReadings({
        evcharger_charging_state: { ...device.capabilitiesObj?.evcharger_charging_state, value: plugState },
      }),
    },
  };
};

const goe = (status: string, allowed: boolean): HomeyDeviceLike => ({
  ...HOMEY_DEVICE_FIELDS,
  id: 'goe', name: 'go-e', class: 'evcharger', driverId: 'homey:app:com.go-e.charger:go-eCharger_V3',
  ownerUri: 'homey:app:com.go-e.charger',
  capabilities: ['is_allowed', 'is_charging', 'is_connected', 'status', 'current_limit', 'measure_power'],
  capabilitiesObj: {
    is_allowed: { value: allowed, setable: true, lastUpdated: STAMP },
    is_charging: { value: false, lastUpdated: STAMP },
    is_connected: { value: true, lastUpdated: STAMP },
    status: { value: status, lastUpdated: STAMP },
    current_limit: { value: 16, lastUpdated: STAMP },
    measure_power: { value: 0, lastUpdated: STAMP },
  },
  settings: {},
  available: true, ready: true,
});

afterEach(() => {
  vi.restoreAllMocks();
  setRestClient({
    get: (path) => mockHomeyInstance.api.get(path),
    post: (path, body) => mockHomeyInstance.api.post(path, body),
    put: (path, body) => mockHomeyInstance.api.put(path, body),
  });
});

describe('charger session states', () => {
  it('reads a Zaptec that has not started its session as waiting for the charger, and sends it no start', async () => {
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger);
    await initWithLiveFeed(transport);
    const [seeded] = await seedTransportDevices(transport, [zaptec('plugged_in')]);
    expect(seeded?.evChargingState).toBe('plugged_in_waiting_for_charger');

    // Zaptec resumes only a paused session, so a start here is refused: PELS
    // sends none and leaves the session to begin by itself.
    const put = vi.fn().mockResolvedValue(undefined);
    setRestClient({ get: vi.fn(), put });
    expect(transport.canTurnOnDevice(seeded!.id)).toBe(false);
    await expect(transport.setCapability(seeded!.id, 'evcharger_charging', true))
      .rejects.toThrow('Device is not ready to start.');
    expect(put).not.toHaveBeenCalled();
  });

  it('keeps a paused Zaptec session resumable, and follows the app\'s live plug state', async () => {
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger);
    await initWithLiveFeed(transport);
    const [seeded] = await seedTransportDevices(transport, [zaptec('plugged_in_paused')]);
    expect(seeded?.evChargingState).toBe('plugged_in_paused');
    expect(transport.canTurnOnDevice(seeded!.id)).toBe(true);

    await emitCapability(seeded!.id, 'evcharger_charging_state', 'plugged_in');
    expect(transport.getSnapshotByDeviceId(seeded!.id)?.evChargingState).toBe('plugged_in_waiting_for_charger');
    expect(transport.canTurnOnDevice(seeded!.id)).toBe(false);

    await emitCapability(seeded!.id, 'evcharger_charging_state', 'plugged_in_charging');
    expect(transport.getSnapshotByDeviceId(seeded!.id)?.evChargingState).toBe('plugged_in_charging');
  });

  it.each([
    ['car_finished', true, 'plugged_in_finished'],
    ['station_waiting', true, 'plugged_in'],
    // The switch holds the car off: a resume lands, whatever the car last said.
    ['car_finished', false, 'plugged_in_paused'],
  ])('reads a go-e at %s with the switch %s as %s', async (status, allowed, state) => {
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger);
    const [seeded] = await seedTransportDevices(transport, [goe(status, allowed)]);
    expect(seeded?.evChargingState).toBe(state);
  });

  it('reads a Tesla that completed its charge as finished', () => {
    expect(resolveTeslaChargingState('Complete')).toBe('plugged_in_finished');
    expect(resolveTeslaChargingState('Stopped')).toBe('plugged_in_paused');
  });
});
