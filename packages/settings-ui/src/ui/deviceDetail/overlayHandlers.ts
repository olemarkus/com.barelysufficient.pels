import {
  deviceDetailClose,
  deviceDetailDiagnosticsDisclosure,
  deviceDetailOverlay,
  deviceDetailPanel,
  deviceDetailShedAction,
} from '../dom.ts';
import { bindSegmentedToSelect } from '../components.ts';
import { renderDeviceDetailLiveStatus } from './liveStatus.ts';
import {
  isDeviceDetailDiagnosticsExpanded,
  refreshDeviceDetailDiagnostics,
  resetDeviceDetailDiagnosticsRequests,
  showDeviceDetailDiagnosticsLoading,
} from './diagnostics.ts';
import { refreshDeviceDetailActivityLogIfExpanded } from './activityLog.ts';
import type { createPendingDeviceDetailOpen, OpenDeviceDetailDetail } from './focus.ts';
import type { SettingsUiDeviceView } from '../state.ts';

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
  getDeviceById: (deviceId: string) => SettingsUiDeviceView | null;
  openDeviceDetail: (deviceId: string) => void;
  closeDeviceDetail: () => void;
  refreshOpenDeviceDetail: () => void;
  pendingDeviceDetailOpen: ReturnType<typeof createPendingDeviceDetailOpen>;
};

const initDeviceDetailCloseHandlers = (
  ctx: Pick<DeviceDetailOverlayHandlerContext, 'closeDeviceDetail'>,
) => {
  deviceDetailClose?.addEventListener('click', ctx.closeDeviceDetail);
  deviceDetailOverlay?.addEventListener('click', (event) => {
    if (event.target === deviceDetailOverlay) {
      ctx.closeDeviceDetail();
    }
  });
};

// md-switch only flips when the user hits the small thumb. Restore the
// legacy whole-row tap behavior by toggling the switch when its label
// area is clicked.
const initDeviceDetailSwitchRowClick = () => {
  if (!deviceDetailPanel) return;
  deviceDetailPanel.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const row = target.closest<HTMLElement>('.md-switch-row');
    if (!row) return;
    // The user already interacted with the switch itself or an inner
    // focusable element — let the native behavior handle it.
    if (target.closest('md-switch, a, button, input, select, textarea')) return;
    const swEl = row.querySelector('md-switch') as
      | (HTMLElement & { selected: boolean; disabled: boolean })
      | null;
    if (!swEl || swEl.disabled) return;
    swEl.selected = !swEl.selected;
    swEl.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const initDeviceDetailEscapeHandler = (
  ctx: Pick<DeviceDetailOverlayHandlerContext, 'closeDeviceDetail'>,
) => {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && deviceDetailOverlay && !deviceDetailOverlay.hidden) {
      ctx.closeDeviceDetail();
    }
  });
};

const initDeviceDetailOpenHandler = (ctx: DeviceDetailOverlayHandlerContext) => {
  document.addEventListener('open-device-detail', (event) => {
    const custom = event as CustomEvent<OpenDeviceDetailDetail>;
    const deviceId = custom.detail?.deviceId;
    if (!deviceId) return;

    if (ctx.getDeviceById(deviceId)) {
      ctx.openDeviceDetail(deviceId);
    } else {
      ctx.pendingDeviceDetailOpen.set(deviceId);
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
    void refreshDeviceDetailDiagnostics({
      deviceId,
      isCurrentDevice: () => (
        ctx.getCurrentDetailDeviceId() === deviceId && isDeviceDetailDiagnosticsExpanded()
      ),
    });
  });
};

const initDeviceDetailRefreshHandlers = (ctx: DeviceDetailOverlayHandlerContext) => {
  document.addEventListener('devices-updated', () => {
    // Only consume the queued open request once its device is actually present:
    // a `devices-updated` can fire while the requested device is still absent
    // (partial list / unrelated change), and taking it unconditionally would
    // drop the request before the device ever loads. Leave it queued for a later
    // `devices-updated` instead.
    const pending = ctx.pendingDeviceDetailOpen.peek();
    if (pending && ctx.getDeviceById(pending.deviceId)) {
      ctx.pendingDeviceDetailOpen.take();
      ctx.openDeviceDetail(pending.deviceId);
      return;
    }
    // A pending open whose device hasn't loaded yet stays queued for a later
    // `devices-updated` — but must NOT block refreshing a currently-open detail
    // below (an absent pending request would otherwise freeze the open pane).
    const deviceId = ctx.getCurrentDetailDeviceId();
    if (!deviceId) return;

    ctx.refreshOpenDeviceDetail();
    if (!isDeviceDetailDiagnosticsExpanded()) return;
    void refreshDeviceDetailDiagnostics({
      deviceId,
      isCurrentDevice: () => (
        ctx.getCurrentDetailDeviceId() === deviceId && isDeviceDetailDiagnosticsExpanded()
      ),
    });
  });

  document.addEventListener('plan-updated', () => {
    const deviceId = ctx.getCurrentDetailDeviceId();
    if (!deviceId) return;

    // The live-status row tracks every plan push while the overlay is open.
    void renderDeviceDetailLiveStatus(deviceId);
    if (isDeviceDetailDiagnosticsExpanded()) {
      void refreshDeviceDetailDiagnostics({
        deviceId,
        isCurrentDevice: () => (
          ctx.getCurrentDetailDeviceId() === deviceId && isDeviceDetailDiagnosticsExpanded()
        ),
      });
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
  ctx: Pick<DeviceDetailOverlayHandlerContext, 'closeDeviceDetail'>,
) => {
  initDeviceDetailCloseHandlers(ctx);
  initDeviceDetailSwitchRowClick();
  initOvershootSegmented();
};

/** Escape, deferred open requests, and the diagnostics/plan/device repaints. */
export const initDeviceDetailOverlaySubscriptions = (ctx: DeviceDetailOverlayHandlerContext) => {
  initDeviceDetailDiagnosticsHandler(ctx);
  initDeviceDetailEscapeHandler(ctx);
  initDeviceDetailOpenHandler(ctx);
  initDeviceDetailRefreshHandlers(ctx);
};
