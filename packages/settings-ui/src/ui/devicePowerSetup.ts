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

const findSetupEntry = (id: string): DevicePowerSetupEntry | undefined => (
  entries.find((entry) => entry.id === id)
);

export const devicePowerSetupHint = (deviceId: string): string | null => {
  const entry = findSetupEntry(deviceId);
  if (entry?.usedBy) {
    const targetName = entries.find((candidate) => candidate.id === entry.usedBy)?.name;
    return targetName ? `Used to measure ${formatDisplayDeviceName(targetName)}.` : 'Used as a power source.';
  }
  if (entry?.sourceId && !entry.sourceReady) return 'Waiting for a power reading from the metering socket.';
  return null;
};

export function readLastResortSetup(deviceId: string) {
  const entry = findSetupEntry(deviceId);
  if (entry?.lastResortMaximumW === undefined || entry.sourceId) return undefined;
  if (canEnableLastResort(entry, entry.binarySwitchId ?? '')) {
    return {
      hint: 'Last resort. PELS can turn it off after limiting other devices.',
      maximumW: entry.lastResortMaximumW,
    };
  }
  return { hint: 'Review last-resort control in Device setup.' };
}

export const readDevicePowerSetupDetail = (deviceId: string) => {
  const entry = findSetupEntry(deviceId);
  if (!entry) return undefined;
  const socket = entry.sources.find(({ id }) => id === entry.sourceId);
  const selectedSwitch = entry.binarySwitches?.find(({ id }) => id === entry.binarySwitchId);
  return {
    editable: entry.usedBy === null,
    lastResort: readLastResortSetup(deviceId),
    socket: socket ? formatDisplayDeviceName(socket.name) : undefined,
    switchName: selectedSwitch?.name,
    socketPending: Boolean(entry.sourceId && !entry.sourceReady),
    socketMissing: Boolean(entry.sourceId && !socket),
    switchMissing: Boolean(entry.binarySwitchId && !selectedSwitch),
  };
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
};

type SetupOption = { value: string; label: string; disabled?: boolean };
const renderedOptions = new WeakMap<SetupSelect, string>();

function updateOptions(field: SetupSelect, options: readonly SetupOption[], value: string): void {
  const select = field;
  const signature = JSON.stringify(options);
  if (renderedOptions.get(select) !== signature) {
    const nodes = options.map(({ label, value: optionValue, disabled }) => {
      const option: MaterialSelectOptionElement = createSelectOption(optionValue, label);
      option.disabled = disabled === true;
      return option;
    });
    select.replaceChildren(...nodes);
    renderedOptions.set(select, signature);
  }
  if (select.value !== value) select.value = value;
}

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

type SetupDraft = { source: string; switchId: string; lastResort: boolean; maximum: string };

const acceptedDraft = (entry: DevicePowerSetupEntry | undefined): SetupDraft => ({
  source: entry?.sourceId ?? '',
  switchId: entry?.binarySwitchId ?? '',
  lastResort: entry?.lastResortMaximumW !== undefined,
  maximum: entry?.lastResortMaximumW?.toString() ?? '',
});

const sameSetupDraft = (left: SetupDraft, right: SetupDraft): boolean => (
  left.source === right.source && left.switchId === right.switchId
  && left.lastResort === right.lastResort && left.maximum === right.maximum
);

function sourceOptions(entry: DevicePowerSetupEntry | undefined, selected: string): SetupOption[] {
  const options = (entry?.sources ?? []).map((socket) => {
    const reason = unavailableReason(socket.state);
    const name = formatDisplayDeviceName(socket.name);
    return { value: socket.id, label: reason ? `${name} (${reason})` : name, disabled: reason !== '' };
  });
  if (selected && !options.some(({ value }) => value === selected)) {
    options.push({ value: selected, label: 'Metering socket unavailable', disabled: true });
  }
  return [{ value: '', label: 'This device' }, ...options];
}

function sourceHelp(entry: DevicePowerSetupEntry | undefined, selected: string): string {
  if (!entry) return '';
  const socket = entry.sources.find(({ id }) => id === selected);
  if (selected && selected === entry.sourceId && !entry.sourceReady) {
    return socket ? `Waiting for a power reading from ${formatDisplayDeviceName(socket.name)}.`
      : 'The configured metering socket is unavailable.';
  }
  if (socket?.state && socket.state !== 'selectable') return unavailableReason(socket.state);
  return 'Choose an unmanaged metering socket if this device has no power reading of its own.';
}

function switchOptions(entry: DevicePowerSetupEntry | undefined, selected: string): SetupOption[] {
  const options: SetupOption[] = (entry?.binarySwitches ?? []).map(({ id, name }) => ({ value: id, label: name }));
  if (selected && !options.some(({ value }) => value === selected)) {
    options.push({ value: selected, label: 'Selected switch unavailable', disabled: true });
  }
  const defaultLabel = entry?.defaultBinarySwitchAvailable === false ? 'No on/off control' : 'Default';
  return [{ value: '', label: defaultLabel }, ...options];
}

function readSetupFields(root: HTMLDetailsElement) {
  const target = root.querySelector<SetupSelect>('#device-power-setup-target');
  const source = root.querySelector<SetupSelect>('#device-power-setup-source');
  const help = root.querySelector<HTMLElement>('#device-power-setup-help');
  const control = root.querySelector<SetupSelect>('#device-power-setup-binary');
  const switchField = root.querySelector<HTMLElement>('#device-power-setup-binary-field');
  const switchHelp = root.querySelector<HTMLElement>('#device-power-setup-binary-help');
  const lastResort = root.querySelector<HTMLElement>('#device-power-setup-last-resort');
  const lastResortToggle = root.querySelector<HTMLElement & { selected: boolean; disabled: boolean }>(
    '#device-power-setup-last-resort-toggle',
  );
  const lastResortHelp = root.querySelector<HTMLElement>('#device-power-setup-last-resort-help');
  const maximum = root.querySelector<HTMLElement & { value: string; disabled: boolean }>('#device-power-setup-maximum');
  const save = root.querySelector<HTMLElement & { disabled: boolean }>('#device-power-setup-save');
  if (!target || !source || !help || !control || !switchField || !switchHelp
    || !lastResort || !lastResortToggle || !lastResortHelp || !maximum || !save) return undefined;
  return { target, source, help, control, switchField, switchHelp, lastResort, lastResortToggle,
    lastResortHelp, maximum, save };
}

type SetupFields = NonNullable<ReturnType<typeof readSetupFields>>;

function hasUsableSwitch(entry: DevicePowerSetupEntry | undefined, switchId: string): boolean {
  if (switchId) return entry?.binarySwitches?.some(({ id }) => id === switchId) ?? false;
  return entry?.defaultBinarySwitchAvailable === true;
}

function canEnableLastResort(entry: DevicePowerSetupEntry | undefined, switchId: string): boolean {
  return entry?.lastResortAvailable === true && hasUsableSwitch(entry, switchId);
}

function syncLastResort(fields: SetupFields, entry: DevicePowerSetupEntry | undefined, draft: SetupDraft): boolean {
  const { lastResort, lastResortToggle, maximum, lastResortHelp } = fields;
  const offered = entry?.lastResortAvailable === true || entry?.lastResortMaximumW !== undefined;
  const usableSwitch = hasUsableSwitch(entry, draft.switchId);
  const canEnable = canEnableLastResort(entry, draft.switchId);
  const maximumIsValid = isLastResortMaximumW(Number(draft.maximum));
  const displayed = offered && !draft.source;
  lastResort.hidden = !displayed;
  lastResortToggle.disabled = !canEnable && !draft.lastResort;
  maximum.hidden = !draft.lastResort;
  maximum.disabled = !canEnable;
  lastResortHelp.textContent = resolveLastResortHelp(usableSwitch, canEnable, draft, maximumIsValid);
  return displayed && draft.lastResort && (!canEnable || !maximumIsValid);
}

function resolveLastResortHelp(
  usableSwitch: boolean, canEnable: boolean, draft: SetupDraft, maximumIsValid: boolean,
): string {
  if (!usableSwitch) return 'Choose an available on/off control to use last-resort control.';
  if (!canEnable) return 'Last-resort control is unavailable for this device.';
  if (draft.lastResort && !maximumIsValid) return 'Enter the maximum power in whole watts.';
  return 'PELS uses the household meter. If power is still too high after limiting other devices, PELS can turn this '
    + 'one off. It makes room for the maximum power before turning it back on.';
}

function hasUnavailableEdit(entry: DevicePowerSetupEntry, draft: SetupDraft): boolean {
  const sourceUnavailable = Boolean(draft.source && draft.source !== entry.sourceId
    && !entry.sources.some(({ id, state }) => id === draft.source && state === 'selectable'));
  const switchUnavailable = Boolean(draft.switchId && draft.switchId !== entry.binarySwitchId
    && !hasUsableSwitch(entry, draft.switchId));
  return sourceUnavailable || switchUnavailable;
}

export const allowLastResortPriorityMove = (dragged: HTMLElement, related: HTMLElement): boolean => (
  isLastResortConfigured(dragged.dataset.deviceId ?? '') === isLastResortConfigured(related.dataset.deviceId ?? '')
);

class DevicePowerSetupForm {
  private selectedId = '';
  private draft: SetupDraft | undefined;
  private awaitingReadback = false;
  private saving = false;

  constructor(
    private readonly root: HTMLDetailsElement,
    private readonly fields: SetupFields,
    private readonly refresh: () => Promise<void>,
  ) {
    const { target, source, control, lastResortToggle, maximum, save } = fields;
    target.onchange = () => this.select(target.value);
    source.onchange = () => this.edit();
    control.onchange = () => this.edit();
    lastResortToggle.onchange = () => this.edit();
    maximum.oninput = () => this.edit();
    save.onclick = () => this.save();
  }

  private updateSave(): void {
    const entry = findSetupEntry(this.selectedId);
    const current = this.draft ?? acceptedDraft(entry);
    const invalidLastResort = syncLastResort(this.fields, entry, current);
    if (this.saving) {
      this.fields.lastResortToggle.disabled = true;
      this.fields.maximum.disabled = true;
    }
    this.fields.save.disabled = this.saving || !entry || entry.usedBy !== null
      || invalidLastResort || hasUnavailableEdit(entry, current);
  }

  private readCurrentDraft(entry: DevicePowerSetupEntry | undefined): SetupDraft {
    const accepted = acceptedDraft(entry);
    if (this.awaitingReadback && this.draft && entry?.configured && sameSetupDraft(this.draft, accepted)) {
      this.clearDraft();
    }
    return this.draft ?? accepted;
  }

  render(visible: boolean): void {
    this.root.hidden = !visible || entries.length === 0;
    if (this.root.hidden) return;
    const entry = findSetupEntry(this.selectedId);
    const current = this.readCurrentDraft(entry);
    const disabled = this.saving || !entry || entry.usedBy !== null;
    const fields = this.fields;
    updateOptions(fields.target, [{ value: '', label: 'Select a device' }, ...entries.map((candidate) => ({
      value: candidate.id, label: formatDisplayDeviceName(candidate.name), disabled: candidate.usedBy !== null,
    }))], entry?.id ?? '');
    updateOptions(fields.source, sourceOptions(entry, current.source), current.source);
    updateOptions(fields.control, switchOptions(entry, current.switchId), current.switchId);
    fields.target.disabled = this.saving;
    fields.source.disabled = disabled;
    fields.control.disabled = disabled;
    fields.help.textContent = sourceHelp(entry, current.source);
    fields.switchField.hidden = !current.switchId && !entry?.binarySwitches?.length;
    fields.switchHelp.textContent = current.switchId && !hasUsableSwitch(entry, current.switchId)
      ? 'PELS cannot use this switch right now.' : 'Choose which switch PELS uses for power limiting.';
    if (fields.lastResortToggle.selected !== current.lastResort) fields.lastResortToggle.selected = current.lastResort;
    if (fields.maximum.value !== current.maximum) fields.maximum.value = current.maximum;
    this.updateSave();
  }

  private select(id: string): void {
    if (this.saving) return;
    if (id !== this.selectedId) this.clearDraft();
    this.selectedId = id;
    this.render(!this.root.hidden);
  }

  open(id: string): boolean {
    if (this.root.hidden || this.saving) return false;
    this.select(id);
    this.root.open = true;
    this.root.scrollIntoView?.({ block: 'start' });
    this.root.querySelector('summary')?.focus();
    return true;
  }

  private clearDraft(): void {
    this.draft = undefined;
    this.awaitingReadback = false;
  }

  private edit(): void {
    if (this.saving) return;
    this.awaitingReadback = false;
    this.draft = {
      source: this.fields.source.value,
      switchId: this.fields.control.value,
      lastResort: this.fields.lastResortToggle.selected,
      maximum: this.fields.maximum.value,
    };
    this.fields.help.textContent = sourceHelp(findSetupEntry(this.selectedId), this.draft.source);
    this.updateSave();
  }

  private async save(): Promise<void> {
    const entry = findSetupEntry(this.selectedId);
    if (!entry || this.fields.save.disabled) return;
    const current = this.draft ?? acceptedDraft(entry);
    this.saving = true;
    this.render(!this.root.hidden);
    try {
      const maximum = !current.source && current.lastResort ? Number(current.maximum) : undefined;
      const saved = await persist(entry, current.source || null, current.switchId || null, maximum);
      if (saved) {
        this.draft = { ...current, lastResort: maximum !== undefined, maximum: maximum?.toString() ?? '' };
        this.awaitingReadback = true;
      }
      await this.refresh();
    } finally {
      this.saving = false;
      this.render(!this.root.hidden);
      openRequestedDevice(this.root, this);
    }
  }
}

const setupForms = new WeakMap<HTMLDetailsElement, DevicePowerSetupForm>();
const pendingSetupTargets = new WeakMap<HTMLDetailsElement, string>();

function openRequestedDevice(root: HTMLDetailsElement, form: DevicePowerSetupForm): void {
  const deviceId = pendingSetupTargets.get(root);
  if (deviceId !== undefined && form.open(deviceId)) pendingSetupTargets.delete(root);
}

export function renderDevicePowerSetup(refresh: () => Promise<void>, visible: boolean): boolean {
  const root = document.querySelector<HTMLDetailsElement>('#device-power-setup');
  if (!root) return false;
  let form = setupForms.get(root);
  if (!form) {
    const fields = readSetupFields(root);
    if (!fields) return false;
    form = new DevicePowerSetupForm(root, fields, refresh);
    setupForms.set(root, form);
  }
  form.render(visible);
  openRequestedDevice(root, form);
  return !root.hidden;
}

export function openDevicePowerSetup(deviceId: string): void {
  const root = document.querySelector<HTMLDetailsElement>('#device-power-setup');
  if (!root) return;
  pendingSetupTargets.set(root, deviceId);
  const form = setupForms.get(root);
  if (form) openRequestedDevice(root, form);
}
