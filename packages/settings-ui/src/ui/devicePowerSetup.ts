import type { DevicePowerSetupEntry, DevicePowerSetupRead } from '../../../contracts/src/settingsUi/devices.ts';
import { readDevicePowerSources, type DevicePowerSources }
  from '../../../shared-domain/src/settings/devicePowerSources.ts';
import { readDeviceBinarySwitches, type DeviceBinarySwitches }
  from '../../../shared-domain/src/settings/deviceBinarySwitches.ts';
import { isLastResortMaximumW, readLastResortDevices, type LastResortDevices }
  from '../../../shared-domain/src/settings/lastResortDevices.ts';
import { DEVICE_BINARY_SWITCHES, DEVICE_POWER_SOURCES, LAST_RESORT_DEVICES }
  from '../../../shared-domain/src/settings/settingsKeys.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { createSelectOption } from './materialSelectOption.ts';
import type { MaterialSelectOptionElement } from './components.ts';
import { createSerializedAsyncRunner, writeFreshSetting } from './deviceDetail/settingsWrite.ts';

let entries: readonly DevicePowerSetupEntry[] = [];
const writeDeviceSetup = createSerializedAsyncRunner();

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

export const isLastResortConfigured = (deviceId: string): boolean => (
  entries.some((entry) => entry.id === deviceId && entry.lastResortMaximumW !== undefined && !entry.sourceId)
);

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

const persistPowerSource = (entry: DevicePowerSetupEntry, source: string | null) => {
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

const persistBinarySwitch = (entry: DevicePowerSetupEntry, switchId: string | null) => (
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

const persistLastResort = (entry: DevicePowerSetupEntry, maximum: number | undefined) => (
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

const persist = (
  entry: DevicePowerSetupEntry, sourceId: string | null, switchId: string | null, maximum: number | undefined,
) => (
  writeDeviceSetup(async () => {
    if ((entry.binarySwitchId ?? null) !== switchId && !await persistBinarySwitch(entry, switchId)) return false;
    if ((!entry.configured || entry.sourceId !== sourceId) && !await persistPowerSource(entry, sourceId)) return false;
    if (entry.lastResortMaximumW === maximum) return true;
    return (await persistLastResort(entry, maximum)) !== null;
  })
);

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

function fillSwitchOptions(control: SetupSelect, entry: DevicePowerSetupEntry | undefined): void {
  control.replaceChildren();
  addOption(control, 'Default', '');
  for (const option of entry?.binarySwitches ?? []) addOption(control, option.name, option.id);
  if (entry?.binarySwitchId && !entry.binarySwitches?.some(({ id }) => id === entry.binarySwitchId)) {
    addOption(control, 'Selected switch unavailable', entry.binarySwitchId).disabled = true;
  }
}

function updateSwitchOptions(
  control: SetupSelect, entry: DevicePowerSetupEntry | undefined, previousSwitch: string,
): { visible: boolean; value: string; hint: string } {
  const switches = entry?.binarySwitches ?? [];
  const visible = Boolean(entry?.binarySwitchId) || switches.some(({ id }) => id !== 'onoff');
  fillSwitchOptions(control, entry);
  const keepSwitch = switches.some(({ id }) => id === previousSwitch);
  const value = keepSwitch ? previousSwitch : entry?.binarySwitchId ?? '';
  const available = value === '' || switches.some(({ id }) => id === value);
  const hint = available
    ? 'Choose which switch PELS uses for power limiting.' : 'PELS cannot use this switch right now.';
  return { visible, value, hint };
}

const readLastResortControls = () => ({
  lastResort: document.getElementById('device-power-setup-last-resort'),
  lastResortToggle: document.querySelector<HTMLElement & { selected: boolean }>(
    '#device-power-setup-last-resort-toggle',
  ),
  maximum: document.querySelector<HTMLElement & { value: string }>('#device-power-setup-maximum'),
});

export const allowLastResortPriorityMove = (dragged: HTMLElement, related: HTMLElement): boolean => (
  isLastResortConfigured(dragged.dataset.deviceId ?? '') === isLastResortConfigured(related.dataset.deviceId ?? '')
);

export function appendLastResortLabel(name: HTMLElement, deviceId: string): void {
  if (!isLastResortConfigured(deviceId)) return;
  const label = document.createElement('small');
  label.className = 'muted';
  label.textContent = 'Last resort';
  name.appendChild(label);
}

export function renderDevicePowerSetup(refresh: () => Promise<void>): void {
  const root = document.getElementById('device-power-setup');
  const target = document.querySelector<SetupSelect>('#device-power-setup-target');
  const source = document.querySelector<SetupSelect>('#device-power-setup-source');
  const help = document.getElementById('device-power-setup-help');
  const switchField = document.getElementById('device-power-setup-binary-field');
  const control = document.querySelector<SetupSelect>('#device-power-setup-binary');
  const switchHelp = document.getElementById('device-power-setup-binary-help');
  const { lastResort, lastResortToggle, maximum } = readLastResortControls();
  const save = document.querySelector<HTMLElement & { disabled: boolean }>('#device-power-setup-save');
  if (!root || !target || !source || !help || !switchField || !control || !switchHelp
    || !save || !lastResort || !lastResortToggle || !maximum) return;
  root.hidden = entries.length === 0;
  const previousTarget = target.value;
  const previousSource = source.value;
  const previousSwitch = control.value;
  target.replaceChildren();
  addOption(target, 'Select a device', '');
  for (const entry of entries) {
    addOption(target, formatDisplayDeviceName(entry.name), entry.id).disabled = entry.usedBy !== null;
  }
  if (entries.some((entry) => entry.id === previousTarget)) target.value = previousTarget;

  const selected = () => entries.find((entry) => entry.id === target.value);
  const updateSave = (): void => {
    const entry = selected();
    const changedSourceUnavailable = source.selectedOptions[0]?.disabled === true && source.value !== entry?.sourceId;
    const changedSwitchUnavailable = control.selectedOptions[0]?.disabled === true
      && control.value !== entry?.binarySwitchId;
    const lastResortAvailable = Boolean(entry && !source.value
      && (entry.lastResortAvailable || entry.lastResortMaximumW !== undefined));
    lastResort.hidden = !lastResortAvailable;
    maximum.hidden = !lastResortToggle.selected;
    const invalidMaximum = lastResortAvailable && lastResortToggle.selected
      && !isLastResortMaximumW(Number(maximum.value));
    save.disabled = entry === undefined || changedSourceUnavailable || changedSwitchUnavailable || invalidMaximum;
  };
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
    const switchOptions = updateSwitchOptions(control, entry, preserveSelection ? previousSwitch : '');
    control.value = switchOptions.value;
    switchField.hidden = !switchOptions.visible;
    switchHelp.textContent = switchOptions.hint;
    lastResortToggle.selected = entry?.lastResortMaximumW !== undefined;
    maximum.value = entry?.lastResortMaximumW?.toString() ?? '';
    updateSave();
  };
  target.onchange = () => updateSource(false);
  source.onchange = updateSave;
  control.onchange = updateSave;
  lastResortToggle.onchange = updateSave;
  maximum.oninput = updateSave;
  save.onclick = async () => {
    const entry = selected();
    if (!entry || save.disabled) return;
    target.disabled = true;
    source.disabled = true;
    control.disabled = true;
    save.disabled = true;
    try {
      const maximumW = !lastResort.hidden && lastResortToggle.selected ? Number(maximum.value) : undefined;
      await persist(entry, source.value || null, control.value || null, maximumW);
      await refresh();
    } finally {
      target.disabled = false;
      control.disabled = false;
      updateSource(false);
    }
  };
  updateSource(true);
}
