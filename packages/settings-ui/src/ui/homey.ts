import {
  countApiCacheHit,
  countHomeyApi,
  countHomeyGet,
  countHomeySet,
  countSettingsCacheHit,
} from './perf.ts';
import {
  isAppNotReadyErrorMessage,
  isRetryableHomeyTransportErrorMessage,
} from './homeyTransportErrors.ts';
import { SETTINGS_UI_HOME_ID_QUERY_PARAM } from '../../../contracts/src/settingsUiApi.ts';
import { MAIN_HOME_ID } from '../../../contracts/src/settingsKeys.ts';

// Backoff schedule for transient Homey-API transport failures (e.g. "Network
// request failed", "socket hang up", or "Homey api ... not available" while
// the SDK adapter is still wiring up). The retry only applies to GET so we
// don't replay non-idempotent writes.
const CALL_API_RETRY_DELAYS_MS = [250, 750] as const;

// Longer backoff schedule for the PELS-app-not-ready window. App restarts
// can take several seconds — the runtime returns a `PELS_APP_NOT_READY:`
// error until services are wired up. Idempotent reads keep polling; writes
// are also retried because the sentinel guarantees the runtime has not yet
// touched persistent state. Sums to ~8.25 s of total wait.
const APP_NOT_READY_RETRY_DELAYS_MS = [250, 500, 1000, 1500, 2000, 3000] as const;

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

// Homey global injected by runtime after /homey.js calls window.onHomeyReady.
declare const Homey: HomeySettingsClient;

type WindowWithHomey = Window & {
  Homey?: HomeySettingsClient;
  __PELS_HOMEY_READY__?: Promise<HomeySettingsClient>;
  onHomeyReady?: (homey: HomeySettingsClient) => void;
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

// Whether a key is currently in the settings cache, WITHOUT falling through to a
// Homey `get` on a miss (unlike `getSetting`). Lets callers tell "the bootstrap
// primed this" from "not cached" so they can fetch a fresh assembled value instead
// of reading a stale legacy blob via `get`.
export const hasSettingCache = (key: string): boolean => settingsCache.has(key);

export const primeApiCache = <T>(uri: string, value: T) => {
  apiCache.set(uri, value);
};

// `defaults` fill the payload shape ONLY when no valid entry is cached yet, so
// a partial patch can preserve cached fields it deliberately omits (e.g. a
// status-only power push preserving the cached tracker) while a cold cache
// still stores a fully-shaped payload for consumers that read every field.
export const updateApiCache = <T extends Record<string, unknown>>(
  uri: string,
  patch: Partial<T>,
  defaults?: Partial<T>,
) => {
  const current = apiCache.get(uri);
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    apiCache.set(uri, { ...defaults, ...patch });
    return;
  }
  apiCache.set(uri, { ...(current as T), ...patch });
};

/**
 * Invalidation generations, keyed by base path (the URI up to `?`). A sweep can
 * only delete keys that are ALREADY cached — a request in flight during the
 * sweep has no cache entry yet, so without this gate its pre-sweep response
 * would land in the cache afterwards and, for models with no periodic
 * invalidation (devices), stay resolved for the rest of the WebView session.
 * `getApiReadModel` snapshots the generation before fetching and only caches
 * when it is unchanged. Generation scope is the whole path (bare + every scoped
 * variant): coarser than strictly needed, but a false positive only costs one
 * refetch, while per-key tracking would re-create the invisible-key problem
 * this exists to fix.
 */
const apiCachePathGenerations = new Map<string, number>();

const apiCachePathOf = (uri: string): string => {
  const queryStart = uri.indexOf('?');
  return queryStart === -1 ? uri : uri.slice(0, queryStart);
};

const bumpApiCachePathGeneration = (uri: string) => {
  const path = apiCachePathOf(uri);
  apiCachePathGenerations.set(path, (apiCachePathGenerations.get(path) ?? 0) + 1);
};

export const invalidateApiCache = (uri: string) => {
  apiCache.delete(uri);
  bumpApiCachePathGeneration(uri);
};

/**
 * The URI for a read model, optionally scoped to one sub-home (multi-home).
 *
 * An absent home — and the `'main'` sentinel — return the path UNCHANGED, byte
 * for byte. That is load-bearing, not tidiness: `apiCache` is keyed by exact
 * URI and roughly twenty sites invalidate the bare path, so a whole-home read
 * that quietly became `?homeId=main` would miss every one of those
 * invalidations and serve a single-home user a stale Overview with no
 * staleness signal anywhere. The runtime boundary refuses `?homeId=main` for
 * the same reason, so the two sides agree that the main home is the bare URI.
 *
 * Any other id is passed through encoded and left for the runtime to classify —
 * the client deliberately does NOT pre-filter malformed ids, so a caller bug
 * surfaces as an `unavailable` payload instead of being masked as a whole-home
 * read.
 */
export const homeScopedApiUri = (path: string, homeId?: string): string => (
  homeId === undefined || homeId === MAIN_HOME_ID
    ? path
    : `${path}?${SETTINGS_UI_HOME_ID_QUERY_PARAM}=${encodeURIComponent(homeId)}`
);

const scopedApiCacheKeys = (path: string): string[] => {
  const prefix = `${path}?`;
  return [...apiCache.keys()].filter((key) => key.startsWith(prefix));
};

/**
 * Drop every home-SCOPED entry for `path`, leaving the bare (whole-home) entry
 * intact. For the push paths that re-seed the bare entry from a realtime
 * payload: the push carries the main home's state only (`plan_updated` and
 * `power_updated` are deliberately never widened to sub-homes), so its cache
 * write must not be preceded by a sweep that would delete what it just wrote,
 * yet the sub-home entries it does NOT refresh must not survive as stale.
 */
export const invalidateApiCacheForScopedHomes = (path: string) => {
  scopedApiCacheKeys(path).forEach((key) => apiCache.delete(key));
  // Bumped even when the enumeration deleted nothing: the sweep's target may be
  // a scoped read still in flight, whose key is not cached yet.
  bumpApiCachePathGeneration(path);
};

/**
 * Drop the bare entry AND every home-scoped variant of `path`.
 *
 * Every invalidation of a home-scopable read model must go through this rather
 * than `invalidateApiCache`: the plain form deletes only the exact bare key, so
 * after the scope selector lands, a settings change or device edit would
 * refresh the whole-home view while a selected sub-home kept rendering the
 * pre-change payload for the rest of the WebView session.
 */
export const invalidateApiCacheForAllHomes = (path: string) => {
  apiCache.delete(path);
  invalidateApiCacheForScopedHomes(path);
};

/**
 * Whether `uri`'s response may still be cached, given the generation observed
 * before its GET went out. Split out so the read path names the rule once.
 */
const isApiCacheWriteStillValid = (uri: string, generationAtFetch: number): boolean => (
  (apiCachePathGenerations.get(apiCachePathOf(uri)) ?? 0) === generationAtFetch
);

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

export const getSettingFresh = (key: string): Promise<unknown> => {
  if (!homeyClient) return Promise.reject(new Error('Homey SDK not ready'));
  return new Promise((resolve, reject) => {
    countHomeyGet(key);
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

const callApiOnce = async <T>(method: 'DELETE' | 'GET' | 'POST' | 'PUT', uri: string, body?: unknown): Promise<T> => {
  const client = homeyClient;
  const api = client?.api;
  if (!api || typeof api !== 'function') {
    throw new Error(`Homey api ${method} ${uri} not available`);
  }
  return new Promise<T>((resolve, reject) => {
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

export const callApi = async <T>(
  method: 'DELETE' | 'GET' | 'POST' | 'PUT',
  uri: string,
  body?: unknown,
): Promise<T> => {
  let attempt = 0;
  let appNotReadyAttempt = 0;
  while (true) {
    try {
      return await callApiOnce<T>(method, uri, body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isAppNotReadyErrorMessage(message)
          && appNotReadyAttempt < APP_NOT_READY_RETRY_DELAYS_MS.length) {
        await sleep(APP_NOT_READY_RETRY_DELAYS_MS[appNotReadyAttempt]!);
        appNotReadyAttempt += 1;
        continue;
      }
      const canRetry = method === 'GET'
        && attempt < CALL_API_RETRY_DELAYS_MS.length
        && isRetryableHomeyTransportErrorMessage(message);
      if (!canRetry) throw error;
      await sleep(CALL_API_RETRY_DELAYS_MS[attempt]!);
      attempt += 1;
    }
  }
};

export const getApiReadModel = async <T>(uri: string): Promise<T> => {
  if (apiCache.has(uri)) {
    countApiCacheHit();
    return apiCache.get(uri) as T;
  }
  const generationAtFetch = apiCachePathGenerations.get(apiCachePathOf(uri)) ?? 0;
  const value = await callApi<T>('GET', uri);
  // The caller still gets the response; it just must not OUTLIVE an
  // invalidation that swept this path while the GET was in flight — the next
  // read refetches instead of resolving a pre-sweep payload from the cache.
  if (isApiCacheWriteStillValid(uri, generationAtFetch)) {
    apiCache.set(uri, value);
  }
  return value;
};

const isHomeySettingsClient = (candidate: unknown): candidate is HomeySettingsClient => (
  Boolean(candidate)
  && typeof (candidate as Partial<HomeySettingsClient>).ready === 'function'
  && typeof (candidate as Partial<HomeySettingsClient>).get === 'function'
);

const getHomeyClientCandidate = (candidate: unknown): HomeySettingsClient | null => {
  if (isHomeySettingsClient(candidate)) return candidate;
  return null;
};

export const waitForHomey = async (attempts = 50, interval = 100) => {
  let readyCandidate: HomeySettingsClient | null = null;
  if (typeof window !== 'undefined') {
    const readyPromise = (window as WindowWithHomey).__PELS_HOMEY_READY__;
    if (readyPromise && typeof readyPromise.then === 'function') {
      readyPromise
        .then((candidate) => {
          readyCandidate = getHomeyClientCandidate(candidate);
        })
        .catch(() => {});
      await Promise.resolve();
    }
  }

  const resolveHomey = () => {
    if (typeof Homey !== 'undefined') {
      const globalHomey = getHomeyClientCandidate(Homey);
      if (globalHomey) return globalHomey;
    }
    if (typeof window !== 'undefined') {
      const windowHomey = getHomeyClientCandidate((window as WindowWithHomey).Homey);
      if (windowHomey) return windowHomey;
    }
    return null;
  };

  for (let i = 0; i < attempts; i += 1) {
    const candidate = readyCandidate ?? resolveHomey();
    if (isHomeySettingsClient(candidate)) {
      setHomeyClient(candidate);
      return candidate;
    }
    await sleep(interval);
  }
  return null;
};
