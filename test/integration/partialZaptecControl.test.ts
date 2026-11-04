import type Homey from 'homey';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceTransport } from '../../lib/device/deviceTransport';
import { getLogger } from '../../lib/logging/logger';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { homeyDevice, setable } from '../helpers/homeyDevicePayload';
import { pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';
import { mockHomeyInstance } from '../mocks/homey';

let transport: DeviceTransport;

beforeEach(async () => {
  transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, {
    log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test/partial-zaptec-control'),
  });
  await initWithLiveFeed(transport);
});

afterEach(() => {
  transport.destroy();
  setRestClient({
    get: path => mockHomeyInstance.api.get(path),
    put: (path, body) => mockHomeyInstance.api.put(path, body),
  });
});

describe('Zaptec switch metadata and observations', () => {
  it.each(['absent', 'unreadable', 'missing descriptor', 'read only'] as const)(
    'keeps independent telemetry and uses only the real write surface when the button is %s', async (kind) => {
      const base = homeyDevice({
        id: 'zaptec', name: 'Zaptec', class: 'evcharger', driverId: 'homey:app:com.zaptec:go', available: true,
      }, {
        charging_button: { value: kind === 'unreadable' ? null : true, setable: kind !== 'read only' },
        charge_mode: 'Charging', 'alarm_generic.car_connected': true,
        // This is not the session switch and must never become its fallback.
        onoff: setable(true), measure_power: 7000,
      }, new Date().toISOString());
      const { charging_button: _button, ...siblings } = base.capabilitiesObj;
      const device = kind === 'unreadable' || kind === 'read only' ? base : {
        ...base,
        capabilities: kind === 'absent' ? base.capabilities.filter(id => id !== 'charging_button') : base.capabilities,
        capabilitiesObj: siblings,
      };
      await seedTransportDevices(transport, [device]);
      const writable = kind === 'unreadable';
      expect(transport.getSnapshotByDeviceId(device.id)).toMatchObject({
        id: device.id, available: true, evCharging: true, evChargingState: 'plugged_in_charging',
        measuredPowerKw: 7, binaryCapabilityId: 'evcharger_charging', canSetControl: writable,
      });
      expect(transport.canTurnOnDevice(device.id)).toBe(writable);
      expect(transport.getSnapshotByDeviceId(device.id)?.binaryWriteCapabilityId)
        .toBe(kind === 'absent' ? undefined : 'charging_button');

      const put = vi.fn().mockResolvedValue(undefined);
      setRestClient({ get: path => mockHomeyInstance.api.get(path), put });
      await transport.setCapability(device.id, 'evcharger_charging', false);
      await transport.setCapability(device.id, 'evcharger_charging', true);
      if (writable) {
        expect(put.mock.calls).toEqual([
          [`manager/devices/device/${device.id}/capability/charging_button`, pelsCapabilityWrite(false)],
          [`manager/devices/device/${device.id}/capability/charging_button`, pelsCapabilityWrite(true)],
        ]);
      } else expect(put).not.toHaveBeenCalled();
    },
  );
});
