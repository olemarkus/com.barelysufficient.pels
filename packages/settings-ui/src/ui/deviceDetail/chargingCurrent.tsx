import { render } from 'preact';
import type { ChargingAccessStatus, ChargingCurrentRead, ChargingCurrentSetup } from '../../../../contracts/src/chargingControl.ts';
import { CHARGING_ACCESS_PATH, CHARGING_ACCESS_CHECK_PATH, CHARGING_CURRENT_PATH } from '../../../../contracts/src/chargingControl.ts';
import { invalidateChargingSetupReads, loadChargingSetup } from '../chargingSetupFacts.ts';
import type { MdSwitch } from '@material/web/switch/switch.js';
import { callApi } from '../homey.ts';
import { formatSettingsError } from '../toast.ts';
import { refreshFlowConflictFactsExplicit } from '../flowConflictRefresh.ts';
import { ChargingCurrentSetupView, ChargingCurrentLoadView } from '../views/ChargingCurrentSetup.tsx';

let selectedDeviceId = '';
let loadVersion = 0;
let pendingFocusVersion: number | null = null;
let focusRequestGeneration = 0;

/** Request a one-shot landing after the asynchronous charging controls arrive. */
export function requestChargingControlFocus(): void {
  pendingFocusVersion = loadVersion;
  focusRequestGeneration += 1;
  void consumeChargingControlFocus();
}

export function cancelChargingControlFocus(): void {
  pendingFocusVersion = null;
}

async function consumeChargingControlFocus(): Promise<void> {
  if (pendingFocusVersion !== loadVersion) return;
  const version = loadVersion;
  const request = focusRequestGeneration;
  const control = document.querySelector<MdSwitch>('#device-detail-vehicle-control');
  if (!control) return;
  if (!control.hasUpdated || control.isUpdatePending) await control.updateComplete;
  if (version !== loadVersion || pendingFocusVersion !== version || request !== focusRequestGeneration
    || !control.isConnected || document.getElementById(control.id) !== control || control.disabled) return;
  control.closest('details')?.setAttribute('open', '');
  document.getElementById('device-detail-vehicle-control-row')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  control.focus({ preventScroll: true });
  pendingFocusVersion = null;
}

/**
 * @param showProgress Whether this page may show the read's loading and failure
 *   states. Only a charger's page can: any other device appears here only once
 *   the read lists it, so a failed read leaves no charger block on a heater.
 */
export function setChargingCurrentDevice(deviceId: string, showProgress: boolean): void {
  if (deviceId === selectedDeviceId) return;
  selectedDeviceId = deviceId;
  const version = ++loadVersion;
  pendingFocusVersion = null;
  const container = document.getElementById('device-detail-charging-current');
  if (!container) return;
  render(null, container);
  if (!deviceId) return;
  let busy = false;
  let error = '';
  let device: ChargingCurrentRead;
  let access: ChargingAccessStatus;
  const display = () => {
    if (version !== loadVersion) return;
    render(<ChargingCurrentSetupView key={deviceId} device={device} access={access} busy={busy} error={error}
      onReady={consumeChargingControlFocus}
      onCheck={() => perform(async () => {
        if (device.supportsAppAction) await callApi('POST', CHARGING_ACCESS_CHECK_PATH);
        // The same scan the periodic check runs, so a cleared Flow resumes built-in control now.
        await refreshFlowConflictFactsExplicit();
      })}
      onSaveKey={(key) => perform(() => callApi('PUT', CHARGING_ACCESS_PATH, { key }))}
      onEnableWithKey={(key, setup) => perform(async () => {
        await callApi('PUT', CHARGING_ACCESS_PATH, { key });
        await callApi('PUT', `${CHARGING_CURRENT_PATH}/${encodeURIComponent(deviceId)}`, setup);
      })}
      onRemove={() => perform(() => callApi('DELETE', CHARGING_ACCESS_PATH))}
      onSaveMethod={(setup: ChargingCurrentSetup) => perform(() => callApi('PUT', `${CHARGING_CURRENT_PATH}/${encodeURIComponent(deviceId)}`, setup))}
    />, container);
  };
  const load = async () => {
    const { devices, access: status } = await loadChargingSetup();
    const match = devices.find((entry) => entry.deviceId === deviceId);
    if (version !== loadVersion) return;
    if (!match) { render(null, container); return; }
    device = match;
    access = status;
    display();
  };
  const perform = async (operation: () => Promise<unknown>) => {
    busy = true;
    error = '';
    display();
    try {
      try { await operation(); }
      finally { invalidateChargingSetupReads(); }
      await load(); document.dispatchEvent(new Event('charging-control-changed'));
      return true;
    } catch (failure) {
      // A combined save may have saved the key before enabling control failed.
      // Refresh so the next action reflects the configuration actually saved.
      try {
        await load();
        document.dispatchEvent(new Event('charging-control-changed'));
      } catch { /* Keep the last loaded state if refresh also fails. */ }
      error = formatSettingsError(failure, 'Charging setup could not be saved. Try again.');
      return false;
    }
    finally {
      busy = false;
      display();
      document.dispatchEvent(new Event('homey-api-key-changed'));
    }
  };
  const loadInitial = async (): Promise<void> => {
    if (version !== loadVersion) return;
    if (showProgress) render(<ChargingCurrentLoadView busy onRetry={loadInitial} />, container);
    try { await load(); }
    catch {
      if (version === loadVersion && showProgress) {
        render(<ChargingCurrentLoadView busy={false} onRetry={loadInitial} />, container);
      }
    }
  };
  void loadInitial();
}
