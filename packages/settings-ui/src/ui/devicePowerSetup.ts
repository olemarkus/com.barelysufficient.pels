import type { DevicePowerSetupEntry, DevicePowerSetupRead } from '../../../contracts/src/settingsUi/devices.ts';
import { isLastResortMaximumW } from '../../../shared-domain/src/settings/lastResortDevices.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { createSelectOption } from './materialSelectOption.ts';
import type { MaterialSelectOptionElement } from './components.ts';
import { persistDeviceSetup, type SetupDraft } from './devicePowerSetupWrites.ts';

let entries: readonly DevicePowerSetupEntry[] = [];

export const acceptDevicePowerSetup = (read: DevicePowerSetupRead | undefined): void => {
  if (read) entries = read.devices;
};

const findSetupEntry = (id: string): DevicePowerSetupEntry | undefined => (
  entries.find((entry) => entry.id === id)
);

const companionTarget = (entry: DevicePowerSetupEntry | undefined) => (
  entry?.usedBy ?? entry?.thermostatUsedBy
);

export const devicePowerSetupHint = (deviceId: string): string | null => {
  const entry = findSetupEntry(deviceId);
  if (entry?.usedBy) {
    const targetName = entries.find((candidate) => candidate.id === entry.usedBy)?.name;
    return targetName ? `Used to measure ${formatDisplayDeviceName(targetName)}.` : 'Used as a power source.';
  }
  if (entry?.thermostatUsedBy) {
    const target = findSetupEntry(entry.thermostatUsedBy);
    return target ? `Used as the thermostat for ${formatDisplayDeviceName(target.name)}.`
      : 'Used as an external thermostat.';
  }
  if (entry?.sourceId && !entry.sourceReady) {
    return entry.sources.some(({ id }) => id === entry.sourceId)
      ? 'Waiting for a power reading from the metering socket.'
      : 'Metering socket unavailable. Choose another power source in Device setup.';
  }
  return null;
};

/** A saved choice that stopped working. Unlike the setup hint, it never blocks Managed. */
export const devicePowerSetupWarning = (deviceId: string): string | null => {
  const entry = findSetupEntry(deviceId);
  if (!entry) return null;
  if (entry.thermostatId && (!thermostatChoice(entry, entry.thermostatId) || !entry.thermostatReady)) {
    return 'External thermostat unavailable. Check it in Homey or change it in Device setup.';
  }
  if (entry.binarySwitchId && !entry.binarySwitches?.some(({ id }) => id === entry.binarySwitchId)) {
    return 'Selected on/off control unavailable. Check the device in Homey or change it in Device setup.';
  }
  return null;
};

export const LAST_RESORT_NEEDS_MANAGED_HINT = 'Turn on Managed by PELS to use last-resort control.';

/** The last-resort line for a device card or page, which also says when Managed is missing. */
export const resolveLastResortHint = (
  setup: ReturnType<typeof readLastResortSetup>, managed: boolean,
): string | undefined => (
  setup?.maximumW !== undefined && !managed ? LAST_RESORT_NEEDS_MANAGED_HINT : setup?.hint
);

export const isLastResortOffered = (deviceId: string): boolean => (
  findSetupEntry(deviceId)?.lastResortAvailable === true
);

export function readLastResortSetup(deviceId: string) {
  const entry = findSetupEntry(deviceId);
  if (entry?.lastResortMaximumW === undefined || entry.sourceId || entry.thermostatId
    || entry.thermostatWaitingForManualOn) return undefined;
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
    editable: !companionTarget(entry),
    thermostat: readThermostatSummary(entry),
    thermostatWaitingForManualOn: entry.thermostatWaitingForManualOn === true,
    lastResort: readLastResortSetup(deviceId),
    socket: socket ? formatDisplayDeviceName(socket.name) : undefined,
    switchName: selectedSwitch?.name,
    socketPending: Boolean(entry.sourceId && !entry.sourceReady),
    socketMissing: Boolean(entry.sourceId && !socket),
    switchMissing: Boolean(entry.binarySwitchId && !selectedSwitch),
  };
};

export const isLastResortConfigured = (deviceId: string): boolean => (
  entries.some((entry) => entry.id === deviceId && entry.lastResortMaximumW !== undefined && !entry.sourceId
    && !entry.thermostatId && !entry.thermostatWaitingForManualOn)
);

export const isDeviceReservedBySetup = (deviceId: string): boolean => (
  Boolean(companionTarget(findSetupEntry(deviceId)))
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

const acceptedDraft = (entry: DevicePowerSetupEntry | undefined): SetupDraft => ({
  source: entry?.sourceId ?? '',
  switchId: entry?.binarySwitchId ?? '',
  thermostat: entry?.thermostatId ?? '',
  lastResort: entry?.lastResortMaximumW !== undefined,
  maximum: entry?.lastResortMaximumW?.toString() ?? '',
});

const sameSetupDraft = (left: SetupDraft, right: SetupDraft): boolean => (
  left.source === right.source && left.switchId === right.switchId && left.thermostat === right.thermostat
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
      : 'The configured metering socket is unavailable. Choose another power source.';
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

function thermostatChoice(entry: DevicePowerSetupEntry | undefined, id: string) {
  return entry?.thermostats?.find((option) => option.id === id);
}

function readThermostatSummary(entry: DevicePowerSetupEntry): string {
  if (!entry.thermostatId) return '';
  const choice = thermostatChoice(entry, entry.thermostatId);
  if (!choice) return 'External thermostat unavailable';
  const name = formatDisplayDeviceName(choice.name);
  return entry.thermostatReady ? `External thermostat is ${name}` : `External thermostat ${name} is unavailable`;
}

type ThermostatOptionState = NonNullable<DevicePowerSetupEntry['thermostats']>[number]['state'];

const thermostatUnavailableReason = (state: ThermostatOptionState): string => {
  switch (state) {
    case 'managed': return 'Turn off Managed by PELS to use this thermostat';
    case 'assigned': return 'Already controls another device';
    case 'unavailable': return 'Temperature control unavailable';
    default: return '';
  }
};

function thermostatOptions(entry: DevicePowerSetupEntry | undefined, selected: string): SetupOption[] {
  const options: SetupOption[] = (entry?.thermostats ?? []).map((option) => {
    const reason = thermostatUnavailableReason(option.state);
    const name = formatDisplayDeviceName(option.name);
    return { value: option.id, label: reason ? `${name} (${reason})` : name, disabled: Boolean(reason) };
  });
  if (selected && !options.some(({ value }) => value === selected)) {
    options.push({ value: selected, label: 'Configured thermostat unavailable', disabled: true });
  }
  return [{ value: '', label: 'No external thermostat' }, ...options];
}

const thermostatDegrees = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
export const THERMOSTAT_MANUAL_RESTART_HINT = 'Turn the device on in Homey when you are ready.';

function thermostatPreview(entry: DevicePowerSetupEntry | undefined, id: string): string {
  if (!id) return '';
  const choice = thermostatChoice(entry, id);
  if (!choice) return 'The configured thermostat is unavailable.';
  if (choice.state !== 'selectable') return thermostatUnavailableReason(choice.state);
  const { currentTemperature, targetTemperature } = choice;
  return [
    currentTemperature === undefined ? '' : `Temperature ${thermostatDegrees.format(currentTemperature)} °C`,
    targetTemperature === undefined ? '' : `Target ${thermostatDegrees.format(targetTemperature)} °C`,
  ].filter(Boolean).join(' · ');
}

type SetupDialog = HTMLElement & { returnValue: string; show: () => void };

function readThermostatFields(root: HTMLDetailsElement) {
  const section = root.querySelector<HTMLElement>('#device-power-setup-thermostat-field');
  const select = root.querySelector<SetupSelect>('#device-power-setup-thermostat');
  const preview = root.querySelector<HTMLElement>('#device-power-setup-thermostat-preview');
  const status = root.querySelector<HTMLElement>('#device-power-setup-thermostat-status');
  const confirm = root.querySelector<SetupDialog>('#device-power-setup-thermostat-confirm');
  return section && select && preview && status && confirm ? { section, select, preview, status, confirm } : undefined;
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
  const thermostat = readThermostatFields(root);
  if (!target || !source || !help || !control || !switchField || !switchHelp
    || !lastResort || !lastResortToggle || !lastResortHelp || !maximum || !save || !thermostat) return undefined;
  return { target, source, help, control, switchField, switchHelp, lastResort, lastResortToggle,
    lastResortHelp, maximum, save, thermostat };
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
  const displayed = offered && !draft.source && !draft.thermostat && !entry?.thermostatId
    && !entry?.thermostatWaitingForManualOn;
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
  const thermostatUnavailable = Boolean(draft.thermostat && draft.thermostat !== entry.thermostatId
    && thermostatChoice(entry, draft.thermostat)?.state !== 'selectable');
  return sourceUnavailable || switchUnavailable || thermostatUnavailable;
}

function confirmsLastResortHandoff(entry: DevicePowerSetupEntry, draft: SetupDraft): boolean {
  return entry.lastResortMaximumW !== undefined
    && Boolean(draft.thermostat || entry.thermostatId || entry.thermostatWaitingForManualOn);
}

function confirmLastResortHandoff(element: SetupDialog): Promise<boolean> {
  const dialog = element;
  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.show();
  });
}

function syncThermostatFields(
  fields: SetupFields['thermostat'], entry: DevicePowerSetupEntry | undefined, draft: SetupDraft, disabled: boolean,
): void {
  const { section, select, preview, status } = fields;
  const waiting = entry?.thermostatWaitingForManualOn === true;
  section.hidden = !draft.thermostat && !entry?.thermostats?.length && !entry?.thermostatId && !waiting;
  select.disabled = disabled;
  updateOptions(select, thermostatOptions(entry, draft.thermostat), draft.thermostat);
  preview.textContent = thermostatPreview(entry, draft.thermostat);
  if (entry && confirmsLastResortHandoff(entry, draft)) {
    status.textContent = 'Saving this setup removes last-resort control after you confirm.';
  } else {
    status.textContent = waiting ? THERMOSTAT_MANUAL_RESTART_HINT : '';
  }
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
    const { target, source, control, lastResortToggle, maximum, save, thermostat } = fields;
    target.onchange = () => this.select(target.value);
    source.onchange = () => this.edit();
    control.onchange = () => this.edit();
    thermostat.select.onchange = () => this.edit();
    lastResortToggle.onchange = () => this.edit();
    maximum.oninput = () => this.edit();
    save.onclick = () => this.save();
  }

  private updateSave(): void {
    const entry = findSetupEntry(this.selectedId);
    const current = this.draft ?? acceptedDraft(entry);
    const invalidLastResort = syncLastResort(this.fields, entry, current);
    const reserved = Boolean(companionTarget(entry));
    syncThermostatFields(this.fields.thermostat, entry, current, this.saving || !entry || reserved);
    if (this.saving) {
      this.fields.lastResortToggle.disabled = true;
      this.fields.maximum.disabled = true;
    }
    this.fields.save.disabled = this.saving || !entry || reserved
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
    const disabled = this.saving || !entry || Boolean(companionTarget(entry));
    const fields = this.fields;
    updateOptions(fields.target, [{ value: '', label: 'Select a device' }, ...entries.map((candidate) => ({
      value: candidate.id,
      label: formatDisplayDeviceName(candidate.name),
      disabled: Boolean(companionTarget(candidate)),
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
      thermostat: this.fields.thermostat.select.value,
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
      const handoff = confirmsLastResortHandoff(entry, current);
      if (handoff && !await confirmLastResortHandoff(this.fields.thermostat.confirm)) return;
      const maximum = !current.source && !handoff && current.lastResort ? Number(current.maximum) : undefined;
      const submitted = { ...current, lastResort: maximum !== undefined, maximum: maximum?.toString() ?? '' };
      const saved = await persistDeviceSetup(entries, entry, submitted);
      if (saved) {
        this.draft = submitted;
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
