import type { TargetDeviceSnapshot } from '../../../../contracts/src/types.ts';
import {
  deviceDetailSocRow,
  deviceDetailSocUpdated,
  deviceDetailSocValue,
} from '../dom.ts';
import { getTimeAgo } from '../utils.ts';

export function setDeviceDetailSocState(device: TargetDeviceSnapshot | null): void {
  if (!deviceDetailSocRow || !deviceDetailSocValue || !deviceDetailSocUpdated) return;
  if (!device || device.deviceClass !== 'evcharger') {
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

  if (soc.status === 'unknown') {
    deviceDetailSocValue.textContent = 'Not reported';
  } else if (soc.status === 'invalid') {
    deviceDetailSocValue.textContent = 'Invalid report';
  } else if (soc.status === 'stale') {
    deviceDetailSocValue.textContent = `${soc.percent} % - stale`;
  } else {
    deviceDetailSocValue.textContent = `${soc.percent} %`;
  }

  if (typeof soc.observedAtMs === 'number' && Number.isFinite(soc.observedAtMs)) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    deviceDetailSocUpdated.textContent = `Updated ${getTimeAgo(
      new Date(soc.observedAtMs),
      new Date(),
      timeZone,
    )} - Status: ${soc.status}`;
  } else {
    deviceDetailSocUpdated.textContent = `Status: ${soc.status}`;
  }
}
