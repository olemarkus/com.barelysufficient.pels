import { useState } from 'preact/hooks';
import type { ChargingAccessStatus, ChargingCurrentRead, ChargingCurrentSetup } from '../../../../contracts/src/chargingControl.ts';
import { MdFilledButton, MdOutlinedButton, MdFilledTextField, MdSwitch, readSwitchSelected } from './materialWebJSX.tsx';

export type ChargingCurrentSetupProps = {
  device: ChargingCurrentRead;
  access: ChargingAccessStatus;
  busy: boolean;
  error: string;
  onSaveKey: (key: string) => Promise<boolean>;
  onEnableWithKey: (key: string, setup: ChargingCurrentSetup) => Promise<boolean>;
  onCheck: () => Promise<boolean>;
  onRemove: () => Promise<boolean>;
  onSaveMethod: (setup: ChargingCurrentSetup) => Promise<boolean>;
};

export function ChargingCurrentLoadView(props: { busy: boolean; onRetry: () => Promise<void> }) {
  return <section class="charging-current-setup">
    <h3 class="pels-text-settings-label">Charging current</h3>
    {props.busy
      ? <p class="field__hint" role="status">Loading charging setup…</p>
      : <p class="field__hint" role="alert">Charging setup could not be loaded. Try again.</p>}
    <MdOutlinedButton disabled={props.busy} onClick={props.onRetry}>Try again</MdOutlinedButton>
  </section>;
}

const GUIDE = 'https://support.homey.app/hc/en-us/articles/8178797067292-Create-and-use-API-Keys-on-Homey-Pro';
const ACCESS_COPY: Record<ChargingAccessStatus['state'], string> = {
  not_configured: 'A Homey API key is needed for built-in control.',
  not_checked: 'Check the saved key to enable charging-current control.',
  ready: 'API key verified.',
  permission_denied: 'The key needs Flow permission. Replace it with a key that has this permission.',
  unavailable: 'Homey charging access is unavailable. Check the key and try again.',
};

export function ChargingCurrentSetupView(props: ChargingCurrentSetupProps) {
  const { device, access, busy } = props;
  const [key, setKey] = useState('');
  const [singleCharger, setSingleCharger] = useState(device.setup.confirmation === 'single_charger');
  const [vehicleControl, setVehicleControl] = useState(device.setup.confirmation === 'vehicle');
  const confirmation = device.scope === 'vehicle' ? vehicleControl : singleCharger;
  const confirmedScope = device.scope === 'vehicle' ? 'vehicle' : 'single_charger';
  const chosenConfirmation = confirmation ? confirmedScope : 'none';
  const scopeAllowed = device.flowCheck === 'clear' && !device.sharedInstallation && confirmation;
  const canEnable = scopeAllowed && (device.capabilityWritable || access.state === 'ready');
  const builtIn = device.setup.method === 'built_in';
  const needsKey = !device.capabilityWritable && access.state !== 'ready';
  const enableWithKey = !builtIn && needsKey;
  const KeyContainer = access.state === 'ready' ? 'details' : 'div';
  return <section class="charging-current-setup">
    <h3 class="pels-text-settings-label">Charging current</h3>
    {props.error && <p class="field__hint" role="alert">{props.error}</p>}
    <p class="field__hint">{device.sharedInstallation
      ? 'Use a Flow to adjust current for this shared installation.'
      : 'Let PELS adjust charging current directly. No Flow needed.'}</p>
    <div role="status">
      <p><strong>{builtIn ? 'Built-in current control is selected.'
        : device.flowCheck === 'conflict' ? 'Flow control is selected.' : 'Built-in current control is not enabled.'}</strong></p>
      {!builtIn && <p class="field__hint">{device.flowCheck === 'conflict'
        ? 'Your current-setting Flow remains in use until you switch.'
        : 'Enable it below, or set up a Flow to send current changes to the car or charger.'}</p>}
    </div>
    {device.flowCheck === 'conflict' && <p class="field__hint" role="status">
      Remove the current-setting action from your Flow before using built-in control. Then select “Check again”.
      {device.flowNames.filter(Boolean).length > 0 && ` Flows: ${device.flowNames.filter(Boolean).join(', ')}.`}
    </p>}
    {device.flowCheck === 'unavailable' && <p class="field__hint">PELS could not check your Flows. Check again before changing control methods.</p>}
    {device.scope === 'vehicle' && <div>
      <label class="md-switch-row">
        <span class="md-switch-row__content"><span class="md-switch-row__label">Control charging through this car</span></span>
        <MdSwitch aria-label="Control charging through this car" selected={vehicleControl} disabled={busy}
          onChange={(event: Event) => setVehicleControl(readSwitchSelected(event))} />
      </label>
      <p class="field__hint">Manage either the car or its physical charger in PELS. Turn off Power-limit control for the other device.</p>
      {vehicleControl !== (device.setup.confirmation === 'vehicle') && (builtIn || !vehicleControl)
        && <MdOutlinedButton disabled={busy}
          onClick={() => props.onSaveMethod({ ...device.setup, confirmation: vehicleControl ? 'vehicle' : 'none' })}>Save car control</MdOutlinedButton>}
    </div>}
    {device.sharedInstallation && <p class="field__hint">This installation has more than one charger. Use a Flow for current control.</p>}
    {device.scope === 'installation' && !device.sharedInstallation && <label class="md-switch-row">
      <span class="md-switch-row__content"><span class="md-switch-row__label">This installation has only one charger</span></span>
      <MdSwitch aria-label="This installation has only one charger" selected={singleCharger} disabled={busy}
        onChange={(event: Event) => setSingleCharger(readSwitchSelected(event))} />
    </label>}
    {((!device.capabilityWritable && !device.sharedInstallation) || access.configured) && <KeyContainer>
      {access.state === 'ready' && <summary>Manage API key</summary>}
      <p class="field__hint">{ACCESS_COPY[access.state]}</p>
      <p class="field__hint">In the Homey Web App → Settings → API Keys, create a key with Flow permission. One key works for all supported cars and chargers. <a href={GUIDE} target="_blank" rel="noopener noreferrer">Create an API key</a></p>
      <MdFilledTextField label={access.configured ? 'Replacement API key' : 'API key'} type="password"
        autocomplete="off" value={key} disabled={busy}
        onInput={(event: Event) => setKey((event.currentTarget as HTMLInputElement).value)} />
      <div class="form__actions">
        <MdFilledButton disabled={busy || !key.trim() || (enableWithKey && !scopeAllowed)} onClick={async () => {
          const saved = enableWithKey
            ? await props.onEnableWithKey(key, { method: 'built_in', confirmation: chosenConfirmation })
            : await props.onSaveKey(key);
          if (saved) setKey('');
        }}>{enableWithKey ? 'Save key and enable' : access.configured ? 'Replace key' : 'Save key'}</MdFilledButton>
        {access.configured && <MdOutlinedButton disabled={busy} onClick={props.onRemove}>Remove key</MdOutlinedButton>}
      </div>
    </KeyContainer>}
    {!builtIn && !device.sharedInstallation && access.state === 'ready' && <p class="field__hint" role="status">
      Your key is ready. Select “Use built-in control” to finish setup for this device.
    </p>}
    {device.setup.method === 'flow' && device.scope === 'vehicle' && !vehicleControl && <p class="field__hint">
      Turn on “Control charging through this car” to choose built-in control.
    </p>}
    <div class="form__actions">
      {!builtIn && !needsKey && <MdFilledButton disabled={busy || !canEnable} onClick={() => props.onSaveMethod({ method: 'built_in', confirmation: chosenConfirmation })}>Use built-in control</MdFilledButton>}
      <MdOutlinedButton disabled={busy} onClick={props.onCheck}>Check again</MdOutlinedButton>
    </div>
    <details>
      <summary>Set up a Flow instead</summary>
      <p class="field__hint">Use PELS “Stepped device target changed” for this device. Connect it to the charger’s charging-current action using the EV charger current (A) tag. PELS controls start and stop separately.</p>
      <MdOutlinedButton disabled={busy} onClick={() => props.onSaveMethod({ method: 'flow', confirmation: chosenConfirmation })}>Use a Flow</MdOutlinedButton>
    </details>
  </section>;
}
