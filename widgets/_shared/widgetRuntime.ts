// Shared widget runtime. The five widgets (headroom, plan_budget, smart_tasks,
// create_smart_task, starvation_rescue) each render a different surface, but the
// host-integration scaffolding around them is identical: the Homey-client
// bootstrap handshake, the preview-theme toggle, the controller shape, and (for
// the polling widgets) a race-guarded refresh loop with a visibility reload and
// a teardown that survives an in-flight load.
//
// Browser-safe: this module imports nothing from the app runtime (lib/, setup/,
// flowCards/, drivers/) — it is bundled into each widget's `public/index.js`
// IIFE and runs inside Homey's widget WebView. dependency-cruiser forbids a
// widget → runtime edge; widget → widgets/_shared is allowed.

// The browser `Window` the widget runs in, plus the two globals the Homey widget
// bridge attaches. Widgets that read the `ResizeObserver` constructor off the
// window intersect this with their own `{ ResizeObserver?: ... }` shape.
export type WidgetWindowBase = Window & {
  Homey?: unknown;
  onHomeyReady?: (homey: never) => void;
};

// The Homey widget API client. Each widget narrows `api` to its own
// method/path/body/return contract and adds the optional capabilities it uses
// (`ready`, `setHeight`, `getSettings`); only `api` is universal.
export type WidgetHomeyBase = {
  api: (method: string, path: string, body?: unknown) => Promise<unknown>;
  ready?: () => void;
};

// Every widget's controller exposes exactly this surface. `bootstrap` wires the
// (possibly null, in preview/harness) Homey client; `destroy` tears the widget
// down; `loadAndRender` performs one load+paint cycle (also re-exposed for tests).
export type WidgetController<THomey> = {
  bootstrap: (homey: THomey | null) => void;
  destroy: () => void;
  loadAndRender: () => Promise<void>;
};

// Apply the design-preview theme override. Honoured only via the URL `theme`
// param the preview/harness sets — a real Homey boot leaves the body class
// untouched and the host stylesheet drives light/dark. Identical across widgets.
export const applyPreviewTheme = (
  widgetDocument: Document,
  searchParams: URLSearchParams,
): void => {
  const theme = searchParams.get('theme');
  if (theme === 'dark') {
    widgetDocument.body.classList.add('homey-dark-mode');
  } else if (theme === 'light') {
    widgetDocument.body.classList.remove('homey-dark-mode');
  }
};

// A periodic-refresh loop with a regain-visibility reload and a teardown that is
// safe against an in-flight load. This is the live-correctness hazard the shared
// module exists to consolidate: `start()` (re)arms a single interval that calls
// `onTick`, and `bindVisibility()` reloads when the document becomes visible
// again (mobile dashboards background the WebView). `stop()` clears the interval
// and unbinds the listener; it is idempotent and the bound flags ensure repeated
// `start()`/`bindVisibility()` never leak a second timer or listener.
//
// The DESTROYED FLAG lives in the caller's controller (it also guards the
// caller's own async load body), so this loop is `stop()`-only — but callers
// must still check their own `destroyed` flag after every `await` before
// touching the DOM, because `stop()` cannot cancel a load that is already
// mid-flight. See each widget's `loadAndRender`.
export const createRefreshLoop = (config: {
  widgetWindow: Window;
  widgetDocument: Document;
  intervalMs: number;
  onTick: () => void;
  // Called when the document transitions back to `visible`. Defaults to
  // `onTick`; starvation_rescue passes a list-only reload so a background poll
  // never disturbs an in-progress confirm flow.
  onVisible?: () => void;
}): { start: () => void; bindVisibility: () => void; stop: () => void } => {
  const { widgetWindow, widgetDocument, intervalMs, onTick } = config;
  const onVisible = config.onVisible ?? onTick;
  let refreshTimer: number | null = null;
  let visibilityBound = false;

  const handleVisibilityChange = (): void => {
    if (widgetDocument.visibilityState === 'visible') onVisible();
  };

  return {
    start: (): void => {
      if (refreshTimer !== null) widgetWindow.clearInterval(refreshTimer);
      refreshTimer = widgetWindow.setInterval(onTick, intervalMs);
    },
    bindVisibility: (): void => {
      if (visibilityBound) return;
      widgetDocument.addEventListener('visibilitychange', handleVisibilityChange);
      visibilityBound = true;
    },
    stop: (): void => {
      if (refreshTimer !== null) {
        widgetWindow.clearInterval(refreshTimer);
        refreshTimer = null;
      }
      if (!visibilityBound) return;
      widgetDocument.removeEventListener('visibilitychange', handleVisibilityChange);
      visibilityBound = false;
    },
  };
};

// The host-integration bootstrap shared by all five widgets, verbatim:
//   1. resolve the widget's DOM targets; bail (return null) if the markup is
//      missing — every widget's `installWidget` returns null in that case.
//   2. build the controller from those targets.
//   3. register `onHomeyReady` so the Homey bridge hands us the API client.
//   4. if the document is still parsing, defer a no-Homey bootstrap to
//      DOMContentLoaded; otherwise run it now. The no-Homey path only fires when
//      `window.Homey` is absent (preview / harness), so a real boot bootstraps
//      exactly once via `onHomeyReady`.
//
// `onHomeyClient`/`wrapController` are the only legitimate per-widget
// differences:
//   • `onHomeyClient` — extra work when the real client arrives (smart_tasks /
//     create_smart_task start their height-reporter's ResizeObserver here).
//   • `wrapController` — wrap the returned controller's `destroy` (those same
//     two widgets also disconnect the reporter + drop the client on teardown).
// A widget that needs neither passes neither and gets the plain controller.
export const installWidget = <TTargets, THomey, TWindow extends Window>(config: {
  widgetWindow: TWindow;
  widgetDocument: Document;
  resolveTargets: (widgetDocument: Document) => TTargets | null;
  createController: (params: {
    targets: TTargets;
    widgetDocument: Document;
    widgetWindow: TWindow;
  }) => WidgetController<THomey>;
  onHomeyClient?: (homey: THomey) => void;
  wrapController?: (controller: WidgetController<THomey>) => WidgetController<THomey>;
}): WidgetController<THomey> | null => {
  const { widgetWindow, widgetDocument, resolveTargets, createController } = config;
  const targets = resolveTargets(widgetDocument);
  if (!targets) return null;

  const base = createController({ targets, widgetDocument, widgetWindow });
  const controller = config.wrapController ? config.wrapController(base) : base;

  // The Homey bridge looks up `onHomeyReady` on the window by name; assign it
  // through a local alias so the assignment type-checks against the widget's
  // own window shape.
  const installWindow = widgetWindow as TWindow & {
    onHomeyReady?: (homey: THomey) => void;
    Homey?: unknown;
  };
  installWindow.onHomeyReady = (homey: THomey): void => {
    config.onHomeyClient?.(homey);
    controller.bootstrap(homey);
  };

  const bootstrapWithoutHomey = (): void => {
    if (!installWindow.Homey) controller.bootstrap(null);
  };
  if (widgetDocument.readyState === 'loading') {
    widgetDocument.addEventListener('DOMContentLoaded', bootstrapWithoutHomey, { once: true });
  } else {
    bootstrapWithoutHomey();
  }
  return controller;
};
