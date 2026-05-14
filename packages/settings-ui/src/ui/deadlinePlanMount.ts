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

// Resolved by `boot.ts` so the close button can return to whichever tab the
// user came from (almost always Smart tasks). Kept as a module-local instead
// of a parameter on `mountDeadlinePlan` so the close button stays bound across
// the SPA's lifetime even when the deadline-plan view is re-mounted.
let onCloseDeadlinePlan: () => void = () => {};

export const setDeadlinePlanCloseHandler = (handler: () => void): void => {
  onCloseDeadlinePlan = handler;
};

const initDeadlinePlanClose = (): void => {
  const button = document.querySelector<MdButtonElement>('[data-deadline-plan-close]');
  if (!button || button.dataset.deadlinePlanCloseBound === 'true') return;
  button.dataset.deadlinePlanCloseBound = 'true';
  button.addEventListener('click', () => onCloseDeadlinePlan());
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

export const isDeadlinePlanPage = (): boolean => activeMount !== null;

// History-detail route does not need bootstrap/devices/prices — rendering a
// finalized plan reads only from the persisted history entry. Fetch history
// alone so a bookmarked link still works when the live endpoints fail.
const mountHistoryDetail = async (
  surface: HTMLElement,
  deviceId: string | null,
  historyId: string,
  timeZone: string,
  isStale: () => boolean,
): Promise<void> => {
  // Swap to the loading state synchronously so the "Try again" button is
  // removed before the new fetch starts. Without this, fast double-clicks
  // would queue duplicate fetches (and duplicate logSettingsError calls).
  renderDeadlinePlan(surface, { status: 'loading' });
  let history: DeadlinePlanHistoryView;
  try {
    history = await fetchDeadlinePlanHistory(deviceId, timeZone, true);
  } catch (error) {
    if (isStale()) return;
    await logSettingsError(
      'Failed to load smart task history detail',
      error,
      'mountHistoryDetail',
    );
    renderDeadlinePlan(surface, {
      status: 'error',
      message: buildBootErrorMessage(error),
      // Re-enter through `mountDeadlinePlan` so the retry gets a fresh
      // generation / `isStale` guard instead of inheriting this call's
      // closures and potentially racing the new fetch.
      onRetry: () => { void mountDeadlinePlan(); },
    });
    return;
  }
  if (isStale()) return;
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

// Active mount tracks the deviceId + historyId the panel is currently
// showing, plus the latest boot/history payloads. The runtime-refresh
// subscription (bound once on first mount) reads from this so re-renders
// stay aligned with the current URL even after the user navigates to a
// different smart task without a full page reload.
type ActiveMount = {
  surface: HTMLElement;
  deviceId: string | null;
  historyId: string | null;
  timeZone: string;
  generation: number;
  lastBoot: DeadlinePlanBoot | null;
  lastHistory: DeadlinePlanHistoryView | undefined;
};
let activeMount: ActiveMount | null = null;
let runtimeRefreshBound = false;

const renderActiveMount = (): void => {
  const m = activeMount;
  if (!m || !m.lastBoot) return;
  const renderInput = resolveRenderInput({
    bootstrap: m.lastBoot.bootstrap,
    deviceId: m.deviceId,
    devices: m.lastBoot.devicesPayload.devices,
    prices: m.lastBoot.prices,
  });
  renderDeadlinePlan(m.surface, resolveDeadlinePlanLoadState(renderInput, m.lastHistory));
};

export const mountDeadlinePlan = async (): Promise<void> => {
  const surface = document.getElementById('deadline-plan-root');
  if (!surface) return;

  const params = new URLSearchParams(window.location.search);
  const deviceId = params.get('deviceId');
  const historyId = params.get('historyId');
  const timeZone = resolveBrowserTimeZone();
  const generation = (activeMount?.generation ?? 0) + 1;
  activeMount = {
    surface, deviceId, historyId, timeZone, generation, lastBoot: null, lastHistory: undefined,
  };
  const isStale = (): boolean => activeMount?.generation !== generation;

  initDeadlinePlanClose();
  // Bind runtime refresh once per SPA session, *before* any awaitable work,
  // so a failed first boot does not leave the rest of the session without
  // event-driven refresh. The handler reads `activeMount` at fire time so
  // subscribing this early is harmless when no view is open.
  if (!runtimeRefreshBound) {
    runtimeRefreshBound = subscribeToRuntimeRefresh();
  }
  renderDeadlinePlan(surface, { status: 'loading' });

  if (historyId !== null) {
    await mountHistoryDetail(surface, deviceId, historyId, timeZone, isStale);
    return;
  }

  try {
    const boot = await fetchDeadlinePlanBoot();
    if (isStale()) return;
    activeMount.lastBoot = boot;
  } catch (error) {
    if (isStale()) return;
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
  renderActiveMount();

  void fetchDeadlinePlanHistory(deviceId, timeZone).then((history) => {
    if (isStale()) return;
    activeMount!.lastHistory = history;
    renderActiveMount();
  });
};

export const unmountDeadlinePlan = (): void => {
  activeMount = null;
};

// Resubscribe to runtime change events so the panel reflects new plan
// revisions and device updates without a manual reload. Reads the current
// active mount on each tick so re-renders track URL changes after the SPA
// navigates between deadline-plan deep links.
// Returns true iff event subscriptions were installed; lets the caller hold
// off on flipping the `runtimeRefreshBound` latch until the Homey client is
// actually available, so a transient early-mount with no SDK does not silence
// later refreshes for the whole session.
const subscribeToRuntimeRefresh = (): boolean => {
  const homey = getHomeyClient();
  if (!homey || typeof homey.on !== 'function') return false;
  let refreshing = false;
  let refreshQueued = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const refresh = async (): Promise<void> => {
    if (refreshing) {
      refreshQueued = true;
      return;
    }
    if (!activeMount || activeMount.historyId !== null) return;
    refreshing = true;
    try {
      const next = await fetchDeadlinePlanBoot();
      if (!activeMount || activeMount.historyId !== null) return;
      activeMount.lastBoot = next;
      renderActiveMount();
    } catch (error) {
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
  return true;
};
