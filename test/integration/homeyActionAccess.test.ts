import { HomeyActionAccess, HOMEY_FLOW_API_KEY, type HomeyActionAccessHomey } from '../../lib/device/transport/homeyActionAccess';
import { getLogger } from '../../lib/logging/logger';

const KEY = 'private-test-credential';
const action = { ownerUri: 'homey:device:charger', cardId: 'homey:device:charger:charge_current', args: { current: 6 } };
function fixture() {
  const values = new Map<string, unknown>();
  const homey: HomeyActionAccessHomey = {
    settings: {
      get: (key) => values.get(key), getKeys: () => [...values.keys()],
      set: (key, value) => { values.set(key, value); }, unset: (key) => { values.delete(key); },
    },
    api: { getLocalUrl: async () => 'http://homey.local' },
    cloud: { getHomeyId: async () => 'test-homey' },
  };
  return { values, homey, access: new HomeyActionAccess(homey, { structuredLog: getLogger('test') }) };
}
function response(body: unknown, status = 200) {
  return { status, ok: status < 400, headers: { get: () => 'test-homey' }, json: async () => body };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('checks effective Flow scope before saving; exposes no credential', async () => {
  const fetchMock = vi.fn().mockResolvedValue(response({ intersectedScopes: ['homey.flow'] }));
  vi.stubGlobal('fetch', fetchMock);
  const { access, values } = fixture();
  expect(await access.save({ key: KEY })).toEqual({ configured: true, state: 'ready' });
  expect(values.get(HOMEY_FLOW_API_KEY)).toBe(KEY);
  expect(JSON.stringify(access.status())).not.toContain(KEY);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][1].method).toBe('GET');
});

test('rejects readonly scope without replacing a saved key', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ intersectedScopes: ['homey.flow.readonly'] })));
  const { access, values } = fixture();
  await expect(access.save({ key: KEY })).rejects.toThrow('Flow permission');
  expect(values.has(HOMEY_FLOW_API_KEY)).toBe(false);
});

test('executes one adapter action, without retry or app-token fallback', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(response({ intersectedScopes: ['homey.flow'] }))
    .mockResolvedValueOnce(response({ error: null }));
  vi.stubGlobal('fetch', fetchMock);
  const { access } = fixture();
  await access.save({ key: KEY });
  await access.runAction('charger', action, 'charging_current', () => {});
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const [url, options] = fetchMock.mock.calls[1];
  expect(String(url)).toContain('homey%3Adevice%3Acharger%3Acharge_current/run');
  expect(options).toMatchObject({ method: 'POST', redirect: 'error', body: JSON.stringify({ args: action.args }) });
});

test('removal while resolving the Homey address prevents a stale command', async () => {
  const fetchMock = vi.fn().mockResolvedValue(response({ intersectedScopes: ['homey.flow'] }));
  vi.stubGlobal('fetch', fetchMock);
  const { access, homey } = fixture();
  await access.save({ key: KEY });
  let resolveAddress!: (value: string) => void;
  homey.api.getLocalUrl = () => new Promise((resolve) => { resolveAddress = resolve; });
  const pending = access.runAction('charger', action, 'charging_current', () => {});
  access.remove();
  resolveAddress('http://homey.local');
  await expect(pending).rejects.toThrow('unavailable');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('caller timeout retains the per-device lock until the remote request completes', async () => {
  vi.useFakeTimers();
  let resolveWrite!: (value: ReturnType<typeof response>) => void;
  const fetchMock = vi.fn().mockResolvedValueOnce(response({ intersectedScopes: ['homey.flow'] }))
    .mockImplementationOnce(() => new Promise((resolve) => { resolveWrite = resolve; }));
  vi.stubGlobal('fetch', fetchMock);
  const { access } = fixture();
  await access.save({ key: KEY });
  const pending = access.runAction('charger', action, 'charging_current', () => {});
  const rejected = expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  await expect(access.runAction('charger', action, 'charging_current', () => {})).rejects.toThrow('unavailable');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  resolveWrite(response({ error: null }));
  await vi.advanceTimersByTimeAsync(0);
});

test('does not leak failed response bodies or network errors', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`network failure ${KEY}`)));
  const { access } = fixture();
  await expect(access.save({ key: KEY })).rejects.toThrow('unavailable');
  expect(await access.check()).toEqual({ configured: false, state: 'not_configured' });
});

test.each(['vendor', 'server', 'network'])('a %s command failure preserves access for other devices and later planned commands', async (failure) => {
  const fetchMock = vi.fn().mockResolvedValueOnce(response({ intersectedScopes: ['homey.flow'] }));
  if (failure === 'network') fetchMock.mockRejectedValueOnce(new Error('Connection closed'));
  else fetchMock.mockResolvedValueOnce(response({ error: 'Vehicle unavailable' }, failure === 'server' ? 503 : 200));
  fetchMock.mockResolvedValue(response({ error: null }));
  vi.stubGlobal('fetch', fetchMock);
  const { access } = fixture();
  await access.save({ key: KEY });
  await expect(access.runAction('charger', action, 'charging_current', () => {})).rejects.toThrow('unavailable');
  expect(access.status()).toEqual({ configured: true, state: 'ready' });
  await access.runAction('other-charger', action, 'charging_current', () => {});
  await access.runAction('charger', action, 'charging_current', () => {});
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

test.each([401, 403])('an HTTP %i rejection is rechecked before a later hand-back', async (status) => {
  const fetchMock = vi.fn().mockResolvedValueOnce(response({ intersectedScopes: ['homey.flow'] }))
    .mockResolvedValueOnce(response({}, status))
    .mockResolvedValueOnce(response({ intersectedScopes: ['homey.flow'] }))
    .mockResolvedValueOnce(response({ error: null }));
  vi.stubGlobal('fetch', fetchMock);
  const { access } = fixture();
  await access.save({ key: KEY });
  await expect(access.runAction('charger', action, 'charging_current', () => {})).rejects.toThrow('Flow permission');
  expect(access.status().state).toBe('permission_denied');
  await access.runAction('battery', action, 'home_battery', () => {});
  expect(access.status().state).toBe('ready');
  expect(fetchMock.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'POST', 'GET', 'POST']);
});

test('a denied key that still lacks Flow permission is rechecked without another POST', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(response({ intersectedScopes: ['homey.flow'] }))
    .mockResolvedValueOnce(response({}, 403))
    .mockResolvedValueOnce(response({ intersectedScopes: [] }));
  vi.stubGlobal('fetch', fetchMock);
  const { access } = fixture();
  await access.save({ key: KEY });
  await expect(access.runAction('battery', action, 'home_battery', () => {})).rejects.toThrow('Flow permission');
  await expect(access.runAction('battery', action, 'home_battery', () => {})).rejects.toThrow('Flow permission');
  expect(fetchMock.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'POST', 'GET']);
});

test('device observations recover denied access with bounded checks and no command', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(response({ intersectedScopes: [] }))
    .mockResolvedValueOnce(response({ intersectedScopes: [] }))
    .mockResolvedValueOnce(response({ intersectedScopes: ['homey.flow'] }));
  vi.stubGlobal('fetch', fetchMock);
  const { access, values } = fixture();
  values.set(HOMEY_FLOW_API_KEY, KEY);
  expect((await access.check()).state).toBe('permission_denied');

  const retry = access.retryDeniedAccess(1000);
  expect(access.retryDeniedAccess(1000)).toBe(retry);
  await retry;
  expect(access.status().state).toBe('permission_denied');
  await access.retryDeniedAccess(60_999);
  expect(fetchMock).toHaveBeenCalledTimes(2);

  await access.retryDeniedAccess(61_000);
  expect(access.status().state).toBe('ready');
  expect(fetchMock.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'GET', 'GET']);
});

test('a planned command rechecks access after a transient scope-check failure without replaying a POST', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(response({ intersectedScopes: ['homey.flow'] }))
    .mockRejectedValueOnce(new Error('Connection closed'))
    .mockResolvedValueOnce(response({ intersectedScopes: ['homey.flow'] }))
    .mockResolvedValueOnce(response({ error: null }));
  vi.stubGlobal('fetch', fetchMock);
  const { access } = fixture();
  await access.save({ key: KEY });
  expect((await access.check()).state).toBe('unavailable');
  await access.runAction('charger', action, 'charging_current', () => {});
  expect(access.status().state).toBe('ready');
  expect(fetchMock.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'GET', 'GET', 'POST']);
});

test('failed automatic access revalidation sends no device command', async () => {
  const fetchMock = vi.fn().mockRejectedValue(new Error('Connection closed'));
  vi.stubGlobal('fetch', fetchMock);
  const { access, values } = fixture();
  values.set(HOMEY_FLOW_API_KEY, KEY);
  await expect(access.runAction('charger', action, 'charging_current', () => {})).rejects.toThrow('unavailable');
  expect(fetchMock.mock.calls.map(([, options]) => options.method)).toEqual(['GET']);
});

test.each(['address', 'identity'])('bounds a stalled Homey %s lookup before making any HTTP request', async (lookup) => {
  vi.useFakeTimers();
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const { access, homey, values } = fixture();
  values.set(HOMEY_FLOW_API_KEY, KEY);
  let resolveLookup!: (value: string) => void;
  const stalled = () => new Promise<string>((resolve) => { resolveLookup = resolve; });
  if (lookup === 'address') homey.api.getLocalUrl = stalled;
  else homey.cloud.getHomeyId = stalled;
  const pending = access.check();
  await vi.advanceTimersByTimeAsync(10_000);
  await expect(pending).resolves.toEqual({ configured: true, state: 'unavailable' });
  expect(fetchMock).not.toHaveBeenCalled();
  resolveLookup(lookup === 'address' ? 'http://homey.local' : 'test-homey');
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).not.toHaveBeenCalled();
});
