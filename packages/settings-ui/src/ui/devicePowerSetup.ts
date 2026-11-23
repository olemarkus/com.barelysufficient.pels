import type { DevicePowerSetupEntry, DevicePowerSetupRead } from '../../../contracts/src/settingsUi/devices.ts';
import { isLastResortMaximumW } from '../../../shared-domain/src/settings/lastResortDevices.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { createSelectOption } from './materialSelectOption.ts';
import type { MaterialSelectOptionElement } from './components.ts';
import { persistDeviceSetup, type SetupDraft } from './devicePowerSetupWrites.ts';
import { buildDevicePowerSetupForm } from './devicePowerSetupMarkup.ts';

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
      : 'Metering socket unavailable. Choose another power source under External sensors.';
  }
  return null;
};

/** A saved choice that stopped working. Unlike the setup hint, it never blocks Managed. */
export const devicePowerSetupWarning = (deviceId: string): string | null => {
  const entry = findSetupEntry(deviceId);
  if (!entry) return null;
  if (entry.thermostatId && (!thermostatChoice(entry, entry.thermostatId) || !entry.thermostatReady)) {
    return 'External thermostat unavailable. Check it in Homey or change it under External sensors.';
  }
  if (entry.binarySwitchId && !entry.binarySwitches?.some(({ id }) => id === entry.binarySwitchId)) {
    return 'Selected on/off control unavailable. Check the device in Homey or change it under External sensors.';
  }
  return null;
};

/** What External sensors offers a device that has no power reading yet. */
export const devicePowerSetupAlternative = (deviceId: string): string | null => {
  const entry = findSetupEntry(deviceId);
  if (!entry || entry.sourceId) return null;
  const socket = entry.sources.some(({ state }) => state === 'selectable');
  const lastResort = entry.lastResortAvailable === true;
  if (socket && lastResort) return 'Or choose a metering socket or last-resort control under External sensors.';
  if (socket) return 'Or choose a metering socket under External sensors.';
  return lastResort ? 'Or turn on last-resort control under External sensors.' : null;
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
  return { hint: 'Review last-resort control under External sensors.' };
}

export const readDevicePowerSetupDetail = (deviceId: string) => {
  const entry = findSetupEntry(deviceId);
  if (!entry) return undefined;
  return {
    lastResort: readLastResortSetup(deviceId),
    socketPending: Boolean(entry.sourceId && !entry.sourceReady),
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

// A Material select shows no text for an option whose value is empty, so the
// default choices ("This device", "Default") carry a placeholder value instead.
const DEFAULT_OPTION_VALUE = 'pels-default';
const toOptionValue = (value: string): string => value || DEFAULT_OPTION_VALUE;
const readSelectValue = (field: SetupSelect): string => (
  field.value === DEFAULT_OPTION_VALUE ? '' : field.value
);

function updateOptions(field: SetupSelect, options: readonly SetupOption[], value: string): void {
  const select = field;
  const signature = JSON.stringify(options);
  if (renderedOptions.get(select) !== signature) {
    const nodes = options.map(({ label, value: optionValue, disabled }) => {
      const option: MaterialSelectOptionElement = createSelectOption(toOptionValue(optionValue), label);
      option.disabled = disabled === true;
      return option;
    });
    select.replaceChildren(...nodes);
    renderedOptions.set(select, signature);
  }
  if (select.value !== toOptionValue(value)) select.value = toOptionValue(value);
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
  // "This device" only when it has a reading of its own to use.
  const ownLabel = entry?.ownPowerW === undefined ? 'None' : 'This device';
  return [{ value: '', label: ownLabel }, ...options];
}

function sourceHelp(entry: DevicePowerSetupEntry | undefined, selected: string): string {
  if (!entry) return '';
  const socket = entry.sources.find(({ id }) => id === selected);
  if (selected && selected === entry.sourceId && !entry.sourceReady) {
    return socket ? `Waiting for a power reading from ${formatDisplayDeviceName(socket.name)}.`
      : 'The configured metering socket is unavailable. Choose another power source.';
  }
  if (socket?.state && socket.state !== 'selectable') return unavailableReason(socket.state);
  const own = entry.ownPowerW;
  if (socket) {
    const name = formatDisplayDeviceName(socket.name);
    return own === undefined ? `PELS reads this device's power from ${name}.`
      : `PELS uses ${name} instead of this device's own reading.`;
  }
  return own === undefined ? 'This device has no power reading. Choose a metering socket to measure it.'
    : `Uses this device's own reading, now ${own.toLocaleString()} W.`;
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
const THERMOSTAT_MANUAL_RESTART_HINT = 'Turn the device on in Homey when you are ready.';

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

const setupControl = <T extends HTMLElement = HTMLElement>(root: HTMLElement, name: string): T | null => (
  root.querySelector<T>(`[data-setup="${name}"]`)
);

function readThermostatFields(root: HTMLElement) {
  const section = setupControl(root, 'thermostat-field');
  const select = setupControl<SetupSelect>(root, 'thermostat');
  const preview = setupControl(root, 'thermostat-preview');
  const status = setupControl(root, 'thermostat-status');
  const confirm = setupControl<SetupDialog>(root, 'thermostat-confirm');
  return section && select && preview && status && confirm ? { section, select, preview, status, confirm } : undefined;
}

function readSetupFields(root: HTMLElement) {
  const targetField = setupControl(root, 'target-field');
  const details = setupControl(root, 'details');
  const target = setupControl<SetupSelect>(root, 'target');
  const source = setupControl<SetupSelect>(root, 'source');
  const help = setupControl(root, 'help');
  const control = setupControl<SetupSelect>(root, 'binary');
  const switchField = setupControl(root, 'binary-field');
  const switchHelp = setupControl(root, 'binary-help');
  const lastResort = setupControl(root, 'last-resort');
  const lastResortToggle = setupControl<HTMLElement & { selected: boolean; disabled: boolean }>(
    root, 'last-resort-toggle',
  );
  const lastResortHelp = setupControl(root, 'last-resort-help');
  const maximum = setupControl<HTMLElement & { value: string; disabled: boolean }>(root, 'maximum');
  const save = setupControl<HTMLElement & { disabled: boolean }>(root, 'save');
  const thermostat = readThermostatFields(root);
  if (!targetField || !details || !target || !source || !help || !control || !switchField || !switchHelp
    || !lastResort || !lastResortToggle || !lastResortHelp || !maximum || !save || !thermostat) return undefined;
  return { targetField, details, target, source, help, control, switchField, switchHelp, lastResort, lastResortToggle,
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
  (maximum.closest<HTMLElement>('.md-field-row') ?? maximum).hidden = !draft.lastResort;
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
  // New thermostat links are not offered for now; a saved one stays visible so it can be removed.
  section.hidden = !entry?.thermostatId && !waiting;
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

/**
 * `add` lists the devices that are not in the device list yet, behind a device
 * picker; `device` edits the one device whose page is open.
 */
type SetupFormMode = 'add' | 'device';

class DevicePowerSetupForm {
  private selectedId = '';
  private draft: SetupDraft | undefined;
  private awaitingReadback = false;
  private saving = false;
  private candidates: readonly DevicePowerSetupEntry[] = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly fields: SetupFields,
    private readonly mode: SetupFormMode,
  ) {
    const { target, source, control, lastResortToggle, maximum, save, thermostat } = fields;
    target.onchange = () => this.select(readSelectValue(target));
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
    // Adding a device saves even its default choices, and an unfinished thermostat
    // handoff can be saved again; otherwise Save needs a change.
    const unchanged = (this.mode === 'device' || entry?.configured === true)
      && sameSetupDraft(current, acceptedDraft(entry)) && !(entry && confirmsLastResortHandoff(entry, current));
    this.fields.save.disabled = this.saving || !entry || reserved || unchanged
      || invalidLastResort || hasUnavailableEdit(entry, current);
  }

  private readCurrentDraft(entry: DevicePowerSetupEntry | undefined): SetupDraft {
    const accepted = acceptedDraft(entry);
    if (this.awaitingReadback && this.draft && entry?.configured && sameSetupDraft(this.draft, accepted)) {
      this.clearDraft();
    }
    return this.draft ?? accepted;
  }

  /** The device page shows its own device; the add card offers devices outside the list. */
  show(deviceId: string | undefined, listedIds: ReadonlySet<string> = new Set()): void {
    if (this.mode === 'device') {
      if (deviceId !== this.selectedId && !this.saving) {
        this.clearDraft();
        this.selectedId = deviceId ?? '';
      }
    } else {
      this.candidates = entries.filter((entry) => !listedIds.has(entry.id) && !companionTarget(entry));
      if (!this.saving && !this.candidates.some(({ id }) => id === this.selectedId)) this.select('');
    }
    this.render();
  }

  private isShown(): boolean {
    if (this.mode === 'add') return this.candidates.length > 0;
    const entry = findSetupEntry(this.selectedId);
    return entry !== undefined && !companionTarget(entry);
  }

  render(): void {
    this.container.hidden = !this.isShown();
    if (this.container.hidden) return;
    const entry = findSetupEntry(this.selectedId);
    const current = this.readCurrentDraft(entry);
    const disabled = this.saving || !entry || Boolean(companionTarget(entry));
    const fields = this.fields;
    if (this.mode === 'add') {
      updateOptions(fields.target, [{ value: '', label: 'Select a device' }, ...this.candidates.map((candidate) => ({
        value: candidate.id, label: formatDisplayDeviceName(candidate.name),
      }))], entry?.id ?? '');
    }
    updateOptions(fields.source, sourceOptions(entry, current.source), current.source);
    updateOptions(fields.control, switchOptions(entry, current.switchId), current.switchId);
    fields.target.disabled = this.saving;
    fields.targetField.hidden = this.mode === 'device';
    fields.details.hidden = !entry;
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
    this.render();
  }

  private clearDraft(): void {
    this.draft = undefined;
    this.awaitingReadback = false;
  }

  private edit(): void {
    if (this.saving) return;
    this.awaitingReadback = false;
    this.draft = {
      source: readSelectValue(this.fields.source),
      switchId: readSelectValue(this.fields.control),
      thermostat: readSelectValue(this.fields.thermostat.select),
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
    this.render();
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
      await refreshDeviceSetup();
    } finally {
      this.saving = false;
      this.render();
    }
  }
}

let refreshDeviceSetup: () => Promise<void> = async () => {};
const setupForms = new WeakMap<HTMLElement, DevicePowerSetupForm>();

function formFor(container: HTMLElement, host: HTMLElement, mode: SetupFormMode): DevicePowerSetupForm | undefined {
  const existing = setupForms.get(container);
  if (existing) return existing;
  if (!setupControl(host, 'save')) buildDevicePowerSetupForm(host, container.id);
  const fields = readSetupFields(host);
  if (!fields) return undefined;
  const form = new DevicePowerSetupForm(container, fields, mode);
  setupForms.set(container, form);
  return form;
}

const setupHost = (container: HTMLElement): HTMLElement => (
  container.querySelector<HTMLElement>('[data-setup-host]') ?? container
);

const deviceFormContainer = (): HTMLElement | null => document.getElementById('device-detail-power-setup');

/**
 * Render the "Add a device" card for setup devices missing from the device list,
 * and refresh the open device page's form. Returns whether the card is shown.
 */
export function renderDevicePowerSetup(
  refresh: () => Promise<void>, visible: boolean, listedIds: ReadonlySet<string>,
): boolean {
  refreshDeviceSetup = refresh;
  const detail = deviceFormContainer();
  if (detail) setupForms.get(detail)?.render();
  const root = document.querySelector<HTMLDetailsElement>('#device-power-setup');
  if (!root) return false;
  const form = formFor(root, setupHost(root), 'add');
  if (!form) return false;
  form.show(undefined, listedIds);
  if (!visible) root.hidden = true;
  return !root.hidden;
}

/** Show the setup form for the device whose page is open, or hide it. */
export function renderDeviceDetailPowerSetup(deviceId: string | undefined): void {
  const container = deviceFormContainer();
  if (!container) return;
  formFor(container, setupHost(container), 'device')?.show(deviceId);
}
