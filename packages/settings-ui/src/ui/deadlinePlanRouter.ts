import { isDeadlinePlanRoute } from './deadlineUrls.ts';
import { setActiveTabIndicator } from './realtime.ts';
import { initialShellPanel, renderPanel, replaceTab } from './tabNavigation.ts';
import { isShellPanel, shellRouteUrl } from './shellRoutes.ts';
import {
  mountDeadlinePlan,
  setDeadlinePlanCloseHandler,
  unmountDeadlinePlan,
  type DeadlinePlanCloseOptions,
} from './deadlinePlanMount.ts';

const PANEL_ID = 'deadline-plan-panel';
// Shell-nav tab id for the Smart tasks section. The deadline-plan view is a
// sibling panel of the Smart tasks list panel, so the shell-nav indicator
// lights up the same tab while the deep-linked plan-detail is visible. Keeps
// the breadcrumb honest — a user who arrived via an Overview device-card chip
// can see they're now under "Smart tasks", not still on "Overview".
const DEADLINE_PLAN_TAB_ID = 'deadlines';

const showDeadlinePlanPanel = (): void => {
  document.querySelectorAll<HTMLElement>('[data-panel]').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== PANEL_ID);
  });
  // Light the Smart tasks shell-nav tab even though the visible panel is
  // `#deadline-plan-panel` (not `#deadlines-panel`). Calling `showTab` here
  // would hide the deadline-plan panel a moment later, so we use the
  // indicator-only helper.
  setActiveTabIndicator(DEADLINE_PLAN_TAB_ID);
};

// The closed plan's history entry becomes the fallback tab's, so the plan is
// not one Back away and reload lands on that tab.
const hideDeadlinePlanPanel = (fallbackTab: string): void => {
  replaceTab(fallbackTab);
};

export const initDeadlinePlanRouter = (): void => {
  let openedViaPushState = false;
  // Whether the panel is currently mounted/visible. Used so we only force a
  // tab restore on transitions *out of* the deadline-plan view; the boot
  // path lands here with a non-deadline URL and we must not steal the
  // tab choice that `initializeBootHandlers` already made.
  let panelVisible = false;
  // Pending fallback tab set by `closeView` when it routes through
  // `history.back()`. The popstate handler reads this so the popstate path
  // honours the recourse-target override instead of always landing on the
  // Smart-tasks tab. Cleared after every `applyRouteFromUrl` so a back
  // navigation that wasn't triggered by `closeView` doesn't pick up a stale
  // target.
  let pendingFallbackTab: string | null = null;
  // Pending settled-callback set by `closeView` when it routes through
  // `history.back()`. Invoked from `applyRouteFromUrl` once popstate has
  // fired and the route has actually been applied, so callers can sequence
  // post-close work (e.g. opening an overlay) without racing popstate. The
  // synchronous replaceState branch invokes the callback inline.
  let pendingOnSettled: (() => void) | null = null;

  const closeView = (options?: DeadlinePlanCloseOptions): void => {
    const fallbackTab = options?.fallbackTab ?? 'deadlines';
    if (openedViaPushState && window.history.length > 1) {
      pendingFallbackTab = fallbackTab;
      pendingOnSettled = options?.onSettled ?? null;
      window.history.back();
      return;
    }
    // `hideDeadlinePlanPanel` replaces the deadline-plan URL with the fallback
    // tab's, so reload / history-back lands on a coherent surface instead of
    // re-opening the closed plan.
    unmountDeadlinePlan();
    // Clear `panelVisible` *before* `hideDeadlinePlanPanel` runs `showTab`,
    // which dispatches `pels:tab-shown`. The router's own tab-shown listener
    // (see below) reads `panelVisible` and would otherwise re-run unmount on
    // its own — harmless but redundant. Same reasoning in `applyRouteFromUrl`.
    panelVisible = false;
    openedViaPushState = false;
    hideDeadlinePlanPanel(fallbackTab);
    options?.onSettled?.();
  };
  setDeadlinePlanCloseHandler(closeView);

  const applyRouteFromUrl = (): void => {
    if (isDeadlinePlanRoute(window.location.search)) {
      showDeadlinePlanPanel();
      panelVisible = true;
      pendingFallbackTab = null;
      void mountDeadlinePlan();
      return;
    }
    // Non-deadline-plan URL. Only intervene if we were previously on the
    // deadline-plan view — otherwise the boot path's initial tab choice
    // would be overwritten.
    if (panelVisible) {
      // Clear `panelVisible` before the panel switch runs (see `closeView`
      // comment) so the tab-shown listener doesn't re-enter unmount. The close
      // button names where it lands; a plain Back shows the page it went
      // back to.
      panelVisible = false;
      if (pendingFallbackTab) hideDeadlinePlanPanel(pendingFallbackTab);
      else renderPanel(initialShellPanel());
    }
    pendingFallbackTab = null;
    unmountDeadlinePlan();
    openedViaPushState = false;
    // Fire after unmount + tab switch so the callback observes the settled
    // post-close DOM state (overlay opens cleanly on top of the target tab).
    const settled = pendingOnSettled;
    pendingOnSettled = null;
    settled?.();
  };

  // Find a SPA-route anchor in the event's composed path. `closest('a[href]')`
  // on `event.target` misses links that live inside a shadow-DOM tree (the
  // event target outside the shadow is the host, not the anchor); walking the
  // composed path catches both light-DOM and shadow-DOM anchors.
  const findRouteAnchor = (event: MouseEvent): HTMLAnchorElement | null => {
    const composed = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const node of composed) {
      if (node instanceof HTMLAnchorElement && node.hasAttribute('href')) return node;
    }
    if (event.target instanceof Element) {
      return event.target.closest<HTMLAnchorElement>('a[href]');
    }
    return null;
  };

  // Intercept anchor navigations to the SPA route so the deadline plan opens
  // in-place. Full-document navigation (Homey mobile WebView) would discard
  // the Homey SDK injection and break every API call — leaving the deep-linked
  // page stuck on "Loading" forever.
  //
  // Bound in the CAPTURE phase, not bubble. The Overview device-card
  // smart-task chip (`PlanDeviceCards.tsx`) calls `event.stopPropagation()` in
  // its own bubble-phase handler to keep the click from reaching the parent
  // card's "open device details" activation. A bubble-phase listener here
  // never sees that click — the chip stops it one level below `document` — so
  // the `<a href>` falls through to a real navigation and the page hangs.
  // Capturing means we run before the chip's `stopPropagation`, call
  // `preventDefault()`, and route in-place; the chip's later stopPropagation
  // still suppresses the card activation as intended.
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = findRouteAnchor(event);
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href) return;
    // Resolve relative hrefs against the current document so both
    // `./?page=…` and `?page=…` work the same way.
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return;
    if (!isDeadlinePlanRoute(url.search)) return;
    event.preventDefault();
    const target = `${url.pathname}${url.search}${url.hash}`;
    window.history.pushState(null, '', target);
    openedViaPushState = true;
    applyRouteFromUrl();
  }, true);

  window.addEventListener('popstate', () => {
    applyRouteFromUrl();
  });

  // Listen for shell-nav tab activations. When the user clicks a tab while
  // the plan-detail panel is visible (e.g. they followed a smart-task chip
  // from Overview and now want to jump straight to Budget), `showTab` gives
  // the chosen tab its own history entry and URL, hides the deadline-plan
  // panel and lights up the chosen tab. Unmount the React tree and reset the
  // in-memory state. A panel shown without navigating (a renderer call) can
  // leave `?page=deadline-plan&…` in place, so a reload would re-open the
  // closed plan: give that entry the shown panel's URL instead.
  document.addEventListener('pels:tab-shown', (event) => {
    if (!panelVisible) return;
    panelVisible = false;
    pendingFallbackTab = null;
    pendingOnSettled = null;
    openedViaPushState = false;
    const tabId = (event as CustomEvent<{ tabId?: string }>).detail?.tabId;
    if (isDeadlinePlanRoute(window.location.search) && typeof tabId === 'string' && isShellPanel(tabId)) {
      window.history.replaceState(window.history.state, '', shellRouteUrl(tabId, window.location));
    }
    unmountDeadlinePlan();
  });

  applyRouteFromUrl();
};
