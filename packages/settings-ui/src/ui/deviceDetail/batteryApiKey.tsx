import { render } from 'preact';
import type { ChargingAccessStatus } from '../../../../contracts/src/chargingControl.ts';
import { CHARGING_ACCESS_CHECK_PATH, CHARGING_ACCESS_PATH } from '../../../../contracts/src/chargingControl.ts';
import { callApi } from '../homey.ts';
import { formatSettingsError } from '../toast.ts';
import {
  HomeyApiKeySetup, resolveHomeyApiKeySaveLabel, type HomeyApiKeyCopy,
} from '../views/HomeyApiKeySetup.tsx';
import { MdOutlinedButton } from '../views/materialWebJSX.tsx';
import type { SettingsUiDeviceDetailItem } from '../deviceUtils.ts';

const CONTAINER_ID = 'device-detail-battery-api-key';

const KEY_COPY: HomeyApiKeyCopy = {
  states: {
    not_configured: 'A Homey API key is needed for PELS to control this battery.',
    not_checked: 'Check the saved key to let PELS control this battery.',
    ready: 'API key verified.',
    permission_denied: 'The key needs Flow permission. Replace it with a key that has this permission.',
    unavailable: 'Homey access is unavailable. Check the key and try again.',
  },
  hint: 'In the Homey Web App → Settings → API Keys, create a key with Flow permission. One key works for all supported batteries, cars and chargers.',
};

let selectedDeviceId = '';
let loadVersion = 0;

/**
 * The Homey API key block on the device page of a battery PELS drives through
 * its app's Flow actions (`batteryUsesHomeyApiKey`), on the same routes and
 * key as charger current. Hidden for every other device. A saved or removed
 * key changes what PELS can do with the battery, so the device list is read
 * again after each change (`battery-api-key-changed`, which `realtime.ts` answers); the key is
 * shared, so the charging pages are told too (`charging-control-changed`).
 */
export function setBatteryApiKeyDevice(device: SettingsUiDeviceDetailItem | null): void {
  const deviceId = device?.batteryUsesHomeyApiKey === true ? device.id : '';
  if (deviceId === selectedDeviceId) return;
  selectedDeviceId = deviceId;
  const version = ++loadVersion;
  const container = document.getElementById(CONTAINER_ID);
  if (!container) return;
  render(null, container);
  if (!deviceId) return;
  let busy = false;
  let error = '';
  let access: ChargingAccessStatus | undefined;
  const display = () => {
    if (version !== loadVersion) return;
    if (!access) {
      render(<div>
        <p class="field__hint" role={busy ? 'status' : 'alert'}>{busy
          ? 'Loading the Homey API key…' : 'The Homey API key could not be loaded. Try again.'}</p>
        {!busy && <MdOutlinedButton onClick={() => { void load(); }}>Try again</MdOutlinedButton>}
      </div>, container);
      return;
    }
    const current = access;
    render(<div class="battery-api-key">
      {error && <p class="field__hint" role="alert">{error}</p>}
      <HomeyApiKeySetup access={current} busy={busy} copy={KEY_COPY}
        saveLabel={resolveHomeyApiKeySaveLabel(current)} saveBlocked={false}
        onSave={(key) => perform(() => callApi('PUT', CHARGING_ACCESS_PATH, { key }))}
        onRemove={() => perform(() => callApi('DELETE', CHARGING_ACCESS_PATH))} />
      {current.configured && current.state !== 'ready' && <div class="form__actions">
        <MdOutlinedButton disabled={busy}
          onClick={() => perform(() => callApi('POST', CHARGING_ACCESS_CHECK_PATH))}>Check again</MdOutlinedButton>
      </div>}
    </div>, container);
  };
  const read = async () => {
    const status = await callApi<ChargingAccessStatus>('GET', CHARGING_ACCESS_PATH);
    if (version === loadVersion) access = status;
  };
  const load = async () => {
    busy = true;
    display();
    try { await read(); } catch { /* The retry view says so. */ }
    finally { busy = false; display(); }
  };
  const perform = async (operation: () => Promise<unknown>): Promise<boolean> => {
    busy = true;
    error = '';
    display();
    try {
      await operation();
      await read();
      return true;
    } catch (failure) {
      try { await read(); } catch { /* Keep the last loaded state if refresh also fails. */ }
      error = formatSettingsError(failure, 'The Homey API key could not be saved. Try again.');
      return false;
    } finally {
      busy = false;
      display();
      document.dispatchEvent(new Event('battery-api-key-changed'));
      document.dispatchEvent(new Event('charging-control-changed'));
    }
  };
  void load();
}
