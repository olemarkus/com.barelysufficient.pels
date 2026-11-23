// Device setup forms. A device's page shows each part in the section it
// belongs to (power source in External sensors, the on/off switch in Setup,
// last resort in Power limiting); guided setup combines the parts for the
// chosen device. Controls are found by `data-setup`; ids
// are prefixed per form so labels and hints stay linked.

export type SetupPart = 'source' | 'switch' | 'lastResort';

const PART_MARKUP: Record<SetupPart, string> = {
  source: `
  <div class="md-field-row" data-setup="source-field">
    <md-filled-select data-setup="source" label="Power source" data-describedby="help"></md-filled-select>
    <small class="field__hint" data-setup="help"></small>
    <div data-setup="managed-sockets"></div>
  </div>`,
  switch: `
  <div class="md-field-row" data-setup="binary-field" hidden>
    <md-filled-select data-setup="binary" label="On/off control" data-describedby="binary-help"></md-filled-select>
    <small class="field__hint" data-setup="binary-help"></small>
  </div>`,
  lastResort: `
  <div data-setup="last-resort" hidden>
    <label class="md-switch-row">
      <md-switch data-setup="last-resort-toggle" aria-label="Turn off as a last resort"></md-switch>
      <span class="md-switch-row__content">
        <span class="md-switch-row__label pels-text-settings-label">Turn off as a last resort</span>
        <small class="field__hint" data-setup="last-resort-help" aria-live="polite"></small>
      </span>
    </label>
    <div class="md-field-row">
      <md-filled-text-field data-setup="maximum" type="number" min="1" step="1" inputmode="numeric"
        label="Maximum power" suffix-text="W" data-describedby="last-resort-help"></md-filled-text-field>
    </div>
  </div>`,
};

const SAVE_MARKUP = `
  <div class="device-setup-form__actions">
    <md-filled-tonal-button type="button" data-setup="save">Save</md-filled-tonal-button>
  </div>`;

/** Fill `host` with a setup form for `parts`, its ids starting with `prefix`. */
export function buildDevicePowerSetupForm(
  host: HTMLElement, prefix: string, parts: readonly SetupPart[], withSave: boolean,
): void {
  const details = parts.map((part) => PART_MARKUP[part]).join('');
  const markup = `<div class="device-setup-form__fields" data-setup="details">${details}`
    + `${withSave ? SAVE_MARKUP : ''}</div>`;
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

/** One form's controls; a device page's form carries only its own part. */
export function readSetupFields(root: HTMLElement) {
  const details = setupControl(root, 'details');
  const save = setupControl<HTMLElement & { disabled: boolean }>(root, 'save');
  if (!details || !save) return undefined;
  const source = setupControl<SetupSelect>(root, 'source');
  const sourceField = setupControl(root, 'source-field');
  const managedSockets = setupControl(root, 'managed-sockets');
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
    source: source && sourceField && managedSockets && help
      ? { select: source, field: sourceField, managedSockets, help } : undefined,
    binary: control && switchField && switchHelp
      ? { select: control, field: switchField, help: switchHelp } : undefined,
    lastResort: lastResort && lastResortToggle && lastResortHelp && maximum
      ? { section: lastResort, toggle: lastResortToggle, help: lastResortHelp, maximum } : undefined,
  };
}

export type SetupFields = NonNullable<ReturnType<typeof readSetupFields>>;
