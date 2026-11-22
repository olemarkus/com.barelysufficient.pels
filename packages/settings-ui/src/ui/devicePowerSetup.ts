import type { DevicePowerSetupEntry, DevicePowerSetupRead } from '../../../contracts/src/settingsUi/devices.ts';
import { readDevicePowerSources, type DevicePowerSources }
  from '../../../shared-domain/src/settings/devicePowerSources.ts';
import { DEVICE_POWER_SOURCES } from '../../../shared-domain/src/settings/settingsKeys.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { createSelectOption } from './advanced.ts';
import type { MaterialSelectOptionElement } from './components.ts';
import { createSerializedAsyncRunner, writeFreshSetting } from './deviceDetail/settingsWrite.ts';

let entries: readonly DevicePowerSetupEntry[] = [];
const writePowerSource = createSerializedAsyncRunner();

export const acceptDevicePowerSetup = (read: DevicePowerSetupRead | undefined): void => {
  if (read) entries = read.devices;
};

export const devicePowerSetupHint = (deviceId: string): string | null => {
  const entry = entries.find((candidate) => candidate.id === deviceId);
  if (entry?.usedBy) {
    const targetName = entries.find((candidate) => candidate.id === entry.usedBy)?.name;
    return targetName ? `Used to measure ${formatDisplayDeviceName(targetName)}.` : 'Used as a power source.';
  }
  if (entry?.sourceId && !entry.sourceReady) return 'Waiting for a power reading from the metering socket.';
  return null;
};

export const isSocketReservedForPower = (deviceId: string): boolean => (
  entries.some((entry) => entry.id === deviceId && entry.usedBy !== null)
);

type SetupSelect = HTMLElement & {
  value: string;
  disabled: boolean;
  selectedOptions: readonly MaterialSelectOptionElement[];
};

const addOption = (select: SetupSelect, label: string, value: string): MaterialSelectOptionElement => {
  const option = createSelectOption(value, label);
  select.append(option);
  return option;
};

const unavailableReason = (state: DevicePowerSetupEntry['sources'][number]['state']): string => {
  switch (state) {
    case 'managed': return 'Turn off Managed by PELS to use this socket';
    case 'assigned': return 'Already measures another device';
    case 'unavailable': return 'Unavailable as a power source';
    default: return '';
  }
};

const persist = (entry: DevicePowerSetupEntry, source: string | null) => writePowerSource(async () => {
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
});

function fillSourceOptions(source: SetupSelect, entry: DevicePowerSetupEntry | undefined): void {
  source.replaceChildren();
  addOption(source, 'This device', '');
  for (const socket of entry?.sources ?? []) {
    const reason = unavailableReason(socket.state);
    const label = formatDisplayDeviceName(socket.name);
    addOption(source, reason ? `${label} (${reason})` : label, socket.id).disabled = reason !== '';
  }
  if (entry?.sourceId && !entry.sources.some(({ id }) => id === entry.sourceId)) {
    addOption(source, 'Configured socket unavailable', entry.sourceId).disabled = true;
  }
}

export function renderDevicePowerSetup(refresh: () => Promise<void>): void {
  const root = document.getElementById('device-power-setup');
  const target = document.querySelector<SetupSelect>('#device-power-setup-target');
  const source = document.querySelector<SetupSelect>('#device-power-setup-source');
  const help = document.getElementById('device-power-setup-help');
  const save = document.querySelector<HTMLElement & { disabled: boolean }>('#device-power-setup-save');
  if (!root || !target || !source || !help || !save) return;
  root.hidden = entries.length === 0;
  const previousTarget = target.value;
  const previousSource = source.value;
  target.replaceChildren();
  addOption(target, 'Select a device', '');
  for (const entry of entries) {
    addOption(target, formatDisplayDeviceName(entry.name), entry.id).disabled = entry.usedBy !== null;
  }
  if (entries.some((entry) => entry.id === previousTarget)) target.value = previousTarget;

  const selected = () => entries.find((entry) => entry.id === target.value);
  const updateSource = (preserveSelection: boolean): void => {
    const entry = selected();
    fillSourceOptions(source, entry);
    const keepSource = preserveSelection && entry?.sources.some((socket) => (
      socket.id === previousSource && socket.state === 'selectable'
    ));
    source.value = keepSource ? previousSource : entry?.sourceId ?? '';
    const hint = entry ? devicePowerSetupHint(entry.id) : null;
    help.textContent = hint ?? 'Choose an unmanaged socket you use to measure this device.';
    source.disabled = entry === undefined;
    save.disabled = entry === undefined || source.selectedOptions[0]?.disabled === true;
  };
  target.onchange = () => updateSource(false);
  source.onchange = () => { save.disabled = source.selectedOptions[0]?.disabled === true; };
  save.onclick = async () => {
    const entry = selected();
    if (!entry || save.disabled) return;
    target.disabled = true;
    source.disabled = true;
    save.disabled = true;
    try {
      if (await persist(entry, source.value || null)) await refresh();
    } finally {
      target.disabled = false;
      updateSource(false);
    }
  };
  updateSource(true);
}
