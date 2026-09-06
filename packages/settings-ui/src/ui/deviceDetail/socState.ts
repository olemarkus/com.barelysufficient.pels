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

  // The value line above already states the consequence in plain words ("N %",
  // "No car connected", "Not reported"), so the subline only carries the time the
  // reading arrived — it must NOT leak a raw status enum ("Status: stale").
  //
  // Read off the RAW report, not the level: the subline says when the charger
  // last told PELS anything, which stays true — and stays worth showing — for the
  // "No car connected" case, where there is no level to carry a stamp.
  // Finiteness-gated, not merely presence-gated: this is the WebView side of the
  // Homey API bridge, an untrusted transport with no validating adapter in front
  // of it, and a junk stamp would render "Updated Invalid Date".
  const reportedAtMs = soc.report.observedAtMs;
  if (reportedAtMs === undefined || !Number.isFinite(reportedAtMs)) {
    deviceDetailSocUpdated.textContent = '';
    return;
  }
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  deviceDetailSocUpdated.textContent = `Updated ${getTimeAgo(
    new Date(reportedAtMs),
    new Date(),
    timeZone,
  )}`;
}
