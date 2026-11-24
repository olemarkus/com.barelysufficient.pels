import { ChargingCurrentControl } from '../../lib/device/chargingCurrentControl';
import { HomeyActionAccess } from '../../lib/device/transport/homeyActionAccess';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { getLogger } from '../../lib/logging/logger';
import { normalizeUserFlowFacts } from '../../lib/flowApi/userFlows';
import { createChargingFlowWritesStore } from '../../lib/flowApi/acceptedFlowConflictStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import type { ChargingCurrentSetup } from '../../packages/contracts/src/chargingControl';
import { deviceControlSettingsFixture } from '../helpers/deviceControlSettingsFixture';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';
import { FlowActionCardInventory } from '../../lib/device/flowActionCardInventory';
import { newWriteAnswerTimes } from '../helpers/confirmationWindows';

const selected: ChargingCurrentSetup = { method: 'built_in', confirmation: 'single_charger' };
// The Homey ids sort the other way round from the Zaptec charger ids, which pick the main.
const charger = (id: string, zaptecId: string, installationId = 'installation'): HomeyDeviceLike => ({
  ...HOMEY_DEVICE_FIELDS, id, name: `Go ${id}`, class: 'evcharger',
  driverId: 'homey:app:com.zaptec:go2', data: { id: zaptecId, installationId },
  capabilities: ['available_installation_current', 'evcharger_charging'],
  capabilitiesObj: {
    available_installation_current: { value: 16, setable: true },
    evcharger_charging: { value: false, setable: true },
  },
});
const garage = () => charger('homey-a', 'zaptec-2');
const driveway = () => charger('homey-b', 'zaptec-1');

function fixture(
  inventory: HomeyDeviceLike[], managedDevices: Record<string, boolean>, controllableDevices = managedDevices,
  homes = (_id: string): string | undefined => 'main',
) {
  const values = new Map<string, unknown>();
  const settings = { get: (key: string) => values.get(key), getKeys: () => [...values.keys()],
    set: (key: string, value: unknown) => { values.set(key, value); }, unset: (key: string) => { values.delete(key); } };
  setRestClient({ get: vi.fn(async (): Promise<unknown> => ({})), put: vi.fn() });
  const logger = { structuredLog: getLogger('test') };
  const access = new HomeyActionAccess({ settings, api: { getLocalUrl: async () => 'http://homey.local' },
    cloud: { getHomeyId: async () => 'test' } }, logger, newWriteAnswerTimes());
  const control = new ChargingCurrentControl(settings, access, new FlowActionCardInventory(logger), logger, () => inventory,
    () => ({ connected: true, revision: 0 }), createChargingFlowWritesStore(openUserdataDatabase(IN_MEMORY_DATABASE)),
    deviceControlSettingsFixture({
      managedDevices, controllableDevices,
      deviceTargetPowerConfigs: { 'homey-b': { enabled: true, preset: 'ev_charger_3_phase', max: 22080 } },
    }), homes);
  control.retainDevices(inventory, control.trustEpoch(), 0);
  control.acceptFlowFacts(normalizeUserFlowFacts({}, {}));
  return { control, values };
}

test('a fully managed shared installation is one load whose main has the lowest Zaptec charger id', async () => {
  const inventory = [garage(), driveway(), charger('homey-c', 'zaptec-0', 'elsewhere')];
  const { control } = fixture(inventory, { 'homey-a': true, 'homey-b': true });
  await control.save('homey-b', { ...selected, confirmation: 'none' });
  expect(control.chargingInstallation('homey-b')).toEqual({
    id: 'installation', mainId: 'homey-b', memberIds: ['homey-b', 'homey-a'],
  });
  expect(control.chargingInstallation('homey-a')).toMatchObject({ mainId: 'homey-b' });
  expect(control.chargingInstallation('homey-c')).toBeUndefined();
  const listed = await control.list();
  expect(listed.find((entry) => entry.deviceId === 'homey-b')).toMatchObject({
    sharedInstallation: false, chargingInstallation: { role: 'main', mainName: 'Go homey-b', automaticWatts: false },
  });
  expect(listed.find((entry) => entry.deviceId === 'homey-a')).toMatchObject({
    sharedInstallation: true, chargingInstallation: { role: 'secondary', mainName: 'Go homey-b', automaticWatts: false },
  });
});

test('a shared installation with a charger PELS does not manage stays charger by charger', async () => {
  const { control, values } = fixture([garage(), driveway()], { 'homey-b': true });
  values.set('charging_current_control', { 'homey-b': selected });
  expect(control.routesBuiltIn('homey-b')).toBe(false);
  expect(control.chargingInstallation('homey-b')).toBeUndefined();
  expect(control.chargingInstallation('homey-a')).toBeUndefined();
  await expect(control.save('homey-b', selected)).rejects.toThrow('single-charger');
  expect(() => control.assertControlAllowed(garage(), 'target_power')).not.toThrow();
});

test('only the main sets the installation current; a secondary never gets an amp or watt write', async () => {
  const { control, values } = fixture([garage(), driveway()], { 'homey-a': true, 'homey-b': true });
  await control.save('homey-b', { ...selected, confirmation: 'none' });
  await expect(control.save('homey-a', selected)).rejects.toThrow('another charger');

  const write = vi.fn();
  await control.writeCurrent(driveway(), 10, write);
  expect(write).toHaveBeenCalledExactlyOnceWith('available_installation_current', 10);

  // Even a built-in choice saved for the secondary (before it shared the installation) routes nothing.
  values.set('charging_current_control', { 'homey-a': selected, 'homey-b': selected });
  expect(control.routesBuiltIn('homey-a')).toBe(false);
  expect(control.withdrawsCurrentLadder(garage())).toBe(true);
  write.mockClear();
  await expect(control.writeCurrent(garage(), 10, write)).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();

  for (const capabilityId of ['available_installation_current', 'target_power', 'target_power_mode']) {
    expect(() => control.assertControlAllowed(garage(), capabilityId)).toThrow('another charger');
    expect(() => control.assertControlAllowed(driveway(), capabilityId)).not.toThrow();
  }
  expect(() => control.assertControlAllowed(garage(), 'evcharger_charging')).not.toThrow();
});

test.each([[16, 11040], [4, 0]])('reads %i A on the built-in current ladder as %i W', async (amps, watts) => {
  const main = driveway();
  const { control } = fixture([garage(), {
    ...main,
    capabilitiesObj: {
      ...main.capabilitiesObj,
      available_installation_current: { ...main.capabilitiesObj.available_installation_current, value: amps },
    },
  }], { 'homey-a': true, 'homey-b': true });
  await control.save(main.id, { ...selected, confirmation: 'none' });
  expect(control.installationLevelW(main.id)).toBe(watts);
});

test('every member must have Power-limit control on and an integration charger id', () => {
  const managed = { 'homey-b': true, 'homey-a': true };
  const noPowerLimit = fixture([garage(), driveway()], managed, { 'homey-b': true }).control;
  expect(noPowerLimit.chargingInstallation('homey-b')).toBeUndefined();

  const unknownCharger = charger('homey-a', '');
  const missingId = fixture([unknownCharger, driveway()], managed).control;
  expect(missingId.chargingInstallation('homey-b')).toBeUndefined();
  expect(missingId.chargingInstallation('homey-a')).toBeUndefined();
});

test('known physical sharing across meter areas blocks current even if a charger id is missing', () => {
  const inventory = [charger('homey-a', ''), driveway()];
  const managed = { 'homey-a': true, 'homey-b': true };
  const { control } = fixture(inventory, managed, managed, (id) => id === 'homey-a' ? 'other' : 'main');

  for (const device of inventory) {
    expect(control.chargingInstallation(device.id)).toBeUndefined();
    expect(() => control.assertControlAllowed(device, 'target_power')).toThrow('PELS cannot set the shared current');
    expect(() => control.assertControlAllowed(device, 'evcharger_charging')).not.toThrow();
  }
});

test('a partial read cannot elect a new main', async () => {
  const inventory = [garage(), driveway()];
  const { control } = fixture(inventory, { 'homey-b': true, 'homey-a': true });
  await control.save('homey-b', { ...selected, confirmation: 'none' });
  control.retainDevices([garage()], control.trustEpoch(), 1);
  expect(control.chargingInstallation('homey-a')).toMatchObject({ mainId: 'homey-b' });
});

test('an installation is active only while all chargers have one resolved meter home', async () => {
  const managed = { 'homey-b': true, 'homey-a': true };
  const homes = new Map([['homey-a', 'main'], ['homey-b', 'main']]);
  const { control } = fixture([garage(), driveway()], managed, managed, (id) => homes.get(id));
  expect(control.chargingInstallation('homey-b')).toBeUndefined();
  await control.save('homey-b', { ...selected, confirmation: 'none' });
  expect(control.chargingInstallation('homey-b')).toMatchObject({ mainId: 'homey-b' });

  for (const home of ['other', undefined]) {
    if (home === undefined) homes.delete('homey-a');
    else homes.set('homey-a', home);
    expect(control.chargingInstallation('homey-b')).toBeUndefined();
    expect(control.chargingInstallation('homey-a')).toBeUndefined();
    for (const member of [garage(), driveway()]) {
      expect(() => control.assertInstallationStepAllowed(member.id)).toThrow('cannot set the shared current');
      expect(() => control.assertControlAllowed(member, 'target_power')).toThrow('cannot set the shared current');
      expect(() => control.assertControlAllowed(member, 'evcharger_charging')).not.toThrow();
    }
  }
});
