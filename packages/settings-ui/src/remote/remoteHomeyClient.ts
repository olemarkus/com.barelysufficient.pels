import type { HomeyCallback, HomeySettingsClient } from '../ui/homey.ts';
import { PELS_APP_ID, type RemoteConnection } from './remoteConnection.ts';

type Method = 'DELETE' | 'GET' | 'POST' | 'PUT';

type RemoteListener = (...args: unknown[]) => void;

// The realtime side hands each app event to `dispatch`; `on` registrations made
// before the socket connects are kept and served once it does.
export type RemoteEventHub = {
  on: (event: string, listener: RemoteListener) => void;
  dispatch: (event: string, data: unknown) => void;
};

export const createRemoteEventHub = (): RemoteEventHub => {
  const listeners = new Map<string, RemoteListener[]>();
  return {
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    // The WebView bridge passes an event's payload as the first listener
    // argument; `settings.set` / `settings.unset` carry the settings key there.
    dispatch: (event, data) => {
      for (const listener of listeners.get(event) ?? []) listener(data);
    },
  };
};

export class RemoteHomeyError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'RemoteHomeyError';
    this.status = status;
  }
}

// Homey refuses a key it does not know (401) or one without the scope (403).
export const isKeyRefused = (error: unknown): boolean => (
  error instanceof RemoteHomeyError && (error.status === 401 || error.status === 403)
);

export const errorDetail = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

// Homey answers a failed call with `{ error, error_description }` (the app's
// thrown message for an app route) and an unknown route with Express's
// "Cannot GET /api/app/..." page. Both texts are kept verbatim so the UI's
// existing app-not-ready and transport-error checks read them as they do the
// WebView's.
const readErrorMessage = async (response: Response): Promise<string> => {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { error?: unknown; error_description?: unknown };
    const message = body.error_description ?? body.error;
    if (typeof message === 'string' && message) return message;
  } catch {
    const cannot = /Cannot (GET|POST|PUT|DELETE) [^<\s]+/.exec(text);
    if (cannot) return cannot[0];
  }
  return `HTTP ${response.status}`;
};

const readBody = async (response: Response): Promise<unknown> => {
  if (response.status === 204) return undefined;
  const text = await response.text();
  return text ? JSON.parse(text) as unknown : undefined;
};

export type RemoteFetch = (input: string, init: RequestInit) => Promise<Response>;

export const createRemoteRequest = (connection: RemoteConnection, fetchImpl: RemoteFetch) => (
  async (method: Method, path: string, body?: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(`${connection.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${connection.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      // fetch rejects only on transport failure; the UI retries reads on
      // this wording, as it does for the WebView's own network errors.
      throw new RemoteHomeyError(`Network request failed (${errorDetail(error)})`, 0);
    }
    if (!response.ok) throw new RemoteHomeyError(await readErrorMessage(response), response.status);
    return readBody(response);
  }
);

export type RemoteRequest = ReturnType<typeof createRemoteRequest>;

export const SETTINGS_PATH = `/api/manager/apps/app/${PELS_APP_ID}/setting`;

export const settingPath = (key: string) => `${SETTINGS_PATH}/${encodeURIComponent(key)}`;

const settle = <T>(promise: Promise<T>, callback: HomeyCallback<T>) => {
  promise.then(
    (value) => callback(null, value),
    (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
  );
};

// The WebView `Homey` object, served over Homey's Web API. Settings map to the
// app-settings endpoints, `api` to the app's own routes, and `on` to the
// realtime hub, so the settings UI runs unchanged.
export const createRemoteHomeyClient = (
  request: RemoteRequest,
  events: RemoteEventHub,
  timeZone: string,
): HomeySettingsClient => ({
  ready: async () => {},
  get: (key, callback) => {
    settle(request('GET', settingPath(key)), callback);
  },
  set: (key, value, callback) => {
    settle(request('PUT', settingPath(key), { value }).then(() => undefined), callback);
  },
  api: (method, uri, bodyOrCallback, maybeCallback) => {
    const callback = (typeof bodyOrCallback === 'function' ? bodyOrCallback : maybeCallback) as
      HomeyCallback<unknown> | undefined;
    if (!callback) throw new Error('Homey api callback-only signature not supported');
    const body = typeof bodyOrCallback === 'function' || method === 'GET' || method === 'DELETE'
      ? undefined
      : bodyOrCallback;
    const path = uri.startsWith('/') ? uri : `/${uri}`;
    settle(request(method, `/api/app/${PELS_APP_ID}${path}`, body), callback);
  },
  on: events.on,
  clock: {
    getTimezone: () => timeZone,
  },
});
