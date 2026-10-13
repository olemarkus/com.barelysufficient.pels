import { render } from 'preact';
import type { ChargingAccessStatus, ChargingCurrentRead, ChargingCurrentSetup } from '../../../../contracts/src/chargingControl.ts';
import { CHARGING_ACCESS_PATH, CHARGING_ACCESS_CHECK_PATH, CHARGING_CURRENT_PATH } from '../../../../contracts/src/chargingControl.ts';
import { callApi } from '../homey.ts';
import { ChargingCurrentSetupView } from '../views/ChargingCurrentSetup.tsx';

let selectedDeviceId = '';
let loadVersion = 0;

export function setChargingCurrentDevice(deviceId: string): void {
  if (deviceId === selectedDeviceId) return;
  selectedDeviceId = deviceId;
  const version = ++loadVersion;
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
      onCheck={() => perform(() => callApi('POST', CHARGING_ACCESS_CHECK_PATH))}
      onSaveKey={(key) => perform(() => callApi('PUT', CHARGING_ACCESS_PATH, { key }))}
      onRemove={() => perform(() => callApi('DELETE', CHARGING_ACCESS_PATH))}
      onSaveMethod={(setup: ChargingCurrentSetup) => perform(() => callApi('PUT', `${CHARGING_CURRENT_PATH}/${encodeURIComponent(deviceId)}`, setup))}
    />, container);
  };
  const load = async () => {
    const [devices, status] = await Promise.all([
      callApi<ChargingCurrentRead[]>('GET', CHARGING_CURRENT_PATH),
      callApi<ChargingAccessStatus>('GET', CHARGING_ACCESS_PATH),
    ]);
    const match = devices.find((entry) => entry.deviceId === deviceId);
    if (!match || version !== loadVersion) return;
    device = match;
    access = status;
    display();
  };
  const perform = async (operation: () => Promise<unknown>) => {
    busy = true;
    error = '';
    display();
    try { await operation(); await load(); document.dispatchEvent(new Event('charging-control-changed')); }
    catch (failure) { error = failure instanceof Error ? failure.message : 'Charging setup could not be saved. Try again.'; }
    finally { busy = false; display(); }
  };
  void load().catch(() => {
    if (version === loadVersion) selectedDeviceId = '';
  });
}
