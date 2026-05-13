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
import { setStoredOverviewRedesignPreference } from './uiVariant.ts';
import type { MdButtonElement } from './dom.ts';

const DEADLINE_PLAN_REFRESH_DEBOUNCE_MS = 200;

const closeDeadlinePlanPage = (): void => {
  if (new URLSearchParams(window.location.search).get('ui') === 'redesign') {
    setStoredOverviewRedesignPreference(true);
  }
  if (window.history.length > 1) {
    window.history.back();
    return;
  }
  window.close();
};

const initDeadlinePlanClose = (): void => {
  document
    .querySelector<MdButtonElement>('[data-deadline-plan-close]')
    ?.addEventListener('click', closeDeadlinePlanPage);
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

export const mountDeadlinePlan = async (): Promise<void> => {
  const surface = document.getElementById('deadline-plan-root');
  if (!surface) return;

  const deviceId = new URLSearchParams(window.location.search).get('deviceId');
  const timeZone = resolveBrowserTimeZone();

  initDeadlinePlanClose();
  renderDeadlinePlan(surface, { status: 'loading' });

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
  } catch {
    renderDeadlinePlan(surface, {
      status: 'error',
      message: 'Smart task plan data is not available for this device.',
    });
    return;
  }
  // First paint without waiting on history — Current tab is the default and
  // History fills in shortly after.
  renderWith(lastBoot, lastHistory);

  // Resubscribe to runtime change events so the page reflects new plan
  // revisions and device updates without a manual reload. Mirrors the
  // refresh strategy in `realtime.ts`, which only runs on the main settings
  // page.
  const homey = getHomeyClient();
  if (homey && typeof homey.on === 'function') {
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
        lastBoot = next;
        renderWith(next, lastHistory);
      } catch {
        // Ignore transient failures; the next event tick will retry.
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
  }

  // Warm history in the background so the History tab is populated when the
  // user clicks it (or when the completed-deadline path auto-selects it).
  void fetchDeadlinePlanHistory(deviceId, timeZone).then((history) => {
    lastHistory = history;
    if (lastBoot) renderWith(lastBoot, history);
  });
};
