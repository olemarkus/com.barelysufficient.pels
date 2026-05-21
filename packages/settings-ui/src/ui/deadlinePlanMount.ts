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
  SMART_TASK_USAGE_RETURN_CONTEXT,
  SMART_TASK_USAGE_RETURN_LABEL,
} from '../../../shared-domain/src/deadlineLabels.ts';
import {
  fetchDeadlinePlanHistory,
  resolveBrowserTimeZone,
  type DeadlinePlanHistoryView,
} from './deadlinePlanHistoryFetch.ts';
import { renderDeadlinePlan } from './views/DeadlinePlan.tsx';
import { resolveDeadlinePlanLoadState, resolveRenderInput } from './deadlinePlan.ts';
import { logSettingsError } from './logging.ts';
import type { MdButtonElement } from './dom.ts';
import { showUsageReturnLink } from './usageReturnLink.ts';

const describeError = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  try { return JSON.stringify(error); } catch { return String(error); }
};

const buildBootErrorMessage = (error: unknown): string => (
  `Smart task data could not be loaded: ${describeError(error)}`
);

const DEADLINE_PLAN_REFRESH_DEBOUNCE_MS = 200;

// Optional override for the shell tab the deadline-plan view lands on when
// it closes. `closeView` in `deadlinePlanRouter.ts` reads this so the
// recourse-action row (e.g. "Open Budget") can land the user on Budget
// directly in a single click — without racing the popstate handler that
// would have re-shown the Smart-tasks tab. `onSettled` fires after the
// close path has settled (popstate handled on the history-back branch,
// inline on the replaceState branch) so the history-detail recourse can
// open the device-detail overlay *after* the view has unmounted.
export type DeadlinePlanCloseOptions = {
  fallbackTab?: string;
  onSettled?: () => void;
};

// Resolved by `boot.ts` so the close button can return to whichever tab the
// user came from (almost always Smart tasks). Kept as a module-local instead
// of a parameter on `mountDeadlinePlan` so the close button stays bound across
// the SPA's lifetime even when the deadline-plan view is re-mounted.
let onCloseDeadlinePlan: (options?: DeadlinePlanCloseOptions) => void = () => {};

export const setDeadlinePlanCloseHandler = (
  handler: (options?: DeadlinePlanCloseOptions) => void,
): void => {
  onCloseDeadlinePlan = handler;
};

const initDeadlinePlanClose = (): void => {
  const button = document.querySelector<MdButtonElement>('[data-deadline-plan-close]');
  if (!button || button.dataset.deadlinePlanCloseBound === 'true') return;
  button.dataset.deadlinePlanCloseBound = 'true';
  button.addEventListener('click', () => onCloseDeadlinePlan());
};

// Delegated click handler for the cannot-finish hero's recourse action row.
// The button carries `data-deadline-recourse-tab="<tabId>"`; clicking it
// closes the deadline-plan view (history-back / replace-state, shell-nav
// restore) and lands on the requested shell tab — Budget for the daily-cap
// cause, Overview for device-side ones. The close handler honours the
// `fallbackTab` option so a single user click flows through the router in
// one pass; the prior "close then showTab" sequence raced popstate and
// lost the target on the history-back path. Bound once on the document so
// we don't need to re-bind after each render of the deadline-plan view.
//
// When the button also carries `data-deadline-recourse-device-id="<id>"`
// (history-detail "Review device" recourse), dispatch the
// `open-device-detail` custom event *after* the close path has settled so
// the device-settings overlay opens in a single click without racing the
// router's popstate. Owner walk 2026-05-17 flagged the prior dead-end
// button; the prior fix dispatched synchronously and only worked by luck of
// z-index ordering. The overlay layers on top of any tab, so landing on
// Overview first keeps the back-stack sensible if the user dismisses the
// overlay.
let recourseHandlerBound = false;
const initDeadlinePlanRecourseDispatcher = (): void => {
  if (recourseHandlerBound) return;
  recourseHandlerBound = true;
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const trigger = event.target.closest<HTMLElement>('[data-deadline-recourse-tab]');
    if (!trigger) return;
    const targetTab = trigger.dataset.deadlineRecourseTab;
    if (!targetTab) return;
    event.preventDefault();
    const deviceId = trigger.dataset.deadlineRecourseDeviceId;
    const onSettled = (deviceId !== undefined && deviceId.length > 0)
      ? () => {
        document.dispatchEvent(new CustomEvent('open-device-detail', { detail: { deviceId } }));
      }
      : undefined;
    onCloseDeadlinePlan({ fallbackTab: targetTab, onSettled });
  });
};

// Delegated click handler for the smart-task history-detail Usage cross-link.
// The anchor carries `data-deadline-usage-link="<deviceId>"` and is intercepted
// here so the SPA closes the deadline-plan view and lands on the Usage tab in
// a single transition — same close-with-fallback flow as the recourse buttons.
// Usage is household-scoped today, so this also arms an explicit return link
// before leaving the Smart-task detail instead of implying a device filter.
let usageLinkHandlerBound = false;
const initDeadlinePlanUsageLinkDispatcher = (): void => {
  if (usageLinkHandlerBound) return;
  usageLinkHandlerBound = true;
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.defaultPrevented || (event as MouseEvent).button !== 0) return;
    if ((event as MouseEvent).metaKey || (event as MouseEvent).ctrlKey
      || (event as MouseEvent).shiftKey || (event as MouseEvent).altKey) return;
    const trigger = event.target.closest<HTMLElement>('[data-deadline-usage-link]');
    if (!trigger) return;
    event.preventDefault();
    const currentUrl = new URL(window.location.href);
    showUsageReturnLink({
      href: `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`,
      label: trigger.dataset.deadlineUsageReturnLabel ?? SMART_TASK_USAGE_RETURN_LABEL,
      context: trigger.dataset.deadlineUsageReturnContext ?? SMART_TASK_USAGE_RETURN_CONTEXT,
    });
    onCloseDeadlinePlan({ fallbackTab: 'usage' });
  });
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
  initDeadlinePlanRecourseDispatcher();
  initDeadlinePlanUsageLinkDispatcher();
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
