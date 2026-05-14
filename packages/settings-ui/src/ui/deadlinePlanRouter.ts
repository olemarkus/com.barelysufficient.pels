import { isDeadlinePlanRoute } from './deadlineUrls.ts';
import { showTab } from './realtime.ts';

const SHELL_NAV_ID = 'shell-nav';
const PANEL_ID = 'deadline-plan-panel';

// Top-of-shell navigation is hidden while the deadline-plan view is open.
// The view fills the screen with its own close affordance; keeping the
// section tabs visible would invite the user to swap tabs without the SPA
// having any panel to show, and would also make the close button confusing.
const setShellNavVisible = (visible: boolean): void => {
  const nav = document.getElementById(SHELL_NAV_ID);
  if (!nav) return;
  nav.classList.toggle('hidden', !visible);
};

const showDeadlinePlanPanel = (): void => {
  document.querySelectorAll<HTMLElement>('[data-panel]').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== PANEL_ID);
  });
  setShellNavVisible(false);
};

const hideDeadlinePlanPanel = (fallbackTab: string): void => {
  setShellNavVisible(true);
  showTab(fallbackTab);
};

type RouterDeps = {
  mount: () => Promise<void>;
  unmount: () => void;
  setCloseHandler: (handler: () => void) => void;
};

export const initDeadlinePlanRouter = (deps: RouterDeps): void => {
  let openedViaPushState = false;
  // Whether the panel is currently mounted/visible. Used so we only force a
  // tab restore on transitions *out of* the deadline-plan view; the boot
  // path lands here with a non-deadline URL and we must not steal the
  // tab choice that `initializeBootHandlers` already made.
  let panelVisible = false;

  const closeView = (): void => {
    if (openedViaPushState && window.history.length > 1) {
      window.history.back();
      return;
    }
    // Replace the deadline-plan URL with the Smart tasks list so reload /
    // history-back lands on a coherent surface instead of re-opening the
    // closed plan.
    window.history.replaceState(null, '', './');
    deps.unmount();
    hideDeadlinePlanPanel('deadlines');
    panelVisible = false;
    openedViaPushState = false;
  };
  deps.setCloseHandler(closeView);

  const applyRouteFromUrl = (): void => {
    if (isDeadlinePlanRoute(window.location.search)) {
      showDeadlinePlanPanel();
      panelVisible = true;
      void deps.mount();
      return;
    }
    // Non-deadline-plan URL. Only intervene if we were previously on the
    // deadline-plan view — otherwise the boot path's initial tab choice
    // would be overwritten.
    if (panelVisible) {
      hideDeadlinePlanPanel('deadlines');
      panelVisible = false;
    }
    deps.unmount();
    openedViaPushState = false;
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
  // the Homey SDK injection and break every API call.
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
  });

  window.addEventListener('popstate', () => {
    applyRouteFromUrl();
  });

  applyRouteFromUrl();
};
