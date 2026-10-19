import {
  installWidget,
  type WidgetController,
  type WidgetHomeyBase,
  type WidgetWindowBase,
} from './widgetRuntime';

// For widgets whose height follows their content (dynamic height) rather than a
// fixed manifest height (`widget-frame.css`).
export type HeightReportingWindow = WidgetWindowBase & {
  // Declared explicitly: the lib.dom `Window` interface doesn't surface the
  // global `ResizeObserver` constructor as a property, and the widget reads it
  // off the injected window (optional so non-DOM test windows can omit it).
  ResizeObserver?: typeof globalThis.ResizeObserver;
};

export type HeightReportingHomey = WidgetHomeyBase & {
  // Resize the widget iframe to fit content. Homey widgets don't scroll
  // internally; they size the iframe to what the widget asks for.
  setHeight?: (height: number) => void;
};

// Keep the widget iframe sized to its content. Homey widgets don't scroll
// internally — the dashboard scrolls between widgets and anything past the
// iframe height is clipped — so instead of a fixed compose height we measure the
// content-height root and call Homey.setHeight. A ResizeObserver (rather than a
// synchronous measure in render) is what makes this reliable: the first paint,
// web-font load, and async device-list arrival all change the height *after* a
// render returns, so a synchronous read sees a stale/pre-layout value and the
// widget only self-corrects on the next interaction. The observer fires once
// layout settles and on every later size change. `getHomey` is read lazily so
// the reporter created before bootstrap still sees the assigned Homey client.
// It starts observing only after `Homey.ready()`: Homey ignores `setHeight`
// before then, and the reporter never repeats a height it already sent, so an
// early report left the widget clipped at its manifest height.
export const createHeightReporter = (
  root: HTMLElement,
  widgetWindow: HeightReportingWindow,
  getHomey: () => HeightReportingHomey | null,
): { observe: () => void; disconnect: () => void } => {
  let observer: ResizeObserver | null = null;
  let lastReportedHeight = 0;
  const report = (): void => {
    const homey = getHomey();
    if (!homey?.setHeight) return;
    // Homey mounts the widget under <body class="homey-widget-small">, whose
    // stylesheet pads the body around #widget-root. The root's own box excludes
    // that padding, so report root height + the body's vertical padding —
    // otherwise the iframe ends up a few px short and clips each view's bottom.
    const bodyStyle = widgetWindow.getComputedStyle(root.ownerDocument.body);
    const bodyPadding = (Number.parseFloat(bodyStyle.paddingTop) || 0)
      + (Number.parseFloat(bodyStyle.paddingBottom) || 0);
    const height = Math.ceil(root.getBoundingClientRect().height + bodyPadding);
    if (height <= 0 || height === lastReportedHeight) return;
    lastReportedHeight = height;
    homey.setHeight(height);
  };
  return {
    observe: (): void => {
      if (observer || typeof widgetWindow.ResizeObserver !== 'function') return;
      observer = new widgetWindow.ResizeObserver(() => report());
      observer.observe(root);
    },
    disconnect: (): void => {
      observer?.disconnect();
      observer = null;
    },
  };
};


/**
 * Install a widget whose height follows its content. The shared install
 * (`installWidget`), plus a height reporter on the targets' `root` that starts
 * once the controller calls `onReady` (right after `Homey.ready()`) and stops on
 * destroy. The no-Homey preview/harness path never reports: no client arrives.
 */
export const installHeightReportingWidget = <
  TTargets extends { root: HTMLElement },
  THomey extends HeightReportingHomey,
>(
  widgetWindow: HeightReportingWindow,
  widgetDocument: Document,
  resolveTargets: (widgetDocument: Document) => TTargets | null,
  createController: (
    targets: TTargets,
    widgetDocument: Document,
    widgetWindow: HeightReportingWindow,
    onReady: () => void,
  ) => WidgetController<THomey>,
): WidgetController<THomey> | null => {
  let activeHomey: THomey | null = null;
  let heightReporter: ReturnType<typeof createHeightReporter> | null = null;
  return installWidget<TTargets, THomey, HeightReportingWindow>({
    widgetWindow,
    widgetDocument,
    resolveTargets,
    createController: ({ targets, widgetDocument: doc, widgetWindow: win }) => {
      heightReporter = createHeightReporter(targets.root, win, () => activeHomey);
      return createController(targets, doc, win, () => heightReporter?.observe());
    },
    onHomeyClient: (homey) => {
      activeHomey = homey;
    },
    wrapController: (controller) => ({
      ...controller,
      destroy: (): void => {
        controller.destroy();
        heightReporter?.disconnect();
        // Drop the client so any late ResizeObserver callback short-circuits in
        // getHomey() instead of calling setHeight on a torn-down widget.
        activeHomey = null;
      },
    }),
  });
};
