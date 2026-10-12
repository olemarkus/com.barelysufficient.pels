import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import { deviceDetailTitle } from '../dom.ts';

/** The device page's app-bar title. */
export const setDeviceDetailTitle = (name: string) => {
  if (!deviceDetailTitle) return;
  const displayName = formatDisplayDeviceName(name);
  deviceDetailTitle.textContent = displayName;
  // The app-bar title is single-line + ellipsis; carry the full name in `title`
  // so a long device name that clips stays recoverable on hover / long-press.
  deviceDetailTitle.setAttribute('title', displayName);
};
