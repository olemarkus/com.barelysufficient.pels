import type { HomeyCallback, HomeySettingsClient } from '../src/ui/homey.ts';

const setGlobalHomey = (value: unknown): void => {
  (globalThis as typeof globalThis & { Homey?: unknown }).Homey = value;
};

const clearGlobalHomey = (): void => {
  delete (globalThis as typeof globalThis & { Homey?: unknown }).Homey;
};

const createClient = (overrides: Partial<HomeySettingsClient> = {}): HomeySettingsClient => ({
  ready: vi.fn().mockResolvedValue(undefined),
  get: vi.fn(),
  set: vi.fn(),
  ...overrides,
});

describe('waitForHomey', () => {
  afterEach(async () => {
    clearGlobalHomey();
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(null);
    vi.resetModules();
  });

  it('accepts an already-created Homey settings client', async () => {
    const client = createClient();
    setGlobalHomey(client);

    const { getHomeyClient, waitForHomey } = await import('../src/ui/homey.ts');

    await expect(waitForHomey(1, 0)).resolves.toBe(client);
    expect(getHomeyClient()).toBe(client);
  });

  it('instantiates the Homey constructor exposed by my.homey.app', async () => {
    class HomeyConstructor implements HomeySettingsClient {
      ready(): Promise<void> {
        return Promise.resolve();
      }

      get(): void {}

      set(): void {}
    }
    setGlobalHomey(HomeyConstructor);

    const { getHomeyClient, waitForHomey } = await import('../src/ui/homey.ts');

    const client = await waitForHomey(1, 0);
    expect(client).toBeInstanceOf(HomeyConstructor);
    expect(getHomeyClient()).toBe(client);
  });
});

describe('callApi', () => {
  afterEach(async () => {
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(null);
    vi.resetModules();
  });

  it('wraps callback errors with endpoint context', async () => {
    const api = vi.fn((
      _method: string,
      _uri: string,
      bodyOrCallback: unknown,
      callback?: HomeyCallback<unknown>,
    ) => {
      const cb = typeof bodyOrCallback === 'function' ? bodyOrCallback : callback;
      cb?.(new Error('socket hang up'));
    });
    const { callApi, setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(createClient({ api }));

    await expect(callApi('GET', '/ui_power')).rejects.toThrow(
      'Homey api GET /ui_power failed: socket hang up',
    );
  });

  it('falls back to an empty body for GET when the SDK rejects the callback-only signature', async () => {
    const api = vi.fn((
      _method: string,
      _uri: string,
      bodyOrCallback: unknown,
      callback?: HomeyCallback<unknown>,
    ) => {
      if (typeof bodyOrCallback === 'function') {
        throw new Error('callback-only signature not supported');
      }
      callback?.(null, { ok: true });
    });
    const { callApi, setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(createClient({ api }));

    await expect(callApi('GET', '/ui_bootstrap')).resolves.toEqual({ ok: true });
    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenLastCalledWith('GET', '/ui_bootstrap', {}, expect.any(Function));
  });

  it('wraps synchronous SDK throws with endpoint context', async () => {
    const api = vi.fn(() => {
      throw new Error('sdk exploded');
    });
    const { callApi, setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(createClient({ api }));

    await expect(callApi('POST', '/ui_refresh_prices', {})).rejects.toThrow(
      'Homey api POST /ui_refresh_prices failed: sdk exploded',
    );
  });

  it('uses primed API cache before calling Homey', async () => {
    const api = vi.fn();
    const { getApiReadModel, primeApiCache, setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(createClient({ api }));

    primeApiCache('/ui_plan', { plan: { devices: [] } });

    await expect(getApiReadModel('/ui_plan')).resolves.toEqual({ plan: { devices: [] } });
    expect(api).not.toHaveBeenCalled();
  });

  it('rejects with endpoint context when the API function is missing', async () => {
    const { callApi, setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(createClient());

    await expect(callApi('GET', '/ui_bootstrap')).rejects.toThrow(
      'Homey api GET /ui_bootstrap not available',
    );
  });
});
