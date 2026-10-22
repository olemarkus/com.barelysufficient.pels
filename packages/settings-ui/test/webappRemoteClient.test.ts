import {
  createRemoteEventHub,
  createRemoteHomeyClient,
  createRemoteRequest,
  RemoteHomeyError,
  type RemoteFetch,
} from '../src/remote/remoteHomeyClient.ts';
import type { StoredHomey } from '../src/remote/remoteConnection.ts';
import { createRemoteTarget, handOverAddress, takeHandedAddress } from '../src/remote/remoteTarget.ts';
import type { HomeySettingsClient } from '../src/ui/homey.ts';

const homey: StoredHomey = {
  name: 'House',
  baseUrl: 'https://homey.example',
  homeyId: '65687b03c6bcab0c0a4464c3',
  token: 'u:s:t',
  localUrl: 'https://192-168-1-50.homey.homeylocal.com',
};

const respond = (status: number, body: string): Response => new Response(status === 204 ? null : body, { status });

const setup = (response: () => Response | Promise<Response>) => {
  const fetchImpl = vi.fn<RemoteFetch>(async () => response());
  const events = createRemoteEventHub();
  const request = createRemoteRequest(createRemoteTarget(homey, 'cloud'), fetchImpl, () => {});
  const client = createRemoteHomeyClient(request, events, 'Europe/Oslo');
  return { client, events, fetchImpl };
};

const call = <T>(run: (callback: (err: Error | null, value?: T) => void) => void) => (
  new Promise<T | undefined>((resolve, reject) => {
    run((err, value) => (err ? reject(err) : resolve(value)));
  })
);

const callApi = (client: HomeySettingsClient, method: 'GET' | 'POST', uri: string, body?: unknown) => (
  call<unknown>((callback) => (body === undefined
    ? client.api?.(method, uri, callback)
    : client.api?.(method, uri, body, callback)))
);

describe('remote Homey client', () => {
  it('reads and writes settings through the app-settings endpoints', async () => {
    const { client, fetchImpl } = setup(() => respond(200, '{"a":1}'));

    await expect(call((callback) => client.get('homes_config', callback))).resolves.toEqual({ a: 1 });
    await call<void>((callback) => client.set('homes_config', { a: 2 }, callback));

    expect(fetchImpl.mock.calls.map(([url, init]) => [init.method, url, init.body])).toEqual([
      ['GET', 'https://homey.example/api/manager/apps/app/com.barelysufficient.pels/setting/homes_config', undefined],
      ['PUT', 'https://homey.example/api/manager/apps/app/com.barelysufficient.pels/setting/homes_config', '{"value":{"a":2}}'],
    ]);
    expect(fetchImpl.mock.calls[0]?.[1].headers).toEqual({ Authorization: 'Bearer u:s:t' });
  });

  it('calls the app routes with the body only on writes', async () => {
    const { client, fetchImpl } = setup(() => respond(200, '{"ok":true}'));

    await expect(callApi(client, 'GET', '/ui_plan')).resolves.toEqual({ ok: true });
    await callApi(client, 'POST', '/ui_smart_task_cancel', { id: 'task-1' });

    expect(fetchImpl.mock.calls.map(([url, init]) => [init.method, url, init.body])).toEqual([
      ['GET', 'https://homey.example/api/app/com.barelysufficient.pels/ui_plan', undefined],
      ['POST', 'https://homey.example/api/app/com.barelysufficient.pels/ui_smart_task_cancel', '{"id":"task-1"}'],
    ]);
  });

  it.each([
    ['the app error', 500, '{"error":"PELS_APP_NOT_READY: starting","statusCode":500}', 'PELS_APP_NOT_READY: starting'],
    ['an unknown route', 404, '<pre>Cannot GET /api/app/com.barelysufficient.pels/ui_x</pre>', 'Cannot GET /api/app/com.barelysufficient.pels/ui_x'],
    ['a bare status', 502, '', 'HTTP 502'],
  ])('keeps %s as the error message the UI classifies', async (_label, status, body, message) => {
    const { client } = setup(() => respond(status, body));
    const failure = callApi(client, 'GET', '/ui_x');
    await expect(failure).rejects.toThrow(message);
    await expect(failure).rejects.toMatchObject({ status });
  });

  it('reports a transport failure in the wording the UI retries', async () => {
    const { client } = setup(() => {
      throw new TypeError('Failed to fetch');
    });
    const failure = callApi(client, 'GET', '/ui_plan');
    await expect(failure).rejects.toBeInstanceOf(RemoteHomeyError);
    await expect(failure).rejects.toThrow('Network request failed (Failed to fetch)');
  });

  // A link cannot skip the check that this Homey answers at home: only the
  // launcher, in the same tab, hands the address it checked over, and only once.
  it('takes a handed-over address once, only for its Homey, and only while stored', () => {
    const local = homey.localUrl ?? '';
    handOverAddress(homey.homeyId, local);
    expect(takeHandedAddress({ ...homey, homeyId: '6acdea6cd18dc40482d6bc10' })).toBeNull();
    handOverAddress(homey.homeyId, local);
    expect(takeHandedAddress(homey)).toBe('local');
    expect(takeHandedAddress(homey)).toBeNull();
    handOverAddress(homey.homeyId, local);
    expect(takeHandedAddress({ ...homey, localUrl: 'https://10-0-0-9.homey.homeylocal.com' })).toBeNull();
    handOverAddress(homey.homeyId, homey.baseUrl);
    expect(takeHandedAddress(homey)).toBe('cloud');
  });

  describe('when the home network stops answering', () => {
    const offHome = () => {
      const target = createRemoteTarget(homey, 'local');
      const moved = vi.fn();
      target.onMove(moved);
      const fetchImpl = vi.fn<RemoteFetch>(async (url) => {
        if (url.startsWith(homey.localUrl ?? '')) throw new TypeError('Failed to fetch');
        return respond(200, '{"ok":true}');
      });
      return { target, moved, fetchImpl, request: createRemoteRequest(target, fetchImpl, () => {}) };
    };
    const origins = (fetchImpl: ReturnType<typeof vi.fn<RemoteFetch>>) => (
      fetchImpl.mock.calls.map(([url]) => new URL(url).origin)
    );

    it('reads from the cloud instead, and moves the page there once', async () => {
      const { target, moved, fetchImpl, request } = offHome();

      await expect(request('GET', '/a')).resolves.toEqual({ ok: true });
      await request('GET', '/b');

      expect(origins(fetchImpl)).toEqual([
        'https://192-168-1-50.homey.homeylocal.com', 'https://homey.example', 'https://homey.example',
      ]);
      expect(target.address()).toBe('cloud');
      expect(moved).toHaveBeenCalledTimes(1);
    });

    it('sends every read that was under way to the cloud, not only the first', async () => {
      const { fetchImpl, request } = offHome();

      await expect(Promise.all([request('GET', '/a'), request('GET', '/b')])).resolves.toEqual([{ ok: true }, { ok: true }]);
      expect(origins(fetchImpl).filter((origin) => origin === 'https://homey.example')).toHaveLength(2);
    });

    // The write may have reached Homey before the connection dropped.
    it('does not send a write a second time', async () => {
      const { target, fetchImpl, request } = offHome();

      await expect(request('POST', '/ui_smart_task_create', { id: 't' })).rejects.toThrow('Network request failed');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(target.address()).toBe('cloud');
    });

    it('gives up on a home-network call that gets no answer', async () => {
      vi.useFakeTimers();
      try {
        const target = createRemoteTarget(homey, 'local');
        const fetchImpl = vi.fn<RemoteFetch>((url, init) => (url.startsWith(homey.localUrl ?? '')
          ? new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          })
          : Promise.resolve(respond(200, '{"ok":true}'))));
        const result = createRemoteRequest(target, fetchImpl, () => {})('GET', '/a');

        await vi.advanceTimersByTimeAsync(10_000);

        await expect(result).resolves.toEqual({ ok: true });
        expect(target.address()).toBe('cloud');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('while Homey\'s cloud refuses calls', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('waits, sends the call again, and reports the wait', async () => {
      const answers = [respond(429, ''), respond(429, ''), respond(200, '{"ok":true}')];
      const fetchImpl = vi.fn<RemoteFetch>(async () => answers.shift() ?? respond(500, ''));
      const busy = vi.fn();
      const result = createRemoteRequest(createRemoteTarget(homey, 'cloud'), fetchImpl, busy)('PUT', '/x', { a: 1 });

      await vi.advanceTimersByTimeAsync(10_000);

      await expect(result).resolves.toEqual({ ok: true });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(fetchImpl.mock.calls.every(([, init]) => init.body === '{"a":1}')).toBe(true);
      expect(busy.mock.calls).toEqual([[true], [false]]);
    });

    it('stays busy while any call still waits', async () => {
      const waiting = [respond(429, ''), respond(200, '{"ok":true}')];
      const fetchImpl = vi.fn<RemoteFetch>(async (url) => (url.endsWith('/slow') ? waiting.shift()! : respond(200, '{}')));
      const busy = vi.fn();
      const request = createRemoteRequest(createRemoteTarget(homey, 'cloud'), fetchImpl, busy);
      const slow = request('GET', '/slow');
      await vi.advanceTimersByTimeAsync(0);

      await request('GET', '/quick');
      expect(busy.mock.calls).toEqual([[true]]);

      await vi.advanceTimersByTimeAsync(3_000);
      await slow;
      expect(busy.mock.calls).toEqual([[true], [false]]);
    });

    it('gives up after about a minute', async () => {
      const fetchImpl = vi.fn<RemoteFetch>(async () => respond(429, ''));
      const busy = vi.fn();
      const result = createRemoteRequest(createRemoteTarget(homey, 'cloud'), fetchImpl, busy)('GET', '/x');
      const settled = expect(result).rejects.toMatchObject({ status: 429 });

      await vi.advanceTimersByTimeAsync(90_000);

      await settled;
      expect(fetchImpl).toHaveBeenCalledTimes(6);
      expect(busy).toHaveBeenLastCalledWith(false);
    });
  });

  it('hands each event payload to the listeners as the WebView does', () => {
    const { client, events } = setup(() => respond(204, ''));
    const onSettings = vi.fn();
    const onPlan = vi.fn();
    client.on?.('settings.set', onSettings);
    client.on?.('plan_updated', onPlan);

    events.dispatch('settings.set', 'homes_config');
    events.dispatch('power_updated', {});

    expect(onSettings).toHaveBeenCalledWith('homes_config');
    expect(onPlan).not.toHaveBeenCalled();
  });

  it('gives the UI a timezone', () => {
    expect(setup(() => respond(204, '')).client.clock?.getTimezone?.()).toBe('Europe/Oslo');
  });
});
