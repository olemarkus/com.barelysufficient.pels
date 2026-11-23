import { describe, expect, it } from 'vitest';
import { chargingInstallationGroups } from '../../lib/device/chargingCurrentAdapter';
import { reportHomeyDevices } from '../../lib/diagnostics/homeyDeviceSupportSection';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';
import type { HomeyDeviceLike } from '../../lib/utils/types';

const zaptec = (id: string, installationId: string): HomeyDeviceLike => ({
  ...HOMEY_DEVICE_FIELDS,
  id, name: `Charger ${id}`, class: 'evcharger',
  driverId: 'homey:app:com.zaptec:go2', ownerUri: 'homey:app:com.zaptec',
  data: { id, installationId },
  capabilities: ['evcharger_charging', 'available_installation_current'],
  capabilitiesObj: { available_installation_current: { value: 16, setable: true } },
  available: true, ready: true,
});

const relay: HomeyDeviceLike = {
  ...HOMEY_DEVICE_FIELDS,
  id: 'relay', name: 'Relay', class: 'socket', driverId: 'homey:app:test.zigbee:relay',
  ownerUri: 'homey:app:test.zigbee', capabilities: ['onoff'], capabilitiesObj: {}, available: true, ready: true,
};

describe('charging installation groups', () => {
  it('numbers each installation and counts the chargers that share it', () => {
    const groups = chargingInstallationGroups([
      zaptec('a', 'installation-1'), relay, zaptec('b', 'installation-2'), zaptec('c', 'installation-1'),
    ]);

    expect(Object.fromEntries(groups)).toEqual({
      a: { group: 1, chargers: 2 },
      b: { group: 2, chargers: 1 },
      c: { group: 1, chargers: 2 },
    });
  });

  it('lists the installation on each charger in the report, without the vendor id', () => {
    const section = reportHomeyDevices([zaptec('a', 'secret-installation'), zaptec('b', 'secret-installation'), relay],
      () => undefined, () => undefined);

    expect(section.values.devices).toEqual([
      expect.objectContaining({ id: 'a', chargingInstallation: { group: 1, chargers: 2 } }),
      expect.objectContaining({ id: 'b', chargingInstallation: { group: 1, chargers: 2 } }),
      expect.not.objectContaining({ chargingInstallation: expect.anything() }),
    ]);
    expect(JSON.stringify(section)).not.toContain('secret-installation');
  });
});
