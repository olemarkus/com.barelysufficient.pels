import type { DevicePowerSetupEntry, DevicePowerSetupRead } from '../../../contracts/src/settingsUi/devices.ts';
import { isLastResortMaximumW } from '../../../shared-domain/src/settings/lastResortDevices.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { createSelectOption } from './materialSelectOption.ts';
import type { MaterialSelectOptionElement } from './components.ts';
import { persistDeviceSetup, type SetupDraft } from './devicePowerSetupWrites.ts';
import { buildDevicePowerSetupForm, type SetupPart } from './devicePowerSetupMarkup.ts';

let entries: readonly DevicePowerSetupEntry[] = [];

export const acceptDevicePowerSetup = (read: DevicePowerSetupRead | undefined): void => {
  if (read) entries = read.devices;
};

const findSetupEntry = (id: string): DevicePowerSetupEntry | undefined => (
  entries.find((entry) => entry.id === id)
);

const companionTarget = (entry: DevicePowerSetupEntry | undefined) => (
  entry?.usedBy
);

export const devicePowerSetupHint = (deviceId: string): string | null => {
  const entry = findSetupEntry(deviceId);
  if (entry?.usedBy) {
    const targetName = entries.find((candidate) => candidate.id === entry.usedBy)?.name;
    return targetName ? `Used to measure ${formatDisplayDeviceName(targetName)}.` : 'Used as a power source.';
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
  if (entry.binarySwitchId && !entry.binarySwitches?.some(({ id }) => id === entry.binarySwitchId)) {
    return 'Selected on/off control unavailable. Check the device in Homey or change it under Setup.';
  }
  return null;
};

/** What External sensors offers a device that has no power reading yet. */
export const devicePowerSetupAlternative = (deviceId: string): string | null => {
  const entry = findSetupEntry(deviceId);
  if (!entry || entry.sourceId) return null;
  const socket = entry.sources.some(({ state }) => state === 'selectable');
  const lastResort = entry.lastResortAvailable === true;
  if (socket && lastResort) {
    return 'Or choose a metering socket under External sensors, or turn on last-resort control under Power limiting.';
  }
  if (socket) return 'Or choose a metering socket under External sensors.';
  return lastResort ? 'Or turn on last-resort control under Power limiting.' : null;
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
  if (entry?.lastResortMaximumW === undefined || entry.sourceId) return undefined;
  if (canEnableLastResort(entry, entry.binarySwitchId ?? '')) {
    return {
      hint: 'Last resort. PELS can turn it off after limiting other devices.',
      maximumW: entry.lastResortMaximumW,
    };
  }
  return { hint: 'Review last-resort control under Power limiting.' };
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
  entries.some((entry) => entry.id === deviceId && entry.lastResortMaximumW !== undefined && !entry.sourceId)
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

const setupControl = <T extends HTMLElement = HTMLElement>(root: HTMLElement, name: string): T | null => (
  root.querySelector<T>(`[data-setup="${name}"]`)
);

type Toggle = HTMLElement & { selected: boolean; disabled: boolean };
type NumberField = HTMLElement & { value: string; disabled: boolean };

/** One form's controls; a device page's form carries only its own part. */
function readSetupFields(root: HTMLElement) {
  const details = setupControl(root, 'details');
  const save = setupControl<HTMLElement & { disabled: boolean }>(root, 'save');
  if (!details || !save) return undefined;
  const target = setupControl<SetupSelect>(root, 'target');
  const targetField = setupControl(root, 'target-field');
  const source = setupControl<SetupSelect>(root, 'source');
  const help = setupControl(root, 'help');
  const control = setupControl<SetupSelect>(root, 'binary');
  const switchField = setupControl(root, 'binary-field');
  const switchHelp = setupControl(root, 'binary-help');
  const lastResort = setupControl(root, 'last-resort');
  const lastResortToggle = setupControl<Toggle>(root, 'last-resort-toggle');
  const lastResortHelp = setupControl(root, 'last-resort-help');
  const maximum = setupControl<NumberField>(root, 'maximum');
  return {
    details,
    save,
    target: target && targetField ? { select: target, field: targetField } : undefined,
    source: source && help ? { select: source, help } : undefined,
    binary: control && switchField && switchHelp
      ? { select: control, field: switchField, help: switchHelp } : undefined,
    lastResort: lastResort && lastResortToggle && lastResortHelp && maximum
      ? { section: lastResort, toggle: lastResortToggle, help: lastResortHelp, maximum } : undefined,
  };
}

type SetupFields = NonNullable<ReturnType<typeof readSetupFields>>;

function hasUsableSwitch(entry: DevicePowerSetupEntry | undefined, switchId: string): boolean {
  if (switchId) return entry?.binarySwitches?.some(({ id }) => id === switchId) ?? false;
  return entry?.defaultBinarySwitchAvailable === true;
}

function canEnableLastResort(entry: DevicePowerSetupEntry | undefined, switchId: string): boolean {
  return entry?.lastResortAvailable === true && hasUsableSwitch(entry, switchId);
}

/** Whether a device's last-resort setup applies: an unmetered relay without a socket. */
const offersLastResort = (entry: DevicePowerSetupEntry | undefined, draft: SetupDraft): boolean => (
  (entry?.lastResortAvailable === true || entry?.lastResortMaximumW !== undefined) && !draft.source
);

function syncLastResort(
  fields: NonNullable<SetupFields['lastResort']>, entry: DevicePowerSetupEntry | undefined, draft: SetupDraft,
): boolean {
  const { section, toggle, maximum, help } = fields;
  const usableSwitch = hasUsableSwitch(entry, draft.switchId);
  const canEnable = canEnableLastResort(entry, draft.switchId);
  const maximumIsValid = isLastResortMaximumW(Number(draft.maximum));
  const displayed = offersLastResort(entry, draft);
  section.hidden = !displayed;
  toggle.disabled = !canEnable && !draft.lastResort;
  (maximum.closest<HTMLElement>('.md-field-row') ?? maximum).hidden = !draft.lastResort;
  maximum.disabled = !canEnable;
  help.textContent = resolveLastResortHelp(usableSwitch, canEnable, draft, maximumIsValid);
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

function renderSourcePart(
  part: NonNullable<SetupFields['source']>, entry: DevicePowerSetupEntry | undefined, draft: SetupDraft,
  disabled: boolean,
): void {
  const { select, help } = part;
  updateOptions(select, sourceOptions(entry, draft.source), draft.source);
  select.disabled = disabled;
  help.textContent = sourceHelp(entry, draft.source);
}

function renderSwitchPart(
  part: NonNullable<SetupFields['binary']>, entry: DevicePowerSetupEntry | undefined, draft: SetupDraft,
  disabled: boolean,
): void {
  const { select, field, help } = part;
  updateOptions(select, switchOptions(entry, draft.switchId), draft.switchId);
  select.disabled = disabled;
  field.hidden = !draft.switchId && !entry?.binarySwitches?.length;
  help.textContent = draft.switchId && !hasUsableSwitch(entry, draft.switchId)
    ? 'PELS cannot use this switch right now.' : 'Choose which switch PELS uses for power limiting.';
}

/**
 * `add` lists the devices that are not in the device list yet, behind a device
 * picker, with every part; `device` edits one part of the device whose page is open.
 */
type SetupFormMode = 'add' | 'device';

const hasSwitchChoice = (entry: DevicePowerSetupEntry): boolean => (
  Boolean(entry.binarySwitches?.length || entry.binarySwitchId)
);

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
    const { target, source, binary, lastResort, save } = fields;
    if (target) target.select.onchange = () => this.select(readSelectValue(target.select));
    if (source) source.select.onchange = () => this.edit();
    if (binary) binary.select.onchange = () => this.edit();
    if (lastResort) {
      lastResort.toggle.onchange = () => this.edit();
      lastResort.maximum.oninput = () => this.edit();
    }
    save.onclick = () => this.save();
  }

  private updateSave(): void {
    const entry = findSetupEntry(this.selectedId);
    const current = this.draft ?? acceptedDraft(entry);
    const { lastResort } = this.fields;
    const invalidLastResort = lastResort ? syncLastResort(lastResort, entry, current) : false;
    const reserved = Boolean(companionTarget(entry));
    if (this.saving && lastResort) {
      lastResort.toggle.disabled = true;
      lastResort.maximum.disabled = true;
    }
    // Adding a device saves even its default choices; otherwise Save needs a change.
    const unchanged = (this.mode === 'device' || entry?.configured === true)
      && sameSetupDraft(current, acceptedDraft(entry));
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

  /** A device page's part shows only where it applies to that device. */
  private isShown(): boolean {
    if (this.mode === 'add') return this.candidates.length > 0;
    const entry = findSetupEntry(this.selectedId);
    if (!entry || companionTarget(entry)) return false;
    if (this.fields.source) return true;
    if (this.fields.binary) return hasSwitchChoice(entry);
    return offersLastResort(entry, this.draft ?? acceptedDraft(entry));
  }

  render(): void {
    this.container.hidden = !this.isShown();
    if (this.container.hidden) return;
    const entry = findSetupEntry(this.selectedId);
    const current = this.readCurrentDraft(entry);
    const disabled = this.saving || !entry || Boolean(companionTarget(entry));
    const { target, source, binary, lastResort, details } = this.fields;
    if (target) {
      updateOptions(target.select, [{ value: '', label: 'Select a device' }, ...this.candidates.map((candidate) => ({
        value: candidate.id, label: formatDisplayDeviceName(candidate.name),
      }))], entry?.id ?? '');
      target.select.disabled = this.saving;
    }
    details.hidden = !entry;
    if (source) renderSourcePart(source, entry, current, disabled);
    if (binary) renderSwitchPart(binary, entry, current, disabled);
    if (lastResort) {
      if (lastResort.toggle.selected !== current.lastResort) lastResort.toggle.selected = current.lastResort;
      if (lastResort.maximum.value !== current.maximum) lastResort.maximum.value = current.maximum;
    }
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

  /** The edited parts over the saved setup; parts this form does not show stay as saved. */
  private edit(): void {
    if (this.saving) return;
    const entry = findSetupEntry(this.selectedId);
    const { source, binary, lastResort } = this.fields;
    const draft = { ...acceptedDraft(entry), ...this.draft };
    this.awaitingReadback = false;
    this.draft = {
      source: source ? readSelectValue(source.select) : draft.source,
      switchId: binary ? readSelectValue(binary.select) : draft.switchId,
      lastResort: lastResort ? lastResort.toggle.selected : draft.lastResort,
      maximum: lastResort ? lastResort.maximum.value : draft.maximum,
    };
    if (source) source.help.textContent = sourceHelp(entry, this.draft.source);
    this.updateSave();
  }

  private async save(): Promise<void> {
    const entry = findSetupEntry(this.selectedId);
    if (!entry || this.fields.save.disabled) return;
    const current = this.draft ?? acceptedDraft(entry);
    this.saving = true;
    this.render();
    try {
      const maximum = !current.source && current.lastResort ? Number(current.maximum) : undefined;
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

function formFor(
  container: HTMLElement, mode: SetupFormMode, parts: readonly SetupPart[],
): DevicePowerSetupForm | undefined {
  const existing = setupForms.get(container);
  if (existing) return existing;
  const host = container.querySelector<HTMLElement>('[data-setup-host]') ?? container;
  if (!setupControl(host, 'save')) buildDevicePowerSetupForm(host, container.id, parts);
  const fields = readSetupFields(host);
  if (!fields) return undefined;
  const form = new DevicePowerSetupForm(container, fields, mode);
  setupForms.set(container, form);
  return form;
}

/** Each part of a device's setup, in the device-page section it belongs to. */
const DEVICE_PAGE_PARTS: readonly (readonly [string, SetupPart])[] = [
  ['device-detail-power-setup', 'source'],
  ['device-detail-binary-switch', 'switch'],
  ['device-detail-last-resort', 'lastResort'],
];

const devicePageContainers = (): HTMLElement[] => DEVICE_PAGE_PARTS.flatMap(([id]) => {
  const container = document.getElementById(id);
  return container ? [container] : [];
});

/**
 * Render the "Add a device" card for setup devices missing from the device list,
 * and refresh the open device page's forms. Returns whether the card is shown.
 */
export function renderDevicePowerSetup(
  refresh: () => Promise<void>, visible: boolean, listedIds: ReadonlySet<string>,
): boolean {
  refreshDeviceSetup = refresh;
  devicePageContainers().forEach((container) => setupForms.get(container)?.render());
  const root = document.querySelector<HTMLDetailsElement>('#device-power-setup');
  if (!root) return false;
  const form = formFor(root, 'add', ['target', 'source', 'switch', 'lastResort']);
  if (!form) return false;
  form.show(undefined, listedIds);
  if (!visible) root.hidden = true;
  return !root.hidden;
}

/** Show the setup parts for the device whose page is open, or hide them. */
export function renderDeviceDetailPowerSetup(deviceId: string | undefined): void {
  for (const [id, part] of DEVICE_PAGE_PARTS) {
    const container = document.getElementById(id);
    if (container) formFor(container, 'device', [part])?.show(deviceId);
  }
}
