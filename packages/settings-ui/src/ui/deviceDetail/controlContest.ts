import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import { controlContestNotice } from '../controlContestCopy.ts';
import type { SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import {
  deviceDetailControlContestBody,
  deviceDetailControlContestNotice,
  deviceDetailControlContestTitle,
  deviceDetailSetupDisclosure,
} from '../dom.ts';

// Opened once per device page visit, so a closed Setup stays closed on refresh.
let setupOpenedForDeviceId: string | null = null;

/** Closing the device page ends the visit: the next one opens Setup again for a contested device. */
export const resetDeviceDetailControlContest = (): void => {
  setupOpenedForDeviceId = null;
};

/**
 * The device page says why a device that keeps moving away from what PELS set
 * matters, next to Managed by PELS, the switch that ends it from PELS's side.
 */
export const renderDeviceDetailControlContest = (device: SettingsUiDeviceDetailItem | null): void => {
  const contest = device?.controlContest;
  if (deviceDetailControlContestNotice) deviceDetailControlContestNotice.hidden = !contest;
  if (!device || !contest) return;
  const notice = controlContestNotice(formatDisplayDeviceName(device.name), contest);
  if (deviceDetailControlContestTitle) deviceDetailControlContestTitle.textContent = notice.title;
  if (deviceDetailControlContestBody) deviceDetailControlContestBody.textContent = notice.body;
  if (setupOpenedForDeviceId !== device.id && deviceDetailSetupDisclosure) {
    deviceDetailSetupDisclosure.open = true;
    setupOpenedForDeviceId = device.id;
  }
};
