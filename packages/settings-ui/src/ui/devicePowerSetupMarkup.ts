// One device setup form, rendered on a device's page and in the device list's
// "Add a device" card. Controls are found by `data-setup`; ids are prefixed per
// form so labels, hints and the dialog's buttons stay linked.

const FORM_MARKUP = `
  <div class="md-field-row" data-setup="target-field">
    <md-filled-select data-setup="target" label="Device"></md-filled-select>
  </div>
  <div class="device-setup-form__fields" data-setup="details">
  <div class="md-field-row">
    <md-filled-select data-setup="source" label="Power source" data-describedby="help"></md-filled-select>
    <small class="field__hint" data-setup="help"></small>
  </div>
  <div class="md-field-row" data-setup="binary-field" hidden>
    <md-filled-select data-setup="binary" label="On/off control" data-describedby="binary-help"></md-filled-select>
    <small class="field__hint" data-setup="binary-help"></small>
  </div>
  <div class="md-field-row" data-setup="thermostat-field" hidden>
    <md-filled-select data-setup="thermostat" label="External thermostat"
      data-describedby="thermostat-help thermostat-preview"></md-filled-select>
    <small class="field__hint" data-setup="thermostat-help">Connect the thermostat to this device directly or
      through Homey Flows. In Homey, change the target on the thermostat’s tile and check that it controls this
      device before turning on Power-limit control.</small>
    <small class="field__hint" data-setup="thermostat-preview"></small>
    <small class="field__hint" data-setup="thermostat-status" aria-live="polite"></small>
  </div>
  <md-dialog data-setup="thermostat-confirm">
    <div slot="headline">Remove last-resort control?</div>
    <form slot="content" data-setup="thermostat-confirm-form" method="dialog">
      <p class="muted">Saving this thermostat setup removes last-resort control.
        An off device stays off. Turn it on in Homey when you are ready.</p>
    </form>
    <div slot="actions">
      <md-text-button data-form="thermostat-confirm-form" value="cancel">Cancel</md-text-button>
      <md-text-button data-form="thermostat-confirm-form" value="confirm">Save</md-text-button>
    </div>
  </md-dialog>
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
  </div>
  <div class="device-setup-form__actions">
    <md-filled-tonal-button type="button" data-setup="save">Save</md-filled-tonal-button>
  </div>
  </div>`;

/** Fill `host` with a setup form whose ids start with `prefix`. */
export function buildDevicePowerSetupForm(host: HTMLElement, prefix: string): void {
  // Parsed from this module's static markup; the nodes upgrade when adopted into the page.
  host.replaceChildren(...new DOMParser().parseFromString(FORM_MARKUP, 'text/html').body.childNodes);
  host.querySelectorAll<HTMLElement>('[data-setup]').forEach((element) => {
    element.setAttribute('id', `${prefix}-${element.dataset.setup}`);
  });
  host.querySelectorAll<HTMLElement>('[data-describedby]').forEach((element) => {
    const ids = (element.dataset.describedby ?? '').split(' ').map((name) => `${prefix}-${name}`);
    element.setAttribute('aria-describedby', ids.join(' '));
  });
  host.querySelectorAll<HTMLElement>('[data-form]').forEach((element) => {
    element.setAttribute('form', `${prefix}-${element.dataset.form}`);
  });
}
