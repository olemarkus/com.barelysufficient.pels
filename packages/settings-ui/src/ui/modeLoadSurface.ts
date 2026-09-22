import {
  modeSelect,
  priorityEmpty,
  priorityList,
} from './dom.ts';
import { state } from './state.ts';

// This state means no MANAGED device, not no device: the list is filtered to
// managed devices, so "refresh devices" sent owners to a remedy that changed
// nothing. No "yet": an owner who unmanages their last device lands here too.
const EMPTY_MODE_COPY = 'No managed devices. Turn on Managed for a device under Devices to see it here.';

const resetModeSurface = (message?: string): void => {
  state.loadedModeHomeId = null;
  modeSelect?.replaceChildren();
  if (modeSelect) modeSelect.disabled = true;
  priorityList?.replaceChildren();
  if (priorityEmpty) {
    priorityEmpty.textContent = message ?? EMPTY_MODE_COPY;
    priorityEmpty.hidden = message === undefined;
  }
};

export const prepareModeHomeLoad = (homeId: string): void => {
  if (state.loadedModeHomeId !== homeId) resetModeSurface();
};

export const showModeCatalogUnavailable = (): void => {
  resetModeSurface('Modes couldn’t be loaded. Reopen this page to try again.');
};
