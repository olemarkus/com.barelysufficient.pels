import { useState } from 'preact/hooks';
import type { ChargingAccessStatus, ChargingCurrentRead, ChargingCurrentSetup } from '../../../../contracts/src/chargingControl.ts';
import { MdFilledButton, MdOutlinedButton, MdFilledTextField, MdSwitch, readSwitchSelected } from './materialWebJSX.tsx';

export type ChargingCurrentSetupProps = {
  device: ChargingCurrentRead;
  access: ChargingAccessStatus;
  busy: boolean;
  error: string;
  onSaveKey: (key: string) => Promise<boolean>;
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
  not_configured: 'Add a Homey API key to let PELS adjust charging current without a Flow.',
  not_checked: 'Check the saved key to enable charging-current control.',
  ready: 'Flow permission verified. Charging commands still need confirmation from the device.',
  permission_denied: 'The key needs Flow permission. Replace it with a key that has this permission.',
  unavailable: 'Homey charging access is unavailable. Check the key and try again.',
};

export function ChargingCurrentSetupView(props: ChargingCurrentSetupProps) {
  const { device, access, busy } = props;
  const [key, setKey] = useState('');
  const [singleCharger, setSingleCharger] = useState(device.setup.confirmation === 'single_charger');
  const [vehicleControl, setVehicleControl] = useState(device.setup.confirmation === 'vehicle');
  const canEnable = device.flowCheck === 'clear' && !device.sharedInstallation
    && (device.scope !== 'installation' || singleCharger)
    && (device.scope !== 'vehicle' || vehicleControl)
    && (device.capabilityWritable || access.state === 'ready');
  const confirmation = device.scope === 'vehicle' ? vehicleControl : singleCharger;
  const confirmedScope = device.scope === 'vehicle' ? 'vehicle' : 'single_charger';
  const chosenConfirmation = confirmation ? confirmedScope : 'none';
  let conflictCopy = 'A current-setting Flow is configured. You can keep using it or add a key for built-in control.';
  if (device.setup.method === 'built_in') {
    conflictCopy = 'Remove the current-setting action from your Flow so it does not compete with built-in control. Then check again.';
  } else if (access.configured || device.capabilityWritable) {
    conflictCopy = 'Remove the current-setting action from your Flow before switching to built-in control. Then check again.';
  }
  return <section class="charging-current-setup">
    <h3 class="pels-text-settings-label">Charging current</h3>
    {props.error && <p class="field__hint" role="alert">{props.error}</p>}
    <p class="field__hint">Start and stop work independently of the current-control method. Choose the EV charging steps and installation limit in Control model.</p>
    {device.setup.method === 'built_in' && <p class="field__hint">Built-in current control is selected.</p>}
    {device.setup.method === 'flow' && <p class="field__hint">Flow control is selected. Set up a current-setting Flow below, or choose built-in control.</p>}
    {device.flowCheck === 'conflict' && <p class="field__hint" role="status">
      {conflictCopy}
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
      <MdOutlinedButton disabled={busy || vehicleControl === (device.setup.confirmation === 'vehicle')}
        onClick={() => props.onSaveMethod({ ...device.setup, confirmation: vehicleControl ? 'vehicle' : 'none' })}>Save car control</MdOutlinedButton>
    </div>}
    {device.sharedInstallation && <p class="field__hint">This installation has more than one charger. Use a Flow for current control.</p>}
    {device.scope === 'installation' && !device.sharedInstallation && <label class="md-switch-row">
      <span class="md-switch-row__content"><span class="md-switch-row__label">This installation has only one charger</span></span>
      <MdSwitch aria-label="This installation has only one charger" selected={singleCharger} disabled={busy}
        onChange={(event: Event) => setSingleCharger(readSwitchSelected(event))} />
    </label>}
    {((!device.capabilityWritable && !device.sharedInstallation) || access.configured) && <div>
      <p class="field__hint">{ACCESS_COPY[access.state]}</p>
      <p class="field__hint">In the Homey Web App, open Settings → API Keys and create a key named PELS with Flow permission. One key works for all supported cars and chargers on this Homey. <a href={GUIDE} target="_blank" rel="noopener noreferrer">Create an API key</a></p>
      <MdFilledTextField label={access.configured ? 'Replacement API key' : 'API key'} type="password"
        autocomplete="off" value={key} disabled={busy}
        onInput={(event: Event) => setKey((event.currentTarget as HTMLInputElement).value)} />
      <div class="form__actions">
        <MdFilledButton disabled={busy || !key.trim()} onClick={async () => {
          if (await props.onSaveKey(key)) setKey('');
        }}>{access.configured ? 'Replace key' : 'Save key'}</MdFilledButton>
        {access.configured && <MdOutlinedButton disabled={busy} onClick={props.onRemove}>Remove key</MdOutlinedButton>}
      </div>
    </div>}
    <div class="form__actions">
      <MdOutlinedButton disabled={busy} onClick={props.onCheck}>Check again</MdOutlinedButton>
      {device.setup.method === 'flow'
        ? <MdFilledButton disabled={busy || !canEnable} onClick={() => props.onSaveMethod({ method: 'built_in', confirmation: chosenConfirmation })}>Use built-in control</MdFilledButton>
        : <MdOutlinedButton disabled={busy} onClick={() => props.onSaveMethod({ method: 'flow', confirmation: chosenConfirmation })}>Use a Flow</MdOutlinedButton>}
    </div>
    <details>
      <summary>Set up a Flow instead</summary>
      <p class="field__hint">Use PELS “Stepped device target changed” for this device. Check “Stepped-load request is still valid” with the Request ID tag immediately before the charger’s charging-current action, using the EV charger current (A) tag. Do not add a delay between the check and the action. PELS controls start and stop separately.</p>
    </details>
  </section>;
}
