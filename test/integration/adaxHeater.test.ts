import Homey from 'homey';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { getLogger } from '../../lib/logging/logger';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { emitCapability } from '../helpers/liveFeedSocketHarness';
import { mockHomeyInstance } from '../mocks/homey';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';
import { ownWriteTransactionId } from '../helpers/ownCapabilityWrites';
import { getDeviceAdapter } from '../../lib/device/deviceAdapterRegistry';
import type { DeviceCapabilityMap } from '../../lib/device/managerControl';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';

const logger: Logger = { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('devices') };
const STAMP = '2026-11-10T06:00:00.000Z';

// Adax 2.0.6 holds `measure_power` at the rated power once the heater has
// heated: it never writes 0.
const adax = (overrides: Partial<HomeyDeviceLike> = {}): HomeyDeviceLike => ({
  ...HOMEY_DEVICE_FIELDS,
  id: 'adax', name: 'Panel', class: 'heater', driverId: 'homey:app:no.adax.smart-heater.homey-app:heater-wt',
  ownerUri: 'homey:app:no.adax.smart-heater.homey-app',
  capabilities: ['target_temperature', 'measure_temperature', 'onoff', 'measure_power'],
  capabilitiesObj: {
    target_temperature: { value: 22, setable: true, min: 5, max: 35, units: '°C', lastUpdated: STAMP },
    measure_temperature: { value: 20.5, lastUpdated: STAMP },
    onoff: { value: true, setable: true, lastUpdated: STAMP },
    measure_power: { value: 1200, lastUpdated: '2026-11-01T06:00:00.000Z' },
  },
  settings: { ratedPower: 1200 },
  available: true, ready: true,
  ...overrides,
});

const seed = async (device: HomeyDeviceLike) => {
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger);
  await initWithLiveFeed(transport);
  const [snapshot] = await seedTransportDevices(transport, [device]);
  return { transport, snapshot };
};

describe('Adax Wi-Fi heater draw', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('reads the rated power while the heater is on and below its target', async () => {
    const { snapshot } = await seed(adax());
    expect(snapshot).toMatchObject({ measuredPowerKw: 1.2 });
  });

  it('reads 0 W on a full read once the heater has reached its target, whatever Homey still holds', async () => {
    const { snapshot } = await seed(adax({
      capabilitiesObj: { ...adax().capabilitiesObj, measure_temperature: { value: 22.5, lastUpdated: STAMP } },
    }));
    expect(snapshot).toMatchObject({ measuredPowerKw: 0 });
  });

  it('drops to 0 W at once on a setback and returns to the rating when the target is raised', async () => {
    const { transport } = await seed(adax());
    await emitCapability('adax', 'target_temperature', 14);
    expect(transport.getSnapshotByDeviceId('adax')).toMatchObject({ measuredPowerKw: 0 });
    await emitCapability('adax', 'target_temperature', 22);
    expect(transport.getSnapshotByDeviceId('adax')).toMatchObject({ measuredPowerKw: 1.2 });
    await emitCapability('adax', 'onoff', false);
    expect(transport.getSnapshotByDeviceId('adax')).toMatchObject({ measuredPowerKw: 0 });
  });

  it('reads PELS\'s own setback as 0 W when Homey echoes the write', async () => {
    const { transport } = await seed(adax());
    const put = vi.spyOn(mockHomeyInstance.api, 'put').mockResolvedValue(undefined);
    await transport.setCapability('adax', 'target_temperature', 14);
    await emitCapability('adax', 'target_temperature', 14, ownWriteTransactionId(put as unknown as Mock, 'adax',
      'target_temperature'));
    expect(transport.getSnapshotByDeviceId('adax')).toMatchObject({ measuredPowerKw: 0 });
  });

  it('reads the app\'s repeated rated power as the heater\'s state says', async () => {
    const { transport } = await seed(adax());
    await emitCapability('adax', 'measure_temperature', 22.4);
    await emitCapability('adax', 'measure_power', 1200);
    expect(transport.getSnapshotByDeviceId('adax')).toMatchObject({ measuredPowerKw: 0 });
  });

  it('dates a full read\'s draw by the heater state, not by the app\'s republished rating', () => {
    const device = adax({ capabilitiesObj: {
      ...adax().capabilitiesObj, measure_power: { value: 1200, lastUpdated: '2026-11-10T07:00:00.000Z' },
    } });
    const overlay = getDeviceAdapter(device).overlay(device, device.capabilities, device.capabilitiesObj as DeviceCapabilityMap);
    expect(overlay.capabilityObj.measure_power).toMatchObject({ value: 1200, lastUpdated: STAMP });
  });

  it('uses the app\'s 1000 W default when the heater has no rating set', async () => {
    const { snapshot } = await seed(adax({ settings: {} }));
    expect(snapshot).toMatchObject({ measuredPowerKw: 1 });
  });
});
