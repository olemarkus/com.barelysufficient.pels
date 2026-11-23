import type { DevicePowerSetupEntry } from '../../../contracts/src/settingsUi/devices.ts';
import { readDevicePowerSources, type DevicePowerSources }
  from '../../../shared-domain/src/settings/devicePowerSources.ts';
import { readDeviceBinarySwitches, type DeviceBinarySwitches }
  from '../../../shared-domain/src/settings/deviceBinarySwitches.ts';
import { readLastResortDevices, type LastResortDevices }
  from '../../../shared-domain/src/settings/lastResortDevices.ts';
import { readExternalThermostats } from '../../../shared-domain/src/settings/externalThermostats.ts';
import { DEVICE_BINARY_SWITCHES, DEVICE_EXTERNAL_THERMOSTATS, DEVICE_POWER_SOURCES, LAST_RESORT_DEVICES }
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

type ExternalThermostats = NonNullable<ReturnType<typeof readExternalThermostats>>;

const persistExternalThermostat = (
  entries: readonly DevicePowerSetupEntry[], entry: DevicePowerSetupEntry, thermostat: string,
) => writeFreshSetting<ExternalThermostats>({
  key: DEVICE_EXTERNAL_THERMOSTATS,
  context: 'device setup',
  logMessage: 'Failed to save external thermostat',
  toastMessage: 'Could not save the external thermostat.',
  fallbackValue: Object.fromEntries(entries.flatMap((device) => {
    const thermostatId = device.thermostatId ?? null;
    const waiting = device.thermostatWaitingForManualOn === true;
    if (!thermostatId && !waiting) return [];
    return [[device.id, { thermostatId, ...(waiting ? { waitForManualOn: true as const } : {}) }]];
  })),
  readFresh: readExternalThermostats,
  mutate: (current) => {
    const previous = current[entry.id];
    const waiting = previous?.waitForManualOn === true
      || Boolean(thermostat && !previous?.thermostatId && entry.lastResortMaximumW !== undefined);
    const binding = {
      thermostatId: thermostat || null,
      ...(waiting ? { waitForManualOn: true as const } : {}),
    };
    const unchanged = Object.entries(current).filter(([id]) => id !== entry.id);
    const updated = thermostat || waiting ? [...unchanged, [entry.id, binding]] : unchanged;
    const next = readExternalThermostats(Object.fromEntries(updated));
    if (!next) throw new Error('This device or thermostat is already used in another thermostat assignment.');
    return next;
  },
});

export type SetupDraft = { source: string; switchId: string; thermostat: string; lastResort: boolean; maximum: string };

const writeThermostatTransition = async (
  entries: readonly DevicePowerSetupEntry[], entry: DevicePowerSetupEntry, thermostat: string,
): Promise<boolean> => {
  const changed = (entry.thermostatId ?? '') !== thermostat;
  if (thermostat && changed && !await persistExternalThermostat(entries, entry, thermostat)) return false;
  if (entry.lastResortMaximumW !== undefined
    && !await persistLastResort(entries, entry, undefined)) return false;
  return !changed || Boolean(thermostat) || Boolean(await persistExternalThermostat(entries, entry, ''));
};

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
  const { source, thermostat, lastResort, maximum } = draft;
  const thermostatTransition = Boolean(thermostat || entry.thermostatId || entry.thermostatWaitingForManualOn);
  // Link first to suspend last-resort control. When unlinking, clear any
  // leftover maximum before removing the setting that keeps it suspended.
  if (thermostatTransition && !await writeThermostatTransition(entries, entry, thermostat)) return false;
  if (!await persistPhysicalControls(entries, entry, draft)) return false;
  if (thermostatTransition) return true;
  const maximumW = !source && lastResort ? Number(maximum) : undefined;
  return entry.lastResortMaximumW === maximumW || Boolean(await persistLastResort(entries, entry, maximumW));
});
