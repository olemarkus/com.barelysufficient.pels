import { isEvChargerDevice } from '../deviceKind.ts';
import type { SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import {
  deviceDetailSocRow,
  deviceDetailSocUpdated,
  deviceDetailSocValue,
} from '../dom.ts';
import { getTimeAgo } from '../utils.ts';

export function setDeviceDetailSocState(device: SettingsUiDeviceDetailItem | null): void {
  if (!deviceDetailSocRow || !deviceDetailSocValue || !deviceDetailSocUpdated) return;
  if (!device || !isEvChargerDevice(device)) {
    deviceDetailSocRow.hidden = true;
    deviceDetailSocValue.textContent = 'Not reported';
    deviceDetailSocUpdated.textContent = '';
    return;
  }

  const soc = device.stateOfCharge;
  deviceDetailSocRow.hidden = false;
  if (!soc) {
    deviceDetailSocValue.textContent = 'Not reported';
    deviceDetailSocUpdated.textContent = '';
    return;
  }

  // Two outcomes, because the producer has two: a level, or a reason there is
  // none. `N % - stale` is gone — a qualified number invited the reader to use
  // it anyway, and PELS itself does not.
  if (soc.level.kind === 'known') {
    deviceDetailSocValue.textContent = `${soc.level.percent} %`;
  } else {
    deviceDetailSocValue.textContent = soc.level.reasonCode === 'not_connected'
      ? 'No car connected'
      : 'Not reported';
  }

  // The value line above already states the consequence in plain words ("N % - stale",
  // "Invalid report", "Not reported"), so the subline only carries the freshness time —
  // it must NOT leak the raw status enum ("Status: stale") to the user.
  if (typeof soc.observedAtMs === 'number' && Number.isFinite(soc.observedAtMs)) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    deviceDetailSocUpdated.textContent = `Updated ${getTimeAgo(
      new Date(soc.observedAtMs),
      new Date(),
      timeZone,
    )}`;
  } else {
    deviceDetailSocUpdated.textContent = '';
  }
}
