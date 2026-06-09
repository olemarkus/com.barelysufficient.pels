// App-process handler for a widget's `/log` endpoint. Counterpart to the
// browser-safe reporter in widgetClientLog.ts and the app-side mirror of
// `logSettingsUiMessage` (setup/settingsUiApi.ts): it writes a WebView-reported
// problem into the Homey app log (`homey.app.error/log`), so the cause behind a
// widget's load-error state surfaces in `/tmp/pels` instead of dying in the
// unreachable mobile WebView console.
//
// Runs in the app process: imported only by each widget's `api.ts` node entry
// (never by the public/** WebView bundle). Takes the Homey context as an
// argument rather than importing app runtime, so it carries no runtime edge.

import type { WidgetClientLogEntry } from './widgetClientLog';

type WidgetLogApiApp = {
  error?: (message: string, error?: Error) => void;
  log?: (...args: unknown[]) => void;
};

// The Homey API-handler context each widget's `logClientError` export receives.
// Only `homey.app`'s logging surface and the POSTed `body` matter here.
export type WidgetClientLogContext = {
  homey: { app?: WidgetLogApiApp };
  body?: unknown;
};

const isValidEntry = (value: unknown): value is WidgetClientLogEntry => {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<WidgetClientLogEntry>;
  return (
    (entry.level === 'error' || entry.level === 'warn' || entry.level === 'info')
    && typeof entry.widget === 'string'
    && typeof entry.message === 'string'
  );
};

export const handleWidgetClientLog = (
  widgetId: string,
  { homey, body }: WidgetClientLogContext,
): { ok: boolean } => {
  const app = homey.app;
  if (!isValidEntry(body)) {
    app?.error?.(`Widget ${widgetId} log API called without a valid payload`);
    return { ok: false };
  }

  const message = `Widget (${body.widget}): ${body.message}`;
  if (body.level === 'error') {
    app?.error?.(message, new Error(body.detail ?? body.message));
  } else if (body.level === 'warn') {
    app?.log?.(`Warning: ${message}`);
  } else {
    app?.log?.(message);
  }
  return { ok: true };
};
