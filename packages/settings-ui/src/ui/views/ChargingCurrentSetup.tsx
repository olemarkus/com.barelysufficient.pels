import { useLayoutEffect, useState } from 'preact/hooks';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import type { ChargingAccessStatus, ChargingCurrentRead, ChargingCurrentSetup } from '../../../../contracts/src/chargingControl.ts';
import { MdFilledButton, MdOutlinedButton, MdSwitch, MdTextButton, readSwitchSelected } from './materialWebJSX.tsx';
import { hasBuiltInChargingAccess, requiresChargingAppUpdate, usesInstallationCurrentWithoutSetup } from '../chargingSetupFacts.ts';
import { HomeyApiKeySetup, resolveHomeyApiKeySaveLabel, type HomeyApiKeyCopy } from './HomeyApiKeySetup.tsx';

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
  onReady?: () => void;
};

export function ChargingCurrentLoadView(props: { busy: boolean; onRetry: () => Promise<void> }) {
  return <section class="charging-current-setup">
    <h3 class="pels-text-settings-label">Charging current</h3>
    {props.busy
      ? <p class="field__hint" role="status">Loading charging setup…</p>
      : <p class="field__hint" role="alert">Charging setup could not be loaded. Try again.</p>}
    <MdTextButton disabled={props.busy} onClick={props.onRetry}>Try again</MdTextButton>
  </section>;
}

const KEY_COPY: HomeyApiKeyCopy = {
  states: {
    not_configured: 'A Homey API key is needed for built-in control.',
    not_checked: 'Check the saved key to enable charging-current control.',
    ready: 'API key verified.',
    permission_denied: 'The key needs Flow permission. Replace it with a key that has this permission.',
    unavailable: 'Homey charging access is unavailable. Check the key and try again.',
  },
  hint: 'In the Homey Web App → Settings → API Keys, create a key with Flow permission. One key works for all supported cars and chargers.',
};

/** Why a selected built-in route is held back, and how the owner clears it. */
function pausedHint(flowNames: readonly string[]): string {
  const subject = flowNames.length === 0 ? 'A Homey Flow sets'
    : `${flowNames.length === 1 ? 'The Flow' : 'The Flows'} ${flowNames.join(', ')} ${flowNames.length === 1 ? 'sets' : 'set'}`;
  return `${subject} the same charging current, and PELS cannot stop a Flow. The two would override each other, `
    + 'so PELS leaves the current to the Flow for now. Remove the current-setting action from the Flow, '
    + 'then select “Check again”. Built-in current control resumes on its own. '
    + 'To keep the Flow instead, choose “Use a Flow” below.';
}

// A Flow remains available for an existing Flow, a shared installation, or
// a charger whose installed app does not offer built-in current control.
const keepsFlow = (device: ChargingCurrentRead): boolean => device.flowCheck === 'conflict'
  || device.sharedInstallation || requiresChargingAppUpdate(device);

/** With built-in control not selected: what sets the current meanwhile. */
function FlowRouteHint({ device }: { device: ChargingCurrentRead }) {
  if (device.flowCheck === 'conflict') {
    return <p class="field__hint">Your current-setting Flow remains in use until you switch.</p>;
  }
  if (device.flowCheck !== 'clear' || device.sharedInstallation
    || requiresChargingAppUpdate(device)) return null;
  return <p class="field__hint">Until you enable it below, nothing changes the charging current.</p>;
}

function currentControlStatus(device: ChargingCurrentRead): string {
  if (device.setup.method !== 'built_in') {
    return device.flowCheck === 'conflict' ? 'Flow control is selected.' : 'Built-in current control is not enabled.';
  }
  if (requiresChargingAppUpdate(device)) return 'Built-in current control needs a charger app update.';
  return device.currentRoute === 'flow' ? 'Built-in current control is paused.' : 'Built-in current control is selected.';
}

function CurrentControlStatus({ device }: { device: ChargingCurrentRead }) {
  const builtIn = device.setup.method === 'built_in';
  // A selected route can resume after a competing Flow is removed, but not after capability support disappears.
  const paused = builtIn && device.currentRoute === 'flow' && !requiresChargingAppUpdate(device);
  return <div role="status">
    <p><strong>{currentControlStatus(device)}</strong></p>
    {paused && <p class="field__hint">{pausedHint(device.flowNames.filter(Boolean))}</p>}
    {!builtIn && <FlowRouteHint device={device} />}
  </div>;
}

function currentControlHint(device: ChargingCurrentRead): string {
  if (device.sharedInstallation) return 'Use a Flow to adjust current for this shared installation. PELS starts and stops each managed charger separately.';
  if (requiresChargingAppUpdate(device)) return 'Update the charger’s app in Homey to use built-in current control, or use a Flow.';
  return 'Let PELS adjust charging current directly. No Flow needed.';
}

function ChargingInstallationHint({ installation }: { installation: NonNullable<ChargingCurrentRead['chargingInstallation']> }) {
  const charger = installation.role === 'main' ? 'this charger' : formatDisplayDeviceName(installation.mainName);
  return <p class="field__hint">PELS sets the available current for this installation through {charger}.
    The chargers share that current between the cars that are charging.</p>;
}

export function ChargingCurrentSetupView(props: ChargingCurrentSetupProps) {
  const { device, busy } = props;
  useLayoutEffect(() => { props.onReady?.(); }, [device.deviceId, busy]);
  const installation = device.chargingInstallation;
  if (installation && usesInstallationCurrentWithoutSetup(device)) {
    return <section class="charging-current-setup">
      <h3 class="pels-text-settings-label">Charging current</h3>
      <ChargingInstallationHint installation={installation} />
    </section>;
  }
  return <SelectableChargingCurrentSetup {...props} />;
}

function SelectableChargingCurrentSetup(props: ChargingCurrentSetupProps) {
  const { device, access, busy } = props;
  const [singleCharger, setSingleCharger] = useState(device.setup.confirmation === 'single_charger');
  const [vehicleControl, setVehicleControl] = useState(device.setup.confirmation === 'vehicle');
  // A charger-scoped command reaches only this charger, so it needs no confirmation.
  const scopeConfirmation: Record<ChargingCurrentRead['scope'], { confirmed: boolean; value: ChargingCurrentSetup['confirmation'] }> = {
    vehicle: { confirmed: vehicleControl, value: 'vehicle' },
    installation: device.chargingInstallation
      ? { confirmed: true, value: 'none' }
      : { confirmed: singleCharger, value: 'single_charger' },
    charger: { confirmed: true, value: 'none' },
  };
  const { confirmed: confirmation, value: confirmedScope } = scopeConfirmation[device.scope];
  const chosenConfirmation = confirmation ? confirmedScope : 'none';
  const scopeAllowed = device.flowCheck === 'clear' && !device.sharedInstallation && confirmation;
  const requiresAppUpdate = requiresChargingAppUpdate(device);
  const canEnable = scopeAllowed && hasBuiltInChargingAccess(device, access);
  const builtIn = device.setup.method === 'built_in';
  const flowNames = device.flowNames.filter(Boolean);
  const needsKey = device.supportsAppAction && !hasBuiltInChargingAccess(device, access);
  const showKeySetup = device.supportsAppAction && !device.capabilityWritable && !device.sharedInstallation;
  const enableWithKey = !builtIn && needsKey && !access.configured;
  const activationGuidance = <div role="status">
    {!builtIn && !requiresAppUpdate && device.flowCheck === 'conflict' && <p class="field__hint">
      Remove the current-setting action from your Flow before using built-in control. Then select “Check again”.
      {flowNames.length > 0 && ` Flows: ${flowNames.join(', ')}.`}
    </p>}
    {device.flowCheck === 'unavailable' && <p class="field__hint">
      PELS could not check for current-setting Flows. Select “Check again” to retry before enabling built-in control.
    </p>}
    {!confirmation && !device.sharedInstallation && <p class="field__hint">{device.scope === 'vehicle'
      ? 'Turn on “Control charging through this car” to allow PELS to control this car.'
      : 'Confirm that this installation has only one charger.'}</p>}
    {!builtIn && canEnable && <p class="field__hint">{device.supportsAppAction && access.state === 'ready' ? 'Your key is ready. ' : ''}
      Select “Use built-in control” to finish setup for this device.
    </p>}
  </div>;
  return <section class="charging-current-setup">
    <h3 class="pels-text-settings-label">Charging current</h3>
    {props.error && <p class="field__hint" role="alert">{props.error}</p>}
    {device.chargingInstallation
      ? <ChargingInstallationHint installation={device.chargingInstallation} />
      : <p class="field__hint">{currentControlHint(device)}</p>}
    <CurrentControlStatus device={device} />
    {device.scope === 'vehicle' && <div>
      <label class="md-switch-row" id="device-detail-vehicle-control-row">
        <span class="md-switch-row__content"><span class="md-switch-row__label">Control charging through this car</span></span>
        <MdSwitch id="device-detail-vehicle-control" aria-label="Control charging through this car" selected={vehicleControl} disabled={busy}
          onChange={(event: Event) => setVehicleControl(readSwitchSelected(event))} />
      </label>
      {!builtIn && <p class="field__hint">This switch allows control through the car. To adjust current without a Flow, finish setup with “Use built-in control” or “Save key and enable”.</p>}
      <p class="field__hint">Manage either the car or its physical charger in PELS. Turn off Power-limit control for the other device.</p>
      {vehicleControl !== (device.setup.confirmation === 'vehicle') && (builtIn || !vehicleControl)
        && <MdOutlinedButton disabled={busy}
          onClick={() => props.onSaveMethod({ ...device.setup, confirmation: vehicleControl ? 'vehicle' : 'none' })}>Save car control</MdOutlinedButton>}
    </div>}
    {device.scope === 'installation' && !device.sharedInstallation && !device.chargingInstallation && <label class="md-switch-row">
      <span class="md-switch-row__content"><span class="md-switch-row__label">This installation has only one charger</span></span>
      <MdSwitch aria-label="This installation has only one charger" selected={singleCharger} disabled={busy}
        onChange={(event: Event) => setSingleCharger(readSwitchSelected(event))} />
    </label>}
    {(showKeySetup || access.configured) && <HomeyApiKeySetup
      access={access} busy={busy} copy={KEY_COPY} removeOnly={!device.supportsAppAction}
      saveLabel={enableWithKey ? 'Save key and enable' : resolveHomeyApiKeySaveLabel(access)}
      saveBlocked={enableWithKey && !scopeAllowed}
      onSave={(key) => (enableWithKey
        ? props.onEnableWithKey(key, { method: 'built_in', confirmation: chosenConfirmation })
        : props.onSaveKey(key))}
      onRemove={props.onRemove}>
      {enableWithKey && activationGuidance}
    </HomeyApiKeySetup>}
    {!enableWithKey && activationGuidance}
    <div class="form__actions">
      {!builtIn && !device.sharedInstallation && !needsKey && <MdFilledButton disabled={busy || !canEnable} onClick={() => props.onSaveMethod({ method: 'built_in', confirmation: chosenConfirmation })}>Use built-in control</MdFilledButton>}
      <MdOutlinedButton disabled={busy} onClick={props.onCheck}>Check again</MdOutlinedButton>
    </div>
    {keepsFlow(device) && <details>
      <summary>{requiresAppUpdate && device.flowCheck !== 'conflict' ? 'Set up a Flow' : 'Keep using a Flow'}</summary>
      <p class="field__hint">Use PELS “Stepped device target changed” for this device. Connect it to the charger’s charging-current action using the EV charger current (A) tag. PELS controls start and stop separately.</p>
      <MdOutlinedButton disabled={busy} onClick={() => props.onSaveMethod({ method: 'flow', confirmation: chosenConfirmation })}>Use a Flow</MdOutlinedButton>
    </details>}
  </section>;
}
