import { callApi, getHomeyClient } from './homey.ts';
import {
  SETTINGS_UI_BOOTSTRAP_PATH,
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_PRICES_PATH,
  type SettingsUiBootstrap,
  type SettingsUiDevicesPayload,
  type SettingsUiPricesPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import {
  fetchDeadlinePlanHistory,
  resolveBrowserTimeZone,
  type DeadlinePlanHistoryView,
} from './deadlinePlanHistoryFetch.ts';
import { renderDeadlinePlan } from './views/DeadlinePlan.tsx';
import { resolveDeadlinePlanLoadState, resolveRenderInput } from './deadlinePlan.ts';
import { logSettingsError } from './logging.ts';
import type { MdButtonElement } from './dom.ts';

const describeError = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  try { return JSON.stringify(error); } catch { return String(error); }
};

const buildBootErrorMessage = (error: unknown): string => (
  `Smart task plan data could not be loaded: ${describeError(error)}`
);

const DEADLINE_PLAN_REFRESH_DEBOUNCE_MS = 200;

const closeDeadlinePlanPage = (): void => {
  if (window.history.length > 1) {
    window.history.back();
    return;
  }
  window.close();
};

let closeHandlerBound = false;

const initDeadlinePlanClose = (): void => {
  if (closeHandlerBound) return;
  const button = document.querySelector<MdButtonElement>('[data-deadline-plan-close]');
  if (!button) return;
  button.addEventListener('click', closeDeadlinePlanPage);
  closeHandlerBound = true;
};

export type DeadlinePlanBoot = {
  bootstrap: SettingsUiBootstrap;
  devicesPayload: SettingsUiDevicesPayload;
  prices: SettingsUiPricesPayload;
};

// Parallel fan-out: bootstrap (carries deferred-objective plans + power
// tracker), devices, and prices. Running prices in the same batch as
// bootstrap/devices avoids the serial round-trip that previously kept the
// page on "Loading deadline plan" much longer than necessary.
const fetchPricesOrNull = (): Promise<SettingsUiPricesPayload | null> => (
  callApi<SettingsUiPricesPayload>('GET', SETTINGS_UI_PRICES_PATH).catch(() => null)
);

const fetchDeadlinePlanBoot = async (): Promise<DeadlinePlanBoot> => {
  const [bootstrap, devicesPayload, prices] = await Promise.all([
    callApi<SettingsUiBootstrap>('GET', SETTINGS_UI_BOOTSTRAP_PATH),
    callApi<SettingsUiDevicesPayload>('GET', SETTINGS_UI_DEVICES_PATH),
    fetchPricesOrNull(),
  ]);
  return { bootstrap, devicesPayload, prices: prices ?? bootstrap.prices };
};

export const isDeadlinePlanPage = (): boolean => (
  document.getElementById('deadline-plan-root') !== null
);

// History-detail route does not need bootstrap/devices/prices — rendering a
// finalized plan reads only from the persisted history entry. Fetch history
// alone so a bookmarked link still works when the live endpoints fail.
const mountHistoryDetail = async (
  surface: HTMLElement,
  deviceId: string | null,
  historyId: string,
  timeZone: string,
): Promise<void> => {
  // Swap to the loading state synchronously so the "Try again" button is
  // removed before the new fetch starts. Without this, fast double-clicks
  // would queue duplicate fetches (and duplicate logSettingsError calls).
  renderDeadlinePlan(surface, { status: 'loading' });
  let history: DeadlinePlanHistoryView;
  try {
    history = await fetchDeadlinePlanHistory(deviceId, timeZone, true);
  } catch (error) {
    await logSettingsError(
      'Failed to load smart task history detail',
      error,
      'mountHistoryDetail',
    );
    renderDeadlinePlan(surface, {
      status: 'error',
      message: buildBootErrorMessage(error),
      onRetry: () => { void mountHistoryDetail(surface, deviceId, historyId, timeZone); },
    });
    return;
  }
  const entry = history.entries.find((candidate) => candidate.id === historyId);
  if (!entry) {
    renderDeadlinePlan(surface, { status: 'history-missing', history });
    return;
  }
  renderDeadlinePlan(surface, {
    status: 'history-detail',
    entry,
    timeZone: history.timeZone,
    history,
  });
};

export const mountDeadlinePlan = async (): Promise<void> => {
  const surface = document.getElementById('deadline-plan-root');
  if (!surface) return;

  const params = new URLSearchParams(window.location.search);
  const deviceId = params.get('deviceId');
  const historyId = params.get('historyId');
  const timeZone = resolveBrowserTimeZone();

  initDeadlinePlanClose();
  renderDeadlinePlan(surface, { status: 'loading' });

  if (historyId !== null) {
    await mountHistoryDetail(surface, deviceId, historyId, timeZone);
    return;
  }

  let lastBoot: DeadlinePlanBoot | null = null;
  let lastHistory: DeadlinePlanHistoryView | undefined;
  const renderWith = (boot: DeadlinePlanBoot, history: DeadlinePlanHistoryView | undefined): void => {
    const renderInput = resolveRenderInput({
      bootstrap: boot.bootstrap,
      deviceId,
      devices: boot.devicesPayload.devices,
      prices: boot.prices,
    });
    renderDeadlinePlan(surface, resolveDeadlinePlanLoadState(renderInput, history));
  };

  try {
    lastBoot = await fetchDeadlinePlanBoot();
  } catch (error) {
    await logSettingsError(
      'Failed to load smart task plan boot data',
      error,
      'mountDeadlinePlan',
    );
    renderDeadlinePlan(surface, {
      status: 'error',
      message: buildBootErrorMessage(error),
      onRetry: () => { void mountDeadlinePlan(); },
    });
    return;
  }
  // First paint without waiting on history — Current tab is the default and
  // History fills in shortly after.
  renderWith(lastBoot, lastHistory);

  subscribeToRuntimeRefresh({
    getLastHistory: () => lastHistory,
    onBoot: (next) => { lastBoot = next; },
    renderWith,
  });

  // Warm history in the background so the History tab is populated when the
  // user clicks it (or when the completed-deadline path auto-selects it).
  void fetchDeadlinePlanHistory(deviceId, timeZone).then((history) => {
    lastHistory = history;
    if (lastBoot) renderWith(lastBoot, history);
  });
};

// Resubscribe to runtime change events so the page reflects new plan
// revisions and device updates without a manual reload. Mirrors the refresh
// strategy in `realtime.ts`, which only runs on the main settings page.
const subscribeToRuntimeRefresh = (params: {
  getLastHistory: () => DeadlinePlanHistoryView | undefined;
  onBoot: (next: DeadlinePlanBoot) => void;
  renderWith: (boot: DeadlinePlanBoot, history: DeadlinePlanHistoryView | undefined) => void;
}): void => {
  const homey = getHomeyClient();
  if (!homey || typeof homey.on !== 'function') return;
  let refreshing = false;
  let refreshQueued = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const refresh = async (): Promise<void> => {
    if (refreshing) {
      refreshQueued = true;
      return;
    }
    refreshing = true;
    try {
      const next = await fetchDeadlinePlanBoot();
      params.onBoot(next);
      params.renderWith(next, params.getLastHistory());
    } catch (error) {
      // Background refresh: do not blow away the rendered current view, but
      // do log the failure so a recurring transient is visible in
      // `/tmp/pels` instead of silent.
      await logSettingsError(
        'Background refresh of smart task plan failed',
        error,
        'mountDeadlinePlan.refresh',
      );
    } finally {
      refreshing = false;
      if (refreshQueued && isDeadlinePlanPage()) {
        refreshQueued = false;
        scheduleRefresh();
      }
    }
  };
  const scheduleRefresh = (): void => {
    if (!isDeadlinePlanPage()) return;
    refreshQueued = true;
    if (refreshTimer !== null) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (!isDeadlinePlanPage()) {
        refreshQueued = false;
        return;
      }
      refreshQueued = false;
      void refresh();
    }, DEADLINE_PLAN_REFRESH_DEBOUNCE_MS);
  };
  homey.on('plan_updated', scheduleRefresh);
  homey.on('devices_updated', scheduleRefresh);
  homey.on('prices_updated', scheduleRefresh);
};
