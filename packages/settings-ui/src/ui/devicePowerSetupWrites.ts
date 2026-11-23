import type { DevicePowerSetupEntry } from '../../../contracts/src/settingsUi/devices.ts';
import { readDevicePowerSources, type DevicePowerSources }
  from '../../../shared-domain/src/settings/devicePowerSources.ts';
import { readDeviceBinarySwitches, type DeviceBinarySwitches }
  from '../../../shared-domain/src/settings/deviceBinarySwitches.ts';
import { readLastResortDevices, type LastResortDevices }
  from '../../../shared-domain/src/settings/lastResortDevices.ts';
import { DEVICE_BINARY_SWITCHES, DEVICE_POWER_SOURCES, LAST_RESORT_DEVICES }
  from '../../../shared-domain/src/settings/settingsKeys.ts';
import { createSerializedAsyncRunner, writeFreshSetting } from './deviceDetail/settingsWrite.ts';

const writeDeviceSetup = createSerializedAsyncRunner();

const persistPowerSource = (
  entries: readonly DevicePowerSetupEntry[], entry: DevicePowerSetupEntry, source: string | null,
) => {
  const accepted = Object.fromEntries(entries.flatMap((device) => (
    device.configured ? [[device.id, device.sourceId]] : []
  )));
  return writeFreshSetting<DevicePowerSources>({
    key: DEVICE_POWER_SOURCES,
    context: 'device setup',
    logMessage: 'Failed to save device power source',
    toastMessage: 'Could not save the power source.',
    fallbackValue: accepted,
    readFresh: readDevicePowerSources,
    mutate: (current) => {
      const previous = Object.entries(current).filter(([id, assignment]) => id !== source || assignment !== null);
      const next = readDevicePowerSources({ ...Object.fromEntries(previous), [entry.id]: source });
      if (!next) throw new Error('This device or socket is already used in another power source assignment.');
      return next;
    },
  });
};

const persistBinarySwitch = (
  entries: readonly DevicePowerSetupEntry[], entry: DevicePowerSetupEntry, switchId: string | null,
) => (
  writeFreshSetting<DeviceBinarySwitches>({
    key: DEVICE_BINARY_SWITCHES,
    context: 'device setup',
    logMessage: 'Failed to save device on/off control',
    toastMessage: 'Could not save on/off control.',
    fallbackValue: Object.fromEntries(entries.flatMap((device) => (
      device.binarySwitchId ? [[device.id, device.binarySwitchId]] : []
    ))),
    readFresh: readDeviceBinarySwitches,
    mutate: (current) => {
      const unchanged = Object.entries(current).filter(([id]) => id !== entry.id);
      return Object.fromEntries(switchId ? [...unchanged, [entry.id, switchId]] : unchanged);
    },
  })
);

const persistLastResort = (
  entries: readonly DevicePowerSetupEntry[], entry: DevicePowerSetupEntry, maximum: number | undefined,
) => (
  writeFreshSetting<LastResortDevices>({
    key: LAST_RESORT_DEVICES,
    context: 'device setup',
    logMessage: 'Failed to save last-resort power control',
    toastMessage: 'Could not save last-resort control.',
    fallbackValue: Object.fromEntries(entries.flatMap((device) => (
      device.lastResortMaximumW === undefined ? [] : [[device.id, device.lastResortMaximumW]]
    ))),
    readFresh: readLastResortDevices,
    mutate: (current) => {
      const unchanged = Object.entries(current).filter(([id]) => id !== entry.id);
      return Object.fromEntries(maximum === undefined ? unchanged : [...unchanged, [entry.id, maximum]]);
    },
  })
);

export type SetupDraft = { source: string; switchId: string; lastResort: boolean; maximum: string };

async function persistPhysicalControls(
  entries: readonly DevicePowerSetupEntry[], entry: DevicePowerSetupEntry, draft: SetupDraft,
): Promise<boolean> {
  const { source, switchId } = draft;
  if ((entry.binarySwitchId ?? '') !== switchId && !await persistBinarySwitch(entries, entry, switchId || null)) {
    return false;
  }
  const changedSource = !entry.configured || (entry.sourceId ?? '') !== source;
  return !changedSource || Boolean(await persistPowerSource(entries, entry, source || null));
}

export const persistDeviceSetup = (
  entries: readonly DevicePowerSetupEntry[], entry: DevicePowerSetupEntry, draft: SetupDraft,
) => writeDeviceSetup(async () => {
  const { source, lastResort, maximum } = draft;
  if (!await persistPhysicalControls(entries, entry, draft)) return false;
  const maximumW = !source && lastResort ? Number(maximum) : undefined;
  return entry.lastResortMaximumW === maximumW || Boolean(await persistLastResort(entries, entry, maximumW));
});
