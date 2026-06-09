// Browser-safe widget→app error reporting. Each widget's WebView controller
// catches a failed `homey.api(...)` load and renders a generic load-error
// subtitle — but the real cause (a thrown handler, or the common "App is not
// available" while the app process restarts) only ever reached the WebView
// console, which is unreachable on the mobile Homey dashboard. This module mirrors
// the settings-UI logging path (packages/settings-ui/src/ui/logging.ts →
// `settings_ui_log`): the client POSTs the error to the widget's own `/log`
// endpoint, whose app-process handler (widgetClientLogApi.ts) writes it into the
// Homey app log where `/tmp/pels` can see it.
//
// Browser-safe: imports nothing from the app runtime, so it bundles into each
// widget's `public/index.js` IIFE. The app-process counterpart lives in
// widgetClientLogApi.ts (imported only by each widget's api.ts node entry).

export type WidgetLogLevel = 'error' | 'warn' | 'info';

// The wire payload POSTed to a widget's `/log` endpoint. `widget` identifies the
// source widget; `detail` carries the stack/message of the underlying error.
export type WidgetClientLogEntry = {
  level: WidgetLogLevel;
  widget: string;
  message: string;
  detail?: string;
  timestamp: number;
};

// Path of the per-widget logging endpoint. Each widget declares this POST route
// in its `widget.compose.json` and exports a matching handler from `api.ts`.
export const WIDGET_CLIENT_LOG_PATH = '/log';

// Bound on the in-memory backlog held while the app is unreachable. The poll loop
// fires every ~10 s, so a multi-minute outage would otherwise grow unbounded;
// identical consecutive failures coalesce (see below) so this is only reached by
// genuinely distinct messages.
const MAX_PENDING = 20;

// A persistent failure re-fires on every poll tick (~10 s). Collapse identical
// (level+message) reports inside this window to one app-log line so a stuck
// widget doesn't flood `/tmp/pels`.
const SUPPRESS_WINDOW_MS = 60 * 1000;

// The reporter only ever POSTs to the widget's `/log` route, so it asks for no
// more than a POST-capable `api`. Narrowing to 'POST' (rather than `string`)
// keeps every widget's `WidgetHomey` assignable here, including plan_budget's
// GET-typed client (it adds a POST overload for this path).
type ReporterHomey = {
  api: (method: 'POST', path: string, body?: unknown) => Promise<unknown>;
};

const normalizeError = (error: unknown): string | undefined => {
  if (error === undefined) return undefined;
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

export type WidgetErrorReporter = {
  // Report a client-observed problem. Best-effort: delivered immediately when the
  // app is reachable, otherwise queued and drained on the next `flush()`/`report()`.
  report: (level: WidgetLogLevel, message: string, error?: unknown) => void;
  // Drain any queued reports. Call after a successful load, when the app is known
  // to be reachable again, so backlog accumulated during an outage surfaces.
  flush: () => void;
};

export const createWidgetErrorReporter = (params: {
  widget: string;
  // Late-bound so the reporter created at controller construction sees the Homey
  // client handed over later by `bootstrap`. Returns null in preview/harness.
  getHomey: () => ReporterHomey | null;
  now: () => number;
}): WidgetErrorReporter => {
  const pending: WidgetClientLogEntry[] = [];
  const lastAcceptedAt = new Map<string, number>();

  const post = async (entry: WidgetClientLogEntry): Promise<void> => {
    const homey = params.getHomey();
    if (!homey) throw new Error('widget log: no Homey client');
    await homey.api('POST', WIDGET_CLIENT_LOG_PATH, entry);
  };

  // Drain the backlog oldest-first; stop at the first failure so order is
  // preserved and the survivors retry next time.
  const drain = async (): Promise<void> => {
    while (pending.length > 0) {
      await post(pending[0]);
      pending.shift();
    }
  };

  const queue = (entry: WidgetClientLogEntry): void => {
    const last = pending[pending.length - 1];
    if (last && last.level === entry.level && last.message === entry.message) {
      // Coalesce a repeating identical failure (the poll loop re-hits the same
      // error every tick during an outage) onto one entry.
      last.detail = entry.detail;
      last.timestamp = entry.timestamp;
      return;
    }
    if (pending.length >= MAX_PENDING) pending.shift();
    pending.push(entry);
  };

  const flush = (): void => {
    void drain().catch(() => {
      // App still unreachable; keep the backlog for the next attempt.
    });
  };

  const report = (level: WidgetLogLevel, message: string, error?: unknown): void => {
    if (!params.getHomey()) return; // preview/harness: no client to report through
    const now = params.now();
    const key = `${level}:${message}`;
    const seenAt = lastAcceptedAt.get(key);
    if (seenAt !== undefined && now - seenAt < SUPPRESS_WINDOW_MS) return;
    lastAcceptedAt.set(key, now);
    const entry: WidgetClientLogEntry = {
      level,
      widget: params.widget,
      message,
      detail: normalizeError(error),
      timestamp: now,
    };
    void (async () => {
      try {
        await drain();
        await post(entry);
      } catch {
        queue(entry);
      }
    })();
  };

  return { report, flush };
};

// Convenience over `createWidgetErrorReporter` for the common controller call:
// the only per-widget variables are the widget id and the late-bound client.
export const widgetErrorReporter = (
  widget: string,
  getHomey: () => ReporterHomey | null,
): WidgetErrorReporter => createWidgetErrorReporter({ widget, getHomey, now: () => Date.now() });
