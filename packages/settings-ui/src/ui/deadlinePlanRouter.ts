import { isDeadlinePlanRoute } from './deadlineUrls.ts';
import { setActiveTabIndicator, showTab } from './realtime.ts';

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

const hideDeadlinePlanPanel = (fallbackTab: string): void => {
  showTab(fallbackTab);
};

type CloseOptions = {
  // Optional override for which shell tab to land on after the deadline-plan
  // view closes. Defaults to 'deadlines'. Used by the cannot-finish recourse
  // action row so e.g. "Open Budget" closes the plan and lands the user on
  // the Budget tab in a single click — without a race against the popstate
  // handler that the prior "close then showTab(target)" flow lost to.
  fallbackTab?: string;
  // Optional callback fired after the close path has settled (popstate has
  // fired on the history-back branch, or synchronously on the replaceState
  // branch). The history-detail "Review device" recourse uses this to defer
  // the `open-device-detail` dispatch until *after* the view has unmounted —
  // dispatching synchronously raced popstate and only worked by luck of the
  // overlay's z-index. See `deadlinePlanMount.ts` recourse dispatcher.
  onSettled?: () => void;
};

type RouterDeps = {
  mount: () => Promise<void>;
  unmount: () => void;
  setCloseHandler: (handler: (options?: CloseOptions) => void) => void;
};

export const initDeadlinePlanRouter = (deps: RouterDeps): void => {
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

  const closeView = (options?: CloseOptions): void => {
    const fallbackTab = options?.fallbackTab ?? 'deadlines';
    if (openedViaPushState && window.history.length > 1) {
      pendingFallbackTab = fallbackTab;
      pendingOnSettled = options?.onSettled ?? null;
      window.history.back();
      return;
    }
    // Replace the deadline-plan URL with the Smart tasks list so reload /
    // history-back lands on a coherent surface instead of re-opening the
    // closed plan.
    window.history.replaceState(null, '', './');
    deps.unmount();
    // Clear `panelVisible` *before* `hideDeadlinePlanPanel` runs `showTab`,
    // which dispatches `pels:tab-shown`. The router's own tab-shown listener
    // (see below) reads `panelVisible` and would otherwise re-run unmount on
    // its own — harmless but redundant. Same reasoning in `applyRouteFromUrl`.
    panelVisible = false;
    openedViaPushState = false;
    hideDeadlinePlanPanel(fallbackTab);
    options?.onSettled?.();
  };
  deps.setCloseHandler(closeView);

  const applyRouteFromUrl = (): void => {
    if (isDeadlinePlanRoute(window.location.search)) {
      showDeadlinePlanPanel();
      panelVisible = true;
      pendingFallbackTab = null;
      void deps.mount();
      return;
    }
    // Non-deadline-plan URL. Only intervene if we were previously on the
    // deadline-plan view — otherwise the boot path's initial tab choice
    // would be overwritten.
    if (panelVisible) {
      // Clear `panelVisible` before the inner `showTab` runs (see `closeView`
      // comment) so the tab-shown listener doesn't re-enter unmount.
      panelVisible = false;
      hideDeadlinePlanPanel(pendingFallbackTab ?? 'deadlines');
    }
    pendingFallbackTab = null;
    deps.unmount();
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
  // from Overview and now want to jump straight to Budget), `showTab` hides
  // the deadline-plan panel and lights up the chosen tab — but the URL still
  // carries `?page=deadline-plan&…`, so a reload would re-open the closed
  // plan. Mirror `closeView`'s replaceState path: drop the deadline-plan URL,
  // unmount the React tree, and reset the in-memory state. We don't re-apply
  // `setActiveTabIndicator` here because `showTab` already lit the right tab.
  document.addEventListener('pels:tab-shown', () => {
    if (!panelVisible) return;
    panelVisible = false;
    pendingFallbackTab = null;
    pendingOnSettled = null;
    openedViaPushState = false;
    if (isDeadlinePlanRoute(window.location.search)) {
      window.history.replaceState(null, '', './');
    }
    deps.unmount();
  });

  applyRouteFromUrl();
};
