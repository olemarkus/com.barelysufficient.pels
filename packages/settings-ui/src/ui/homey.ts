import {
  countApiCacheHit,
  countHomeyApi,
  countHomeyGet,
  countHomeySet,
  countSettingsCacheHit,
} from './perf.ts';

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
const settingsCache = new Map<string, unknown>();
const apiCache = new Map<string, unknown>();

export const getHomeyClient = () => homeyClient;

export const setHomeyClient = (client: HomeySettingsClient | null) => {
  if (homeyClient !== client) {
    settingsCache.clear();
    apiCache.clear();
  }
  homeyClient = client;
};

export const applySettingsPatch = (settings: Record<string, unknown>) => {
  Object.entries(settings).forEach(([key, value]) => {
    settingsCache.set(key, value);
  });
};

export const invalidateSettingCache = (key: string) => {
  settingsCache.delete(key);
};

export const primeApiCache = <T>(uri: string, value: T) => {
  apiCache.set(uri, value);
};

export const updateApiCache = <T extends Record<string, unknown>>(uri: string, patch: Partial<T>) => {
  const current = apiCache.get(uri);
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    apiCache.set(uri, patch);
    return;
  }
  apiCache.set(uri, { ...(current as T), ...patch });
};

export const invalidateApiCache = (uri: string) => {
  apiCache.delete(uri);
};

export const getHomeyTimezone = () => {
  const clockTz = homeyClient?.clock?.getTimezone?.();
  if (typeof clockTz === 'string' && clockTz.trim()) return clockTz;
  const i18nTz = homeyClient?.i18n?.getTimezone?.();
  if (typeof i18nTz === 'string' && i18nTz.trim()) return i18nTz;
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (typeof browserTz === 'string' && browserTz.trim()) return browserTz;
  return 'UTC';
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
  if (settingsCache.has(key)) {
    countSettingsCacheHit();
    return Promise.resolve(settingsCache.get(key));
  }
  return new Promise((resolve, reject) => {
    countHomeyGet(key);
    homeyClient?.get(key, (err, value) => {
      if (err) {
        reject(err);
        return;
      }
      settingsCache.set(key, value);
      resolve(value);
    });
  });
};

export const setSetting = (key: string, value: unknown): Promise<void> => {
  if (!homeyClient) return Promise.reject(new Error('Homey SDK not ready'));
  return new Promise((resolve, reject) => {
    countHomeySet(key);
    homeyClient?.set(key, value, (err) => {
      if (err) {
        reject(err);
        return;
      }
      settingsCache.set(key, value);
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
    countHomeyApi(method, uri);
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

export const getApiReadModel = async <T>(uri: string): Promise<T> => {
  if (apiCache.has(uri)) {
    countApiCacheHit();
    return apiCache.get(uri) as T;
  }
  const value = await callApi<T>('GET', uri);
  apiCache.set(uri, value);
  return value;
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
      setHomeyClient(candidate);
      return candidate;
    }
    await sleep(interval);
  }
  return null;
};
