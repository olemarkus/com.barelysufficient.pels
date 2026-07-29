import {
  modeSelect,
  priorityEmpty,
  priorityList,
} from './dom.ts';
import { state } from './state.ts';

const EMPTY_MODE_COPY = 'No controllable devices found. Refresh devices first.';

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
