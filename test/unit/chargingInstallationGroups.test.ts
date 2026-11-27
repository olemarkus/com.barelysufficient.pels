import { describe, expect, it } from 'vitest';
import { chargingInstallationGroups } from '../../lib/device/chargingCurrentAdapter';
import { readHomeyDeviceInventory, reportHomeyDevices, SUPPORT_REPORT_MAX_HOMEY_DEVICES } from '../../lib/diagnostics/homeyDeviceSupportSection';
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
    const groups = chargingInstallationGroups(new Map([
      ['a', 'installation-1'], ['b', 'installation-2'], ['c', 'installation-1'],
    ]));

    expect(Object.fromEntries(groups)).toEqual({
      a: { group: 1, chargers: 2 },
      b: { group: 2, chargers: 1 },
      c: { group: 1, chargers: 2 },
    });
  });

  it('counts chargers beyond the roster limit without exposing the installation id', async () => {
    async function* devices() {
      yield zaptec('a', 'secret-installation');
      yield relay;
      for (let index = 2; index < SUPPORT_REPORT_MAX_HOMEY_DEVICES; index += 1) {
        yield { ...relay, id: `relay-${index}` };
      }
      yield zaptec('b', 'secret-installation');
    }
    const inventory = await readHomeyDeviceInventory((collect) => collect(devices()), { kind: 'app', homeId: 'main' });
    if (inventory.state === 'unavailable') throw new Error('fixture inventory unavailable');
    const section = reportHomeyDevices(inventory, () => undefined, () => undefined);

    expect(section.values).toMatchObject({ leftOut: 1 });
    expect(section.values.devices).toHaveLength(SUPPORT_REPORT_MAX_HOMEY_DEVICES);
    expect(section.values.devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'a', chargingInstallation: { group: 1, chargers: 2 } }),
      expect.objectContaining({ id: 'relay' }),
    ]));
    expect(section.values.devices).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'relay', chargingInstallation: expect.anything() }),
    ]));
    expect(JSON.stringify(section)).not.toContain('secret-installation');
  });
});
