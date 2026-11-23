// Device setup forms. A device's page shows each part in the section it
// belongs to (power source in External sensors, the on/off switch in Setup,
// last resort in Power limiting); the device list's "Add a device" card shows
// every part behind a device picker. Controls are found by `data-setup`; ids
// are prefixed per form so labels and hints stay linked.

export type SetupPart = 'target' | 'source' | 'switch' | 'lastResort';

const PART_MARKUP: Record<SetupPart, string> = {
  target: `
  <div class="md-field-row" data-setup="target-field">
    <md-filled-select data-setup="target" label="Device"></md-filled-select>
  </div>`,
  source: `
  <div class="md-field-row">
    <md-filled-select data-setup="source" label="Power source" data-describedby="help"></md-filled-select>
    <small class="field__hint" data-setup="help"></small>
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
export function buildDevicePowerSetupForm(host: HTMLElement, prefix: string, parts: readonly SetupPart[]): void {
  const target = parts.includes('target') ? PART_MARKUP.target : '';
  const details = parts.filter((part) => part !== 'target').map((part) => PART_MARKUP[part]).join('');
  const markup = `${target}<div class="device-setup-form__fields" data-setup="details">${details}${SAVE_MARKUP}</div>`;
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
