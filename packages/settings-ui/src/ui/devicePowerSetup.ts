import type { DevicePowerSetupEntry, DevicePowerSetupRead } from '../../../contracts/src/settingsUi/devices.ts';
import type { MdDialog } from '@material/web/dialog/dialog.js';
import { describeSetupReadbackError, readGuidedControls, renderGuidedReview, renderManagedSockets, type GuidedControls }
  from './guidedDeviceSetupPresentation.ts';
import {
  canReviewWiring, CHOOSE_SWITCH, hasSwitchChoice, hasUsableSwitch,
  sourceChangeWarning, sourceHelp, sourceOptions, switchOptions, type SetupOption,
} from './devicePowerSetupChoices.ts';
import { mountDevicePowerHistoryImport } from './devicePowerHistoryImport.ts';
import { trackSetupSave } from './setupJourneyState.ts';
import { HOMEY_ENERGY_SETUP_HINT } from '../../../shared-domain/src/homeyEnergySetup.ts';
import { isLastResortMaximumW } from '../../../shared-domain/src/settings/lastResortDevices.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { createSelectOption } from './materialSelectOption.ts';
import type { MaterialSelectOptionElement } from './components.ts';
import { persistDeviceSetup, type SetupDraft } from './devicePowerSetupWrites.ts';
import {
  buildDevicePowerSetupForm, readSetupFields, renderSourceChangeNotice, setupControl,
  type SetupFields, type SetupPart, type SetupSelect,
} from './devicePowerSetupMarkup.ts';

let entries: readonly DevicePowerSetupEntry[] = [];

export const acceptDevicePowerSetup = (read: DevicePowerSetupRead | undefined): void => {
  if (read) entries = read.devices;
};

const findSetupEntry = (id: string): DevicePowerSetupEntry | undefined => (
  entries.find((entry) => entry.id === id)
);

export const readDeviceSetupEntries = (): readonly DevicePowerSetupEntry[] => entries;

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

/** Help choose a setup for a device without a power reading. */
export const devicePowerSetupGuidance = (deviceId: string): string | null => {
  const entry = findSetupEntry(deviceId);
  if (!entry || entry.sourceId) return null;
  const socket = entry.sources.some(({ state }) => state === 'selectable');
  const meter = 'Choose a metering socket under External sensors if you have one.';
  if (offersLastResortWithoutMeter(deviceId)) {
    const lastResort = 'If its draw varies while it’s on and you can’t meter it, choose Turn off as a last resort '
      + 'under Power limiting and enter its maximum draw. PELS can then cut it after other limiting '
      + 'or during a household meter outage.';
    const steadyDraw = 'If its draw stays steady whenever it’s on, use “Energy used when on” in Homey.';
    return [socket ? meter : '', lastResort, steadyDraw].filter(Boolean).join(' ');
  }
  return socket ? `${HOMEY_ENERGY_SETUP_HINT} ${meter}` : null;
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

export const offersLastResortWithoutMeter = (deviceId: string): boolean => {
  const entry = findSetupEntry(deviceId);
  return entry?.lastResortAvailable === true && !entry.sourceId && !entry.usedBy;
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

const renderedOptions = new WeakMap<SetupSelect, string>();

// A Material select shows no text for an option whose value is empty, so the
// default choices ("This device", "Default") carry a placeholder value instead.
const DEFAULT_OPTION_VALUE = 'pels-default';
const WAIT_FOR_READING = 'Meter saved. Make sure it’s on in Homey. Wait for its first power reading, then check again.';
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
  const { section, toggle, maximum, help, maximumHelp } = fields;
  const usableSwitch = hasUsableSwitch(entry, draft.switchId);
  const canEnable = canEnableLastResort(entry, draft.switchId);
  const maximumIsValid = isLastResortMaximumW(Number(draft.maximum));
  const displayed = offersLastResort(entry, draft);
  section.hidden = !displayed;
  toggle.disabled = !canEnable && !draft.lastResort;
  (maximum.closest<HTMLElement>('.md-field-row') ?? maximum).hidden = !draft.lastResort;
  maximum.disabled = !canEnable;
  help.textContent = resolveLastResortHelp(usableSwitch, canEnable);
  maximumHelp.textContent = draft.maximum !== '' && !maximumIsValid
    ? 'Enter the maximum power in whole watts.'
    : 'Enter the highest total draw of everything this switch powers. '
      + 'PELS makes room for that amount before turning it back on.';
  return displayed && draft.lastResort && (!canEnable || !maximumIsValid);
}

function resolveLastResortHelp(usableSwitch: boolean, canEnable: boolean): string {
  if (!usableSwitch) return 'Choose an available on/off control to use last-resort control.';
  if (!canEnable) return 'Last-resort control is unavailable. If the device now has a power reading, turn this off '
    + 'to use ordinary power limiting.';
  return 'For a varying draw you can’t meter. PELS can turn it off if other limiting isn’t enough or the '
    + 'household meter stops reporting. PELS only resumes a device it turned off.';
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

function renderSwitchPart(
  part: NonNullable<SetupFields['binary']>, entry: DevicePowerSetupEntry | undefined, draft: SetupDraft,
  disabled: boolean, guided: boolean,
): void {
  const { select, field, help } = part;
  updateOptions(select, switchOptions(entry, draft.switchId, guided), draft.switchId);
  select.disabled = disabled;
  field.hidden = !entry || !hasSwitchChoice(entry);
  const switching = draft.switchId && draft.switchId !== CHOOSE_SWITCH;
  const prompt = guided ? 'Choose what PELS can switch off when power needs to be reduced.'
    : 'Choose which switch PELS uses for power limiting.';
  help.textContent = switching && !hasUsableSwitch(entry, draft.switchId)
    ? 'PELS cannot use this switch right now.' : prompt;
}

export type GuidedDeviceSetupActions = {
  refresh: () => Promise<boolean>;
  manage: (id: string, enabled: boolean) => Promise<boolean>;
  managedDisabledReason: (id: string) => string | null;
  offersHomeyEnergy: (id: string) => boolean;
  simulation: () => boolean;
};

class DevicePowerSetupForm {
  private selectedId = '';
  private draft: SetupDraft | undefined;
  private awaitingReadback = false;
  private confirmedSetup: { homeId: DevicePowerSetupEntry['homeId']; draft: SetupDraft } | undefined;
  private saving = false;
  private reviewing = false;
  private status = '';
  private readonly historyImport;

  constructor(
    private readonly container: HTMLElement,
    private readonly fields: SetupFields,
    private readonly guided?: GuidedControls,
  ) {
    const { source, binary, lastResort, save } = fields;
    this.historyImport = mountDevicePowerHistoryImport(container, () => refreshDeviceSetup());
    if (source) source.select.onchange = () => this.edit();
    if (binary) binary.select.onchange = () => this.edit();
    if (lastResort) {
      lastResort.toggle.onchange = () => this.edit();
      lastResort.maximum.oninput = () => this.edit();
    }
    save.onclick = () => {
      if (this.guided && !this.reviewing) {
        this.reviewing = true;
        this.status = '';
        this.render();
      } else {
        const operation = () => this.submit();
        if (this.guided) void trackSetupSave(`wiring:${this.selectedId}`, operation);
        else void operation();
      }
    };
    if (guided) {
      const { dismiss, dialog } = guided;
      dismiss.onclick = () => {
        if (this.reviewing) {
          this.reviewing = false;
          this.status = '';
          this.render();
        } else {
          void dialog.close();
        }
      };
      dialog.addEventListener('cancel', (event) => {
        if (this.saving) event.preventDefault();
      });
    }
  }

  open(id: string): void {
    const entry = findSetupEntry(id);
    if (!this.guided || !entry || this.saving) return;
    this.selectedId = id;
    this.confirmedSetup = undefined;
    this.clearDraft();
    this.status = '';
    this.reviewing = false;
    if (hasSwitchChoice(entry) && (!entry.configured || !hasUsableSwitch(entry, entry.binarySwitchId ?? ''))) {
      this.draft = { ...acceptedDraft(entry), switchId: CHOOSE_SWITCH };
    }
    this.render();
    void this.guided.dialog.show();
  }

  private updateSave(): void {
    const entry = findSetupEntry(this.selectedId);
    const current = this.draft ?? acceptedDraft(entry);
    const { lastResort } = this.fields;
    const invalidLastResort = lastResort ? syncLastResort(lastResort, entry, current) : false;
    if (this.saving && lastResort) {
      lastResort.toggle.disabled = true;
      lastResort.maximum.disabled = true;
    }
    this.fields.save.disabled = this.saving || !entry || (!this.confirmedReviewedSetup(current)
      && (invalidLastResort || !this.canSaveWiring(entry, current)));
  }

  private canSaveWiring(entry: DevicePowerSetupEntry, draft: SetupDraft): boolean {
    const wiringReady = this.guided ? canReviewWiring(entry, draft) : !sameSetupDraft(draft, acceptedDraft(entry));
    return !companionTarget(entry) && wiringReady && !hasUnavailableEdit(entry, draft);
  }

  private readCurrentDraft(entry: DevicePowerSetupEntry | undefined): SetupDraft {
    const accepted = acceptedDraft(entry);
    if (!this.confirmedSetup && this.awaitingReadback && this.draft && entry?.configured
      && sameSetupDraft(this.draft, accepted)) {
      this.clearDraft();
    }
    return this.draft ?? accepted;
  }

  show(deviceId: string | undefined): void {
    if (deviceId !== this.selectedId && !this.saving) {
      this.clearDraft();
      this.selectedId = deviceId ?? '';
    }
    this.render();
  }

  /** A device page's part shows only where it applies to that device. */
  private isShown(): boolean {
    const entry = findSetupEntry(this.selectedId);
    if (!entry || companionTarget(entry)) return false;
    if (this.fields.source) return true;
    if (this.fields.binary) return hasSwitchChoice(entry);
    return offersLastResort(entry, this.draft ?? acceptedDraft(entry));
  }

  render(): void {
    if (!this.guided) {
      this.container.hidden = !this.isShown();
      if (this.container.hidden) {
        this.historyImport?.hide();
        return;
      }
    }
    const entry = findSetupEntry(this.selectedId);
    const current = this.readCurrentDraft(entry);
    const disabled = this.saving || !entry || Boolean(companionTarget(entry));
    const { source, binary, lastResort, details } = this.fields;
    details.hidden = !entry || this.reviewing;
    if (source) this.renderSource(source, entry, current, disabled);
    if (binary) renderSwitchPart(binary, entry, current, disabled, Boolean(this.guided));
    if (lastResort) {
      if (lastResort.toggle.selected !== current.lastResort) lastResort.toggle.selected = current.lastResort;
      if (lastResort.maximum.value !== current.maximum) lastResort.maximum.value = current.maximum;
    }
    if (this.guided) {
      this.renderPowerChoices(entry, current);
      const simulation = guidedActions?.simulation() === true;
      renderGuidedReview(this.guided, entry, current, this.reviewing, simulation, this.status);
      this.guided.dismiss.disabled = this.saving;
      this.fields.save.textContent = this.primaryActionLabel();
    }
    this.updateSave();
  }

  private renderSource(
    part: NonNullable<SetupFields['source']>, entry: DevicePowerSetupEntry | undefined, draft: SetupDraft,
    disabled: boolean,
  ): void {
    const { field, select, help, sourceChange } = part;
    updateOptions(select, sourceOptions(entry, draft.source), draft.source);
    select.disabled = disabled;
    help.textContent = sourceHelp(entry, draft.source);
    renderSourceChangeNotice(sourceChange, sourceChangeWarning(entry, draft.source, Boolean(this.guided)));
    this.historyImport?.show(entry, draft.source, disabled || this.awaitingReadback);
    if (!this.guided) return;
    field.hidden = entry?.ownPowerW !== undefined && !draft.source;
    select.hidden = !draft.source && entry?.sources.length === 0;
    renderManagedSockets(part.managedSockets, entry, this.saving, (id) => { void this.releaseSocket(id); });
  }

  private renderPowerChoices(entry: DevicePowerSetupEntry | undefined, draft: SetupDraft): void {
    const choices = this.fields.powerChoices;
    if (!choices) return;
    const showHomeyEnergy = !draft.source && !draft.lastResort
      && guidedActions?.offersHomeyEnergy(this.selectedId) === true;
    choices.homeyEnergy.hidden = !showHomeyEnergy;
    choices.heading.hidden = !showHomeyEnergy && !offersLastResort(entry, draft);
  }

  private primaryActionLabel(): string {
    if (!this.reviewing) return 'Review setup';
    return this.status === WAIT_FOR_READING ? 'Check meter' : 'Add to PELS';
  }

  private async releaseSocket(id: string): Promise<void> {
    const entry = findSetupEntry(this.selectedId);
    if (this.saving || !entry || !guidedActions || !entry.sources.some(
      (source) => source.id === id && source.state === 'managed',
    )) return;
    this.saving = true;
    this.status = '';
    this.render();
    try {
      if (await guidedActions.manage(id, false) && await guidedActions.refresh()
        && findSetupEntry(entry.id)?.sources.some((source) => source.id === id && source.state === 'selectable')) {
        this.confirmedSetup = undefined;
        this.draft = { ...(this.draft ?? acceptedDraft(entry)), source: id };
      } else {
        this.status = 'Could not confirm the socket is ready to use as a meter. Try again or choose another socket.';
      }
    } finally {
      this.saving = false;
      this.render();
    }
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
    this.confirmedSetup = undefined;
    this.draft = {
      source: source ? readSelectValue(source.select) : draft.source,
      switchId: binary ? readSelectValue(binary.select) : draft.switchId,
      lastResort: lastResort ? lastResort.toggle.selected : draft.lastResort,
      maximum: lastResort ? lastResort.maximum.value : draft.maximum,
    };
    this.status = '';
    this.render();
  }

  private confirmedReviewedSetup(draft: SetupDraft) {
    const confirmed = this.confirmedSetup;
    return this.reviewing && confirmed && sameSetupDraft(draft, confirmed.draft) ? confirmed : undefined;
  }

  private async submit(): Promise<void> {
    const entry = findSetupEntry(this.selectedId);
    if (!entry || this.fields.save.disabled) return;
    const current = this.draft ?? acceptedDraft(entry);
    const confirmed = this.confirmedReviewedSetup(current);
    this.saving = true;
    this.render();
    try {
      if (confirmed) await this.finishGuided(confirmed.homeId, confirmed.draft, true);
      else await this.save(entry, current);
    } finally {
      this.saving = false;
      this.render();
    }
  }

  private async save(entry: DevicePowerSetupEntry, current: SetupDraft): Promise<void> {
    const maximum = !current.source && current.lastResort ? Number(current.maximum) : undefined;
    const submitted = { ...current, lastResort: maximum !== undefined, maximum: maximum?.toString() ?? '' };
    const saved = await persistDeviceSetup(entries, entry, submitted);
    if (saved) {
      this.draft = submitted;
      this.awaitingReadback = true;
    }
    if (this.guided) await this.finishGuided(entry.homeId, submitted, saved);
    else await refreshDeviceSetup();
  }

  private async finishGuided(
    homeId: DevicePowerSetupEntry['homeId'], submitted: SetupDraft, saved: boolean,
  ): Promise<void> {
    if (!guidedActions || !this.guided) return;
    const deviceId = this.selectedId;
    const refreshed = await guidedActions.refresh();
    const accepted = findSetupEntry(deviceId);
    const readback = refreshed && accepted?.homeId === homeId ? accepted : undefined;
    if (!saved || !readback?.configured || !sameSetupDraft(submitted, acceptedDraft(readback))) {
      if (readback) this.confirmedSetup = undefined;
      this.status = describeSetupReadbackError(submitted, readback && acceptedDraft(readback));
      return;
    }
    this.confirmedSetup = { homeId, draft: submitted };
    this.draft = submitted;
    this.awaitingReadback = false;
    if (readback.sourceId && !readback.sourceReady) {
      this.status = WAIT_FOR_READING;
      return;
    }
    if (!await guidedActions.manage(deviceId, true)) {
      this.status = describeManagementRefusal(deviceId, guidedActions);
      return;
    }
    await this.guided.dialog.close();
  }
}

const describeManagementRefusal = (id: string, actions: GuidedDeviceSetupActions): string => (
  devicePowerSetupHint(id) ?? actions.managedDisabledReason(id)
  ?? 'Could not confirm that PELS is managing this device. Try again.'
);

let refreshDeviceSetup: () => Promise<void> = async () => {};
let guidedActions: GuidedDeviceSetupActions | undefined;
const setupForms = new WeakMap<HTMLElement, DevicePowerSetupForm>();

function formFor(
  container: HTMLElement, parts: readonly SetupPart[], guided?: GuidedControls,
): DevicePowerSetupForm | undefined {
  const existing = setupForms.get(container);
  if (existing) return existing;
  const host = container.querySelector<HTMLElement>('[data-setup-host]') ?? container;
  if (!setupControl(host, 'details')) buildDevicePowerSetupForm(host, container.id, parts, !guided);
  const fields = readSetupFields(container);
  if (!fields) return undefined;
  if (guided) fields.save.id = `${container.id}-save`;
  const form = new DevicePowerSetupForm(container, fields, guided);
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

export function renderDevicePowerSetup(actions: GuidedDeviceSetupActions): void {
  guidedActions = actions;
  refreshDeviceSetup = async () => { await actions.refresh(); };
  devicePageContainers().forEach((container) => setupForms.get(container)?.render());
  const dialog = document.querySelector<MdDialog>('#device-power-setup');
  if (dialog?.open) setupForms.get(dialog)?.render();
}

export function openGuidedDeviceSetup(id: string): void {
  const dialog = document.querySelector<MdDialog>('#device-power-setup');
  const guided = dialog && readGuidedControls(dialog);
  if (guided) formFor(guided.dialog, ['source', 'switch', 'powerChoices', 'lastResort'], guided)?.open(id);
}

/** Show the setup parts for the device whose page is open, or hide them. */
export function renderDeviceDetailPowerSetup(deviceId: string | undefined): void {
  for (const [id, part] of DEVICE_PAGE_PARTS) {
    const container = document.getElementById(id);
    if (container) formFor(container, [part])?.show(deviceId);
  }
}
