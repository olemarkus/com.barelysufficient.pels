import {
  deviceDetailDumpLoadRow, deviceDetailSolarPendingHint, deviceDetailSurplusOptRow,
  deviceDetailSurplusTrackRow, settingsPowerSourceSelect,
} from '../dom.ts';
import type { SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { resolveSolarSurplusPending, resolveSolarSurplusPendingNote } from '../state.ts';
import { resolveDeviceDetailControlState } from './controlState.ts';
import { isDumpLoadDeviceShape, setDeviceDetailDumpLoadControl } from './solarSurplus.ts';
import { isSurplusTrackingDeviceShape, setDeviceDetailSurplusTrackingControl } from './solarSurplusTracking.ts';

/** The binary and level solar rows, then what stands in their place while solar is on its way. */
export const syncDeviceDetailSolarRows = (
  deviceId: string | null,
  device: SettingsUiDeviceDetailItem | null,
): void => {
  setDeviceDetailDumpLoadControl(deviceId, device);
  setDeviceDetailSurplusTrackingControl(deviceId, device);
  setDeviceDetailSolarPendingHint(deviceId, device);
};

/**
 * The solar rows stay hidden until the home's surplus pool can open, because a
 * switch there could not do anything yet. A device that could use solar, in a
 * home whose solar has not yet produced more than it uses, says so in their
 * place instead of showing nothing. Runs after the three rows are synced.
 */
const setDeviceDetailSolarPendingHint = (
  deviceId: string | null,
  device: SettingsUiDeviceDetailItem | null,
): void => {
  if (!deviceDetailSolarPendingHint) return;
  const controlState = resolveDeviceDetailControlState(device, deviceId ?? '');
  const candidate = deviceId !== null && device !== null && controlState.isManaged && (
    controlState.supportsTemperature
    || isDumpLoadDeviceShape(device, controlState)
    || isSurplusTrackingDeviceShape(device, controlState)
  );
  const rowShown = [deviceDetailSurplusOptRow, deviceDetailDumpLoadRow, deviceDetailSurplusTrackRow]
    .some((row) => row !== null && !row.hidden);
  const pending = candidate && !rowShown && resolveSolarSurplusPending();
  deviceDetailSolarPendingHint.textContent = pending
    ? resolveSolarSurplusPendingNote(settingsPowerSourceSelect?.value === 'flow') : '';
  deviceDetailSolarPendingHint.hidden = !pending;
};
