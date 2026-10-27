import type { HomeySettingsClient } from '../src/ui/homey.ts';

const boot = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/ui/boot.ts', () => ({ boot: (...args: unknown[]) => boot(...args) }));
vi.mock('../src/remote/remoteRealtime.ts', () => ({ connectRemoteRealtime: () => () => {} }));

const HOMEY_ID = '111111111111111111111111';
const VERSION = '3.23.4';
const APP_PATH = '/api/app/com.barelysufficient.pels';
const respond = (body: unknown) => new Response(JSON.stringify(body));

describe('web app startup', () => {
  beforeEach(() => {
    vi.resetModules();
    boot.mockClear();
    document.body.innerHTML = '';
    window.sessionStorage.clear();
    window.localStorage.setItem('pels.webapp.homeys.v1', JSON.stringify({
      homeys: [{ name: 'House', baseUrl: `https://${HOMEY_ID}.connect.athom.com`, homeyId: HOMEY_ID, token: 'u:s:t' }],
      lastHomeyId: HOMEY_ID,
    }));
    vi.stubGlobal('__PELS_WEB_APP_VERSION__', VERSION);
  });

  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts the bootstrap before the version check finishes but waits to boot', async () => {
    let answerVersion!: (response: Response) => void;
    const version = new Promise<Response>((resolve) => { answerVersion = resolve; });
    const bootstrap = { settings: { operating_mode: 'Home' } };
    const fetch = vi.fn(async (input: string) => (
      new URL(input).pathname.endsWith('/ui_version') ? version : respond(bootstrap)
    ));
    vi.stubGlobal('fetch', fetch);
    const ready = vi.fn();
    vi.stubGlobal('onHomeyReady', ready);

    await import('../src/remote/remoteEntry.ts');
    await vi.waitFor(() => expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      `${APP_PATH}/ui_bootstrap`, `${APP_PATH}/ui_version`,
    ]));
    expect(boot).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();

    answerVersion(respond({ version: VERSION, timeZone: 'Europe/Oslo' }));
    await vi.waitFor(() => expect(boot).toHaveBeenCalledOnce());
    const client = ready.mock.calls[0]?.[0] as HomeySettingsClient;
    const data = await new Promise((resolve, reject) => {
      client.api?.('GET', '/ui_bootstrap', (error: Error | null, value?: unknown) => (
        error ? reject(error) : resolve(value)
      ));
    });
    expect(data).toEqual(bootstrap);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['version', 'key-refused'])('does not boot a rejected build (%s), even if the prefetch fails', async (reason) => {
    const replace = vi.fn();
    vi.stubGlobal('location', { ...window.location, replace });
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (new URL(input).pathname.endsWith('/ui_bootstrap')) throw new TypeError('Failed to fetch');
      return reason === 'version'
        ? respond({ version: '3.24.0', timeZone: 'Europe/Oslo' })
        : new Response('{"error":"Invalid Session"}', { status: 401 });
    }));

    await import('../src/remote/remoteEntry.ts');
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
    expect(boot).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith(`../?${reason === 'version' ? 'open' : 'reauth'}=${HOMEY_ID}`);
  });
});
