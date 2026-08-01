import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_HOME_ID_QUERY_PARAM,
  SETTINGS_UI_PLAN_PATH,
  SETTINGS_UI_POWER_PATH,
} from '../../contracts/src/settingsUiApi.ts';
import { MAIN_HOME_ID } from '../../contracts/src/settingsKeys.ts';
import {
  getApiReadModel,
  homeScopedApiUri,
  invalidateApiCache,
  invalidateApiCacheForAllHomes,
  invalidateApiCacheForScopedHomes,
  primeApiCache,
  setHomeyClient,
  type HomeyCallback,
  type HomeySettingsClient,
} from '../src/ui/homey.ts';

/* -------------------------------------------------------------------------- *
 * The client half of the per-home read seam (multi-home R5b).
 *
 * `apiCache` is keyed by EXACT URI, so two things have to hold together: an
 * unscoped read must produce the bare path byte-for-byte (or it misses the ~20
 * sites that invalidate that key, and a single-home user's Overview goes stale
 * with no staleness signal), and every invalidation of a home-scopable read
 * must sweep the scoped variants too (or a selected sub-home keeps rendering a
 * pre-change payload for the rest of the session).
 * -------------------------------------------------------------------------- */

const AREA = 'h_area1';
const scoped = (path: string, homeId: string) => (
  `${path}?${SETTINGS_UI_HOME_ID_QUERY_PARAM}=${homeId}`
);

describe('homeScopedApiUri', () => {
  it('returns the bare path byte-identically when no home is named', () => {
    expect(homeScopedApiUri(SETTINGS_UI_PLAN_PATH)).toBe(SETTINGS_UI_PLAN_PATH);
    expect(homeScopedApiUri(SETTINGS_UI_PLAN_PATH, undefined)).toBe(SETTINGS_UI_PLAN_PATH);
    expect(homeScopedApiUri(SETTINGS_UI_POWER_PATH)).toBe('/ui_power');
  });

  it('collapses the main-home sentinel to the bare path, never `?homeId=main`', () => {
    // Belt and braces with the runtime boundary, which REFUSES `?homeId=main`:
    // the two sides agree that the main home is the bare URI.
    expect(homeScopedApiUri(SETTINGS_UI_PLAN_PATH, MAIN_HOME_ID)).toBe(SETTINGS_UI_PLAN_PATH);
    expect(homeScopedApiUri(SETTINGS_UI_PLAN_PATH, 'main')).not.toContain('?');
  });

  it('appends an encoded homeId for a sub-home', () => {
    expect(homeScopedApiUri(SETTINGS_UI_PLAN_PATH, AREA)).toBe(`/ui_plan?homeId=${AREA}`);
    expect(homeScopedApiUri(SETTINGS_UI_PLAN_PATH, 'a b&c=d')).toBe('/ui_plan?homeId=a%20b%26c%3Dd');
  });

  it('passes a malformed id through for the runtime to refuse', () => {
    // Deliberately NOT silently collapsed to the bare path: masking a caller bug
    // as a whole-home read is exactly the failure this seam exists to prevent.
    // The runtime answers `homeScope: unavailable`.
    expect(homeScopedApiUri(SETTINGS_UI_PLAN_PATH, '')).toBe('/ui_plan?homeId=');
    expect(homeScopedApiUri(SETTINGS_UI_PLAN_PATH, '__proto__')).toBe('/ui_plan?homeId=__proto__');
  });
});

describe('api cache invalidation across homes', () => {
  const seed = () => {
    primeApiCache(SETTINGS_UI_PLAN_PATH, 'bare-plan');
    primeApiCache(scoped(SETTINGS_UI_PLAN_PATH, AREA), 'area-plan');
    primeApiCache(scoped(SETTINGS_UI_PLAN_PATH, 'h_area2'), 'area2-plan');
    primeApiCache(SETTINGS_UI_POWER_PATH, 'bare-power');
    primeApiCache(scoped(SETTINGS_UI_POWER_PATH, AREA), 'area-power');
  };

  // A cached entry is observable only through `getApiReadModel`, which falls
  // through to the transport on a miss — so a fetch attempt IS the miss signal.
  const client: HomeySettingsClient = {
    ready: () => Promise.resolve(),
    get: (_key: string, cb: HomeyCallback<unknown>) => cb(null, null),
    set: (_key: string, _value: unknown, cb: HomeyCallback<void>) => cb(null),
    api: vi.fn((_method, uri, bodyOrCallback, cb) => {
      const callback = (typeof bodyOrCallback === 'function' ? bodyOrCallback : cb) as HomeyCallback<unknown>;
      callback(null, `fetched:${uri}`);
    }),
  };

  beforeEach(() => {
    setHomeyClient(null);
    setHomeyClient(client);
    vi.mocked(client.api!).mockClear();
    seed();
  });

  it('plain invalidateApiCache drops ONLY the exact key', () => {
    // The pre-multi-home behaviour, kept for paths that have no scoped variants
    // (prices, diagnostics, device log, rescue devices).
    invalidateApiCache(SETTINGS_UI_PLAN_PATH);
    expect(client.api).not.toHaveBeenCalled();
    return getApiReadModel(scoped(SETTINGS_UI_PLAN_PATH, AREA)).then((value) => {
      expect(value).toBe('area-plan');
    });
  });

  it('invalidateApiCacheForAllHomes drops the bare entry and every scoped one', async () => {
    invalidateApiCacheForAllHomes(SETTINGS_UI_PLAN_PATH);

    expect(await getApiReadModel(SETTINGS_UI_PLAN_PATH)).toBe(`fetched:${SETTINGS_UI_PLAN_PATH}`);
    expect(await getApiReadModel(scoped(SETTINGS_UI_PLAN_PATH, AREA)))
      .toBe(`fetched:${scoped(SETTINGS_UI_PLAN_PATH, AREA)}`);
    expect(await getApiReadModel(scoped(SETTINGS_UI_PLAN_PATH, 'h_area2')))
      .toBe(`fetched:${scoped(SETTINGS_UI_PLAN_PATH, 'h_area2')}`);

    // A different path is untouched — the sweep is prefix-scoped, not global.
    expect(await getApiReadModel(SETTINGS_UI_POWER_PATH)).toBe('bare-power');
    expect(await getApiReadModel(scoped(SETTINGS_UI_POWER_PATH, AREA))).toBe('area-power');
  });

  it('invalidateApiCacheForScopedHomes preserves the bare entry', async () => {
    // The push paths depend on this: `plan_updated` / `power_updated` carry the
    // MAIN home's state, so they re-seed the bare entry and must only drop the
    // sub-home entries they cannot speak for.
    invalidateApiCacheForScopedHomes(SETTINGS_UI_PLAN_PATH);

    expect(await getApiReadModel(SETTINGS_UI_PLAN_PATH)).toBe('bare-plan');
    expect(client.api).not.toHaveBeenCalled();
    expect(await getApiReadModel(scoped(SETTINGS_UI_PLAN_PATH, AREA)))
      .toBe(`fetched:${scoped(SETTINGS_UI_PLAN_PATH, AREA)}`);
  });

  it('does not sweep a path that merely shares a prefix', async () => {
    // `/ui_plan_history` must never be caught by a sweep of `/ui_plan`: the
    // boundary is the `?`, so only true query variants match.
    primeApiCache('/ui_plan_history', 'history');
    invalidateApiCacheForAllHomes(SETTINGS_UI_PLAN_PATH);
    expect(await getApiReadModel('/ui_plan_history')).toBe('history');
  });
});

describe('invalidations during an in-flight read', () => {
  // A sweep can only delete keys that are ALREADY cached; a request in flight
  // has no entry yet. Its pre-sweep response must therefore not be cached once
  // it lands — device models have no periodic invalidation, so a deleted home
  // or reassigned device would otherwise stay resolved for the whole session.
  const pendingCallbacks: Array<() => void> = [];
  const deferredClient: HomeySettingsClient = {
    ready: () => Promise.resolve(),
    get: (_key: string, cb: HomeyCallback<unknown>) => cb(null, null),
    set: (_key: string, _value: unknown, cb: HomeyCallback<void>) => cb(null),
    api: vi.fn((_method, uri, bodyOrCallback, cb) => {
      const callback = (typeof bodyOrCallback === 'function' ? bodyOrCallback : cb) as HomeyCallback<unknown>;
      pendingCallbacks.push(() => callback(null, `fetched:${uri}`));
    }),
  };

  const flushPending = () => {
    pendingCallbacks.splice(0).forEach((complete) => complete());
  };

  beforeEach(() => {
    setHomeyClient(null);
    setHomeyClient(deferredClient);
    vi.mocked(deferredClient.api!).mockClear();
    pendingCallbacks.length = 0;
  });

  it.each([
    ['a scoped-homes sweep', () => invalidateApiCacheForScopedHomes(SETTINGS_UI_PLAN_PATH)],
    ['an all-homes sweep', () => invalidateApiCacheForAllHomes(SETTINGS_UI_PLAN_PATH)],
    ['an exact-key invalidation of the same path', () => invalidateApiCache(scoped(SETTINGS_UI_PLAN_PATH, AREA))],
  ])('does not cache a scoped response that predates %s', async (_label, invalidate) => {
    const uri = scoped(SETTINGS_UI_PLAN_PATH, AREA);
    const inFlight = getApiReadModel(uri);
    invalidate();
    flushPending();
    // The caller still gets the response it asked for…
    expect(await inFlight).toBe(`fetched:${uri}`);
    // …but the next read must refetch instead of resolving the pre-sweep value.
    const second = getApiReadModel(uri);
    flushPending();
    await second;
    expect(deferredClient.api).toHaveBeenCalledTimes(2);
  });

  it('caches normally when no invalidation lands mid-flight', async () => {
    const uri = scoped(SETTINGS_UI_PLAN_PATH, AREA);
    const first = getApiReadModel(uri);
    flushPending();
    expect(await first).toBe(`fetched:${uri}`);
    expect(await getApiReadModel(uri)).toBe(`fetched:${uri}`);
    expect(deferredClient.api).toHaveBeenCalledTimes(1);
  });

  it('leaves an in-flight read of a DIFFERENT path cacheable', async () => {
    // The generation is path-scoped: sweeping plan must not stop a concurrent
    // power read from caching.
    const uri = scoped(SETTINGS_UI_POWER_PATH, AREA);
    const inFlight = getApiReadModel(uri);
    invalidateApiCacheForScopedHomes(SETTINGS_UI_PLAN_PATH);
    flushPending();
    await inFlight;
    expect(await getApiReadModel(uri)).toBe(`fetched:${uri}`);
    expect(deferredClient.api).toHaveBeenCalledTimes(1);
  });
});

describe('unavailable scoped responses', () => {
  // `homeScope: unavailable` is a REFUSAL, not data: the runtime answers it
  // while a home's membership is provisional, while its bundle is unwired, or
  // when a settings read behind the payload transiently fails. Each of those
  // clears without necessarily sweeping this path — a home committing its first
  // status writes `pels_status:<id>`, which the change router deliberately
  // excludes from the devices sweep — so a cached refusal would pin an empty
  // sub-home view for the rest of the WebView session.
  const responses: unknown[] = [];
  const client: HomeySettingsClient = {
    ready: () => Promise.resolve(),
    get: (_key: string, cb: HomeyCallback<unknown>) => cb(null, null),
    set: (_key: string, _value: unknown, cb: HomeyCallback<void>) => cb(null),
    api: vi.fn((_method, _uri, bodyOrCallback, cb) => {
      const callback = (typeof bodyOrCallback === 'function' ? bodyOrCallback : cb) as HomeyCallback<unknown>;
      callback(null, responses.shift() ?? null);
    }),
  };

  beforeEach(() => {
    setHomeyClient(null);
    setHomeyClient(client);
    vi.mocked(client.api!).mockClear();
    responses.length = 0;
  });

  it('refetches after a refusal, then caches the payload that resolves', async () => {
    const uri = scoped(SETTINGS_UI_DEVICES_PATH, AREA);
    const unavailable = { devices: [], homeScope: { state: 'unavailable' } };
    const resolved = { devices: [{ id: 'dev_1' }], homeScope: { state: 'resolved', homeId: AREA } };
    responses.push(unavailable, resolved);

    // The caller still gets the refusal it asked for…
    expect(await getApiReadModel(uri)).toEqual(unavailable);
    // …and the next read goes back to the runtime with NO invalidation in
    // between, so readiness that commits silently is picked up.
    expect(await getApiReadModel(uri)).toEqual(resolved);
    expect(client.api).toHaveBeenCalledTimes(2);

    // The resolved payload caches normally — this must not degrade into an
    // uncached read model.
    expect(await getApiReadModel(uri)).toEqual(resolved);
    expect(client.api).toHaveBeenCalledTimes(2);
  });

  it('caches a resolved scoped payload on the first read', async () => {
    const uri = scoped(SETTINGS_UI_POWER_PATH, AREA);
    const resolved = { tracker: null, status: null, homeScope: { state: 'resolved', homeId: AREA } };
    responses.push(resolved);

    expect(await getApiReadModel(uri)).toEqual(resolved);
    expect(await getApiReadModel(uri)).toEqual(resolved);
    expect(client.api).toHaveBeenCalledTimes(1);
  });

  it('caches a whole-home payload, which carries no homeScope at all', async () => {
    // The bare read models are byte-identical to the pre-multi-home ones, so
    // nothing here may make them refetch.
    const uri = SETTINGS_UI_DEVICES_PATH;
    responses.push({ devices: [{ id: 'dev_1' }] });

    expect(await getApiReadModel(uri)).toEqual({ devices: [{ id: 'dev_1' }] });
    expect(await getApiReadModel(uri)).toEqual({ devices: [{ id: 'dev_1' }] });
    expect(client.api).toHaveBeenCalledTimes(1);
  });
});
