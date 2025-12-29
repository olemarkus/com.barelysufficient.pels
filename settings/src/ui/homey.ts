export type HomeyCallback<T> = (err: Error | null, value?: T) => void;

export type HomeySettingsClient = {
  ready: () => Promise<void>;
  get: (key: string, cb: HomeyCallback<unknown>) => void;
  set: (key: string, value: unknown, cb: HomeyCallback<void>) => void;
  api?: (
    method: 'DELETE' | 'GET' | 'POST' | 'PUT',
    uri: string,
    bodyOrCallback: unknown | HomeyCallback<unknown>,
    cb?: HomeyCallback<unknown>,
  ) => void;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
  clock?: {
    getTimezone?: () => string;
  };
  i18n?: {
    getTimezone?: () => string;
  };
};

// Homey global injected by runtime.
declare const Homey: HomeySettingsClient;

type WindowWithHomey = Window & {
  Homey?: HomeySettingsClient;
};

let homeyClient: HomeySettingsClient | null = null;

export const getHomeyClient = () => homeyClient;

export const setHomeyClient = (client: HomeySettingsClient | null) => {
  homeyClient = client;
};

export const getHomeyTimezone = () => {
  const clockTz = homeyClient?.clock?.getTimezone?.();
  if (typeof clockTz === 'string' && clockTz.trim()) return clockTz;
  const i18nTz = homeyClient?.i18n?.getTimezone?.();
  if (typeof i18nTz === 'string' && i18nTz.trim()) return i18nTz;
  return 'Europe/Oslo';
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const withTimeout = (promise: Promise<unknown>, ms: number, message: string) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
]);

export const pollSetting = async (key: string, attempts = 10, delay = 300) => {
  for (let i = 0; i < attempts; i += 1) {
    const value = await getSetting(key);
    if (value) return value;
    await sleep(delay);
  }
  return null;
};

export const getSetting = (key: string): Promise<unknown> => {
  if (!homeyClient) return Promise.reject(new Error('Homey SDK not ready'));
  return new Promise((resolve, reject) => {
    homeyClient?.get(key, (err, value) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(value);
    });
  });
};

export const setSetting = (key: string, value: unknown): Promise<void> => {
  if (!homeyClient) return Promise.reject(new Error('Homey SDK not ready'));
  return new Promise((resolve, reject) => {
    homeyClient?.set(key, value, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
};

const buildApiError = (method: string, uri: string, error: unknown) => {
  const message = error instanceof Error && error.message ? error.message : String(error);
  return new Error(`Homey api ${method} ${uri} failed: ${message}`);
};

export const callApi = <T>(method: 'DELETE' | 'GET' | 'POST' | 'PUT', uri: string, body?: unknown): Promise<T> => {
  const client = homeyClient;
  const api = client?.api;
  if (!api || typeof api !== 'function') {
    return Promise.reject(new Error(`Homey api ${method} ${uri} not available`));
  }
  return new Promise((resolve, reject) => {
    const callback: HomeyCallback<unknown> = (err, value) => {
      if (err) {
        reject(buildApiError(method, uri, err));
        return;
      }
      resolve(value as T);
    };
    if (method === 'GET' || method === 'DELETE') {
      // Workaround for Homey SDK API inconsistencies: some versions expect
      // a body/options object even for GET/DELETE, while others throw.
      try {
        api.call(client, method, uri, callback);
      } catch {
        try {
          api.call(client, method, uri, {}, callback);
        } catch (error) {
          reject(buildApiError(method, uri, error));
        }
      }
      return;
    }
    try {
      api.call(client, method, uri, body ?? {}, callback);
    } catch (error) {
      reject(buildApiError(method, uri, error));
    }
  });
};

export const waitForHomey = async (attempts = 50, interval = 100) => {
  const resolveHomey = () => {
    if (typeof Homey !== 'undefined') return Homey;
    if (typeof window !== 'undefined' && window.parent) {
      const parentHomey = (window.parent as WindowWithHomey).Homey;
      if (parentHomey) return parentHomey;
    }
    return null;
  };

  for (let i = 0; i < attempts; i += 1) {
    const candidate = resolveHomey();
    if (candidate && typeof candidate.ready === 'function' && typeof candidate.get === 'function') {
      homeyClient = candidate;
      return candidate;
    }
    await sleep(interval);
  }
  return null;
};
