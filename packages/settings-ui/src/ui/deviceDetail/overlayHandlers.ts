import {
  deviceDetailClose,
  deviceDetailDiagnosticsDisclosure,
  deviceDetailOverlay,
  deviceDetailShedAction,
} from '../dom.ts';
import { bindSegmentedToSelect } from '../components.ts';
import { renderDeviceDetailLiveStatus } from './liveStatus.ts';
import { renderDeviceTemporaryCard } from './temporaryCard.ts';
import {
  isDeviceDetailDiagnosticsExpanded,
  refreshDeviceDetailDiagnostics,
  resetDeviceDetailDiagnosticsRequests,
  showDeviceDetailDiagnosticsLoading,
} from './diagnostics.ts';
import { refreshDeviceDetailActivityLogIfExpanded } from './activityLog.ts';
import type { createPendingDeviceDetailOpen, DeviceDetailFocus, OpenDeviceDetailDetail } from './focus.ts';
import { buildDeadlineHref, followDeadlineHref, isDeadlinePlanRoute } from '../deadlineUrls.ts';
import { dispatchOpenSmartTaskCreate } from '../smartTaskCreate.ts';
import { findLatestDevice, state } from '../state.ts';
import { showPendingSteppedLoadReminder } from './steppedLoadFlowSetup.ts';


/**
 * The device-detail overlay's DOM subscriptions: close/escape/backdrop, the
 * whole-row switch tap, the deferred `open-device-detail` request, and the
 * `devices-updated` / `plan-updated` repaints. Split out of `deviceDetail`'s
 * `index.ts` so that file owns the pane's state and rendering while these stay
 * a flat list of listeners.
 *
 * Follows the sibling `init*Handlers({ … })` context convention already used by
 * `nativeWiring.ts`, `priceOpt.ts` and `budgetExempt.ts`. The two entry points
 * keep the original registration positions: chrome first, subscriptions last.
 */
export type DeviceDetailOverlayHandlerContext = {
  getCurrentDetailDeviceId: () => string | null;
  openDeviceDetailAt: (deviceId: string, focus: DeviceDetailFocus) => void;
  closeDeviceDetail: () => void;
  refreshOpenDeviceDetail: () => void;
  pendingDeviceDetailOpen: ReturnType<typeof createPendingDeviceDetailOpen>;
};

// ─── Android back integration ────────────────────────────────────────────────
// The overlay pushes one history entry when it opens, so the platform back
// gesture closes the panel instead of exiting the WebView. UI close paths
// consume that entry via history.back() and let the popstate handler do the
// actual close; a close with no live entry (device disappeared mid-session)
// falls through to a direct close, and the stale entry later pops as a no-op
// because the handler ignores popstate while the overlay is hidden. The URL is
// unchanged by the push, so the deadline-plan router's own popstate handling
// sees no route change.
let historyEntryActive = false;
// One history.back() may be in flight before its popstate lands; a second
// close request in that window (Escape autorepeat, double-tap) must not pop a
// REAL history entry underneath the overlay's own.
let closeRequestInFlight = false;

export const noteDeviceDetailOpened = (): void => {
  if (historyEntryActive) return;
  historyEntryActive = true;
  window.history.pushState({ pelsDeviceDetail: true }, '', window.location.href);
};

type DeviceDetailDismissContext = Pick<
  DeviceDetailOverlayHandlerContext,
  'closeDeviceDetail' | 'getCurrentDetailDeviceId'
>;

const dismissDeviceDetail = (ctx: DeviceDetailDismissContext): void => {
  const deviceId = ctx.getCurrentDetailDeviceId();
  const device = deviceId ? findLatestDevice(deviceId) : undefined;
  ctx.closeDeviceDetail();
  if (device) showPendingSteppedLoadReminder(device);
};

const requestDeviceDetailClose = (ctx: DeviceDetailDismissContext): void => {
  if (closeRequestInFlight) return;
  if (historyEntryActive) {
    closeRequestInFlight = true;
    window.history.back();
    return;
  }
  dismissDeviceDetail(ctx);
};

const initDeviceDetailHistoryHandler = (
  ctx: DeviceDetailDismissContext,
) => {
  window.addEventListener('popstate', () => {
    if (!historyEntryActive) return;
    historyEntryActive = false;
    closeRequestInFlight = false;
    if (deviceDetailOverlay && !deviceDetailOverlay.hidden) {
      dismissDeviceDetail(ctx);
    }
  });
  // A close that did not go through Back (a flow that leaves the overlay for
  // another page) leaves its entry behind as a no-op. The overlay no longer
  // owns it: the next open pushes its own entry, so its close never pops a
  // page entry pushed since (the shell router gives every page one).
  document.addEventListener('device-detail-closed', () => {
    if (closeRequestInFlight) return;
    historyEntryActive = false;
  });
};


const initDeviceDetailCloseHandlers = (
  ctx: DeviceDetailDismissContext,
) => {
  deviceDetailClose?.addEventListener('click', () => requestDeviceDetailClose(ctx));
  deviceDetailOverlay?.addEventListener('click', (event) => {
    if (event.target === deviceDetailOverlay) {
      requestDeviceDetailClose(ctx);
    }
  });
};

const initDeviceDetailEscapeHandler = (
  ctx: DeviceDetailDismissContext,
) => {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && deviceDetailOverlay && !deviceDetailOverlay.hidden) {
      requestDeviceDetailClose(ctx);
    }
  });
};

// The tab Back returns to from the New smart task flow. A device page opened
// over a task page belongs to Smart tasks: the task page's route is gone by the
// time the flow closes, and the task page is a route, not a tab of its own.
const resolveCreateSourceTab = (): string => (
  isDeadlinePlanRoute(window.location.search) ? 'deadlines' : state.activePanel
);

const initDeviceDetailSmartTaskChipHandler = (
  ctx: Pick<DeviceDetailOverlayHandlerContext, 'closeDeviceDetail'>,
) => {
  document.getElementById('device-detail-temporary')?.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const create = event.target.closest<HTMLElement>('[data-smart-task-create]');
    if (create?.dataset.smartTaskCreate) {
      const deviceId = create.dataset.smartTaskCreate;
      ctx.closeDeviceDetail();
      dispatchOpenSmartTaskCreate(deviceId, resolveCreateSourceTab());
      return;
    }
    const view = event.target.closest<HTMLElement>('[data-smart-task-view]');
    if (!view?.dataset.smartTaskView) return;
    // Mount the plan page first, then close the overlay so the page the user
    // asked for is visible. No history.back(): the plan entry now sits on top,
    // and the overlay's own entry pops later as a no-op.
    followDeadlineHref(buildDeadlineHref(view.dataset.smartTaskView));
    ctx.closeDeviceDetail();
  });
};

const initDeviceDetailOpenHandler = (ctx: DeviceDetailOverlayHandlerContext) => {
  document.addEventListener('open-device-detail', (event) => {
    const { deviceId, focus } = (event as CustomEvent<OpenDeviceDetailDetail>).detail;

    if (findLatestDevice(deviceId)) {
      ctx.openDeviceDetailAt(deviceId, focus);
    } else {
      ctx.pendingDeviceDetailOpen.set({ deviceId, focus });
      document.dispatchEvent(new CustomEvent('request-load-devices'));
    }
  });
};

const initDeviceDetailDiagnosticsHandler = (ctx: DeviceDetailOverlayHandlerContext) => {
  deviceDetailDiagnosticsDisclosure?.addEventListener('toggle', () => {
    const deviceId = ctx.getCurrentDetailDeviceId();
    if (!deviceId) return;
    if (!isDeviceDetailDiagnosticsExpanded()) {
      resetDeviceDetailDiagnosticsRequests();
      return;
    }

    showDeviceDetailDiagnosticsLoading();
    void refreshDeviceDetailDiagnostics(deviceId, () => (
      ctx.getCurrentDetailDeviceId() === deviceId && isDeviceDetailDiagnosticsExpanded()
    ));
  });
};

const initDeviceDetailRefreshHandlers = (ctx: DeviceDetailOverlayHandlerContext) => {
  document.addEventListener('deferred-objectives-updated', () => {
    if (ctx.getCurrentDetailDeviceId() !== null) ctx.refreshOpenDeviceDetail();
  });
  document.addEventListener('devices-updated', () => {
    // Only consume the queued open request once its device is actually present:
    // a `devices-updated` can fire while the requested device is still absent
    // (partial list / unrelated change), and taking it unconditionally would
    // drop the request before the device ever loads. Leave it queued for a later
    // `devices-updated` instead.
    const pending = ctx.pendingDeviceDetailOpen.peek();
    if (pending && findLatestDevice(pending.deviceId)) {
      ctx.pendingDeviceDetailOpen.take();
      ctx.openDeviceDetailAt(pending.deviceId, pending.focus);
      return;
    }
    // A pending open whose device hasn't loaded yet stays queued for a later
    // `devices-updated` — but must NOT block refreshing a currently-open detail
    // below (an absent pending request would otherwise freeze the open pane).
    const deviceId = ctx.getCurrentDetailDeviceId();
    if (!deviceId) return;

    ctx.refreshOpenDeviceDetail();
    if (!isDeviceDetailDiagnosticsExpanded()) return;
    void refreshDeviceDetailDiagnostics(deviceId, () => (
      ctx.getCurrentDetailDeviceId() === deviceId && isDeviceDetailDiagnosticsExpanded()
    ));
  });

  document.addEventListener('plan-updated', () => {
    const deviceId = ctx.getCurrentDetailDeviceId();
    if (!deviceId) return;

    // The live-status row tracks every plan push while the overlay is open.
    void renderDeviceDetailLiveStatus(deviceId);
    renderDeviceTemporaryCard(deviceId);
    if (isDeviceDetailDiagnosticsExpanded()) {
      void refreshDeviceDetailDiagnostics(deviceId, () => (
        ctx.getCurrentDetailDeviceId() === deviceId && isDeviceDetailDiagnosticsExpanded()
      ));
    }
    refreshDeviceDetailActivityLogIfExpanded(deviceId, ctx.getCurrentDetailDeviceId);
  });
};

const initOvershootSegmented = () => {
  const container = document.getElementById('device-detail-overshoot-segmented');
  if (!container || !deviceDetailShedAction) return;
  bindSegmentedToSelect({ container, select: deviceDetailShedAction });
};

/** Close/backdrop, whole-row switch tap, and the overshoot segmented control. */
export const initDeviceDetailOverlayChrome = (
  ctx: DeviceDetailDismissContext,
) => {
  initDeviceDetailCloseHandlers(ctx);
  initDeviceDetailHistoryHandler(ctx);
  initDeviceDetailSmartTaskChipHandler(ctx);
  initOvershootSegmented();
};

/** Escape, deferred open requests, and the diagnostics/plan/device repaints. */
export const initDeviceDetailOverlaySubscriptions = (ctx: DeviceDetailOverlayHandlerContext) => {
  initDeviceDetailDiagnosticsHandler(ctx);
  initDeviceDetailEscapeHandler(ctx);
  initDeviceDetailOpenHandler(ctx);
  initDeviceDetailRefreshHandlers(ctx);
};
