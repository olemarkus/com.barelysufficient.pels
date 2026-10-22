import {
  createRemoteEventHub,
  createRemoteHomeyClient,
  createRemoteRequest,
  RemoteHomeyError,
  type RemoteFetch,
} from '../src/remote/remoteHomeyClient.ts';
import type { HomeySettingsClient } from '../src/ui/homey.ts';

const connection = { baseUrl: 'https://homey.example', homeyId: '65687b03c6bcab0c0a4464c3', token: 'u:s:t' };

const respond = (status: number, body: string): Response => new Response(status === 204 ? null : body, { status });

const setup = (response: () => Response | Promise<Response>) => {
  const fetchImpl = vi.fn<RemoteFetch>(async () => response());
  const events = createRemoteEventHub();
  const client = createRemoteHomeyClient(createRemoteRequest(connection, fetchImpl), events, 'Europe/Oslo');
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
