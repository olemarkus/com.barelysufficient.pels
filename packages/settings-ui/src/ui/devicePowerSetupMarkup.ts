import { HOMEY_ENERGY_SETUP_DOCS_URL } from '../../../shared-domain/src/homeyEnergySetup.ts';

// Device setup forms. A device's page shows each part in the section it
// belongs to (power source in External sensors, the on/off switch in Setup,
// last resort in Power limiting); guided setup combines the parts for the
// chosen device. Controls are found by `data-setup`; ids
// are prefixed per form so labels and hints stay linked.

export type SetupPart = 'source' | 'switch' | 'powerChoices' | 'lastResort';

const PART_MARKUP: Record<SetupPart, string> = {
  source: `
  <div class="md-field-row" data-setup="source-field">
    <md-filled-select data-setup="source" label="Power source" data-describedby="help"></md-filled-select>
    <small class="field__hint" data-setup="help"></small>
    <small class="field__hint" data-setup="source-change" aria-live="polite" hidden></small>
    <div data-setup="managed-sockets"></div>
  </div>`,
  switch: `
  <div class="md-field-row" data-setup="binary-field" hidden>
    <md-filled-select data-setup="binary" label="On/off control" data-describedby="binary-help"></md-filled-select>
    <small class="field__hint" data-setup="binary-help"></small>
  </div>`,
  powerChoices: `
  <p class="field__label pels-text-settings-label" data-setup="power-choices" hidden>
    Choose how to set up power limiting
  </p>
  <div class="md-field-row" data-setup="homey-energy" hidden>
    <span class="field__label pels-text-settings-label">Homey Energy</span>
    <small class="field__hint">Use “Energy used when on” only if the draw stays steady
      while the Homey switch is on.</small>
    <small class="field__hint">
      <a href="${HOMEY_ENERGY_SETUP_DOCS_URL}" target="_blank" rel="noopener noreferrer">
        Homey Energy setup guide
      </a>
    </small>
    <small class="field__hint">After saving in Homey, close setup and refresh devices.</small>
  </div>`,
  lastResort: `
  <div data-setup="last-resort" hidden>
    <label class="md-switch-row">
      <md-switch data-setup="last-resort-toggle" aria-label="Turn off as a last resort"
        data-describedby="last-resort-help"></md-switch>
      <span class="md-switch-row__content">
        <span class="md-switch-row__label pels-text-settings-label">Turn off as a last resort</span>
        <small class="field__hint" data-setup="last-resort-help" aria-live="polite"></small>
      </span>
    </label>
    <div class="md-field-row">
      <md-filled-text-field data-setup="maximum" type="number" min="1" step="1" inputmode="numeric"
        label="Maximum power draw" suffix-text="W" data-describedby="maximum-help"></md-filled-text-field>
      <small class="field__hint" data-setup="maximum-help" aria-live="polite"></small>
    </div>
  </div>`,
};

const SAVE_MARKUP = `
  <div class="device-setup-form__actions">
    <md-filled-tonal-button type="button" data-setup="save">Save</md-filled-tonal-button>
  </div>`;

const HISTORY_IMPORT_MARKUP = `
  <div class="md-field-row" data-setup="history" hidden>
    <div class="device-setup-form__actions">
      <md-outlined-button type="button" data-setup="history-import">
        Import from meter history
      </md-outlined-button>
    </div>
    <small class="field__hint" data-setup="history-status" role="status"></small>
  </div>
  <md-dialog data-setup="history-confirmation">
    <div slot="headline">Import from meter history?</div>
    <p slot="content" class="pels-text-body">
      Only import if this meter measured this device throughout the previous hour.
    </p>
    <div slot="actions">
      <md-text-button type="button" data-setup="history-cancel">Cancel</md-text-button>
      <md-filled-button type="button" data-setup="history-confirm">Import</md-filled-button>
    </div>
  </md-dialog>`;

/** Fill `host` with a setup form for `parts`, its ids starting with `prefix`. */
export function buildDevicePowerSetupForm(
  host: HTMLElement, prefix: string, parts: readonly SetupPart[], withSave: boolean,
): void {
  const details = parts.map((part) => PART_MARKUP[part]).join('');
  const markup = `<div class="device-setup-form__fields" data-setup="details">${details}`
    + `${withSave ? SAVE_MARKUP : ''}`
    + `${withSave && parts.includes('source') ? HISTORY_IMPORT_MARKUP : ''}</div>`;
  // Parsed from this module's static markup; the nodes upgrade when adopted into the page.
  host.replaceChildren(...new DOMParser().parseFromString(markup, 'text/html').body.childNodes);
  host.querySelectorAll<HTMLElement>('[data-setup]').forEach((element) => {
    element.setAttribute('id', `${prefix}-${element.dataset.setup}`);
  });
  host.querySelectorAll<HTMLElement>('[data-describedby]').forEach((element) => {
    const ids = (element.dataset.describedby ?? '').split(' ').map((name) => `${prefix}-${name}`);
    element.setAttribute('aria-describedby', ids.join(' '));
  });
}

export type SetupSelect = HTMLElement & {
  value: string;
  disabled: boolean;
};

export const setupControl = <T extends HTMLElement = HTMLElement>(root: HTMLElement, name: string): T | null => (
  root.querySelector<T>(`[data-setup="${name}"]`)
);

type Toggle = HTMLElement & { selected: boolean; disabled: boolean };
type NumberField = HTMLElement & { value: string; disabled: boolean };

function readPowerChoiceFields(root: HTMLElement) {
  const heading = setupControl(root, 'power-choices');
  const homeyEnergy = setupControl(root, 'homey-energy');
  return heading && homeyEnergy ? { heading, homeyEnergy } : undefined;
}

function readSourceFields(root: HTMLElement) {
  const select = setupControl<SetupSelect>(root, 'source');
  const field = setupControl(root, 'source-field');
  const managedSockets = setupControl(root, 'managed-sockets');
  const help = setupControl(root, 'help');
  const sourceChange = setupControl(root, 'source-change');
  return select && field && managedSockets && help && sourceChange
    ? { select, field, managedSockets, help, sourceChange } : undefined;
}

/** One form's controls; a device page's form carries only its own part. */
export function readSetupFields(root: HTMLElement) {
  const details = setupControl(root, 'details');
  const save = setupControl<HTMLElement & { disabled: boolean }>(root, 'save');
  if (!details || !save) return undefined;
  const control = setupControl<SetupSelect>(root, 'binary');
  const switchField = setupControl(root, 'binary-field');
  const switchHelp = setupControl(root, 'binary-help');
  const lastResort = setupControl(root, 'last-resort');
  const lastResortToggle = setupControl<Toggle>(root, 'last-resort-toggle');
  const lastResortHelp = setupControl(root, 'last-resort-help');
  const maximum = setupControl<NumberField>(root, 'maximum');
  const maximumHelp = setupControl(root, 'maximum-help');
  return {
    details,
    save,
    powerChoices: readPowerChoiceFields(root),
    source: readSourceFields(root),
    binary: control && switchField && switchHelp
      ? { select: control, field: switchField, help: switchHelp } : undefined,
    lastResort: lastResort && lastResortToggle && lastResortHelp && maximum && maximumHelp
      ? { section: lastResort, toggle: lastResortToggle, help: lastResortHelp, maximum, maximumHelp }
      : undefined,
  };
}

export type SetupFields = NonNullable<ReturnType<typeof readSetupFields>>;

export function renderSourceChangeNotice(element: HTMLElement, message: string): void {
  const notice = element;
  notice.hidden = !message;
  notice.textContent = message;
}
