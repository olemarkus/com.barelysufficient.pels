import type { HomeyCallback, HomeySettingsClient } from '../src/ui/homey.ts';

const setGlobalHomey = (value: unknown): void => {
  (globalThis as typeof globalThis & { Homey?: unknown }).Homey = value;
  (window as Window & { Homey?: unknown }).Homey = value;
};

const clearGlobalHomey = (): void => {
  delete (globalThis as typeof globalThis & { Homey?: unknown }).Homey;
  delete (window as Window & { Homey?: unknown }).Homey;
};

const setHomeyReadyPromise = (value: Promise<unknown>): void => {
  (window as Window & { __PELS_HOMEY_READY__?: Promise<unknown> }).__PELS_HOMEY_READY__ = value;
};

const clearHomeyReadyPromise = (): void => {
  delete (window as Window & { __PELS_HOMEY_READY__?: Promise<unknown> }).__PELS_HOMEY_READY__;
};

const createClient = (overrides: Partial<HomeySettingsClient> = {}): HomeySettingsClient => ({
  ready: vi.fn().mockResolvedValue(undefined),
  get: vi.fn(),
  set: vi.fn(),
  ...overrides,
});

describe('waitForHomey', () => {
  afterEach(async () => {
    vi.useRealTimers();
    clearGlobalHomey();
    clearHomeyReadyPromise();
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

  it('accepts the Homey client delivered through onHomeyReady', async () => {
    const client = createClient();
    setHomeyReadyPromise(Promise.resolve(client));
    clearGlobalHomey();

    const { getHomeyClient, waitForHomey } = await import('../src/ui/homey.ts');

    await expect(waitForHomey(1, 0)).resolves.toBe(client);
    expect(getHomeyClient()).toBe(client);
  });

  it('does not instantiate constructor-shaped mocks', async () => {
    const HomeyConstructor = vi.fn();
    HomeyConstructor.prototype.ready = vi.fn();
    HomeyConstructor.prototype.get = vi.fn();
    setGlobalHomey(HomeyConstructor);

    const { waitForHomey } = await import('../src/ui/homey.ts');

    await expect(waitForHomey(1, 0)).resolves.toBeNull();
    expect(HomeyConstructor).not.toHaveBeenCalled();
  });

  it('does not add a second wait while the onHomeyReady promise is pending', async () => {
    vi.useFakeTimers();
    setHomeyReadyPromise(new Promise(() => {}));
    clearGlobalHomey();

    const { waitForHomey } = await import('../src/ui/homey.ts');

    let settled = false;
    const result = waitForHomey(2, 100).then((value) => {
      settled = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(199);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeNull();
    expect(settled).toBe(true);
  });
});

describe('callApi', () => {
  afterEach(async () => {
    vi.useRealTimers();
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(null);
    vi.resetModules();
  });

  it('wraps callback errors with endpoint context', async () => {
    vi.useFakeTimers();
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

    const pending = callApi('GET', '/ui_power');
    const settled = expect(pending).rejects.toThrow(
      'Homey api GET /ui_power failed: socket hang up',
    );
    // Retry schedule fires at 250ms then 750ms; advance past both to surface
    // the final rejection.
    await vi.advanceTimersByTimeAsync(1100);
    await settled;
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('retries transient GET failures and resolves on a later attempt', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const api = vi.fn((
      _method: string,
      _uri: string,
      bodyOrCallback: unknown,
      callback?: HomeyCallback<unknown>,
    ) => {
      attempts += 1;
      const cb = typeof bodyOrCallback === 'function' ? bodyOrCallback : callback;
      if (attempts === 1) {
        cb?.(new Error('Network request failed'));
        return;
      }
      cb?.(null, { ok: true });
    });
    const { callApi, setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(createClient({ api }));

    const pending = callApi('GET', '/ui_bootstrap');
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-transient GET failures', async () => {
    const api = vi.fn((
      _method: string,
      _uri: string,
      bodyOrCallback: unknown,
      callback?: HomeyCallback<unknown>,
    ) => {
      const cb = typeof bodyOrCallback === 'function' ? bodyOrCallback : callback;
      cb?.(new Error('boom'));
    });
    const { callApi, setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(createClient({ api }));

    await expect(callApi('GET', '/ui_power')).rejects.toThrow(
      'Homey api GET /ui_power failed: boom',
    );
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('does not retry POST requests on transient transport failures', async () => {
    const api = vi.fn((
      _method: string,
      _uri: string,
      bodyOrCallback: unknown,
      callback?: HomeyCallback<unknown>,
    ) => {
      const cb = typeof bodyOrCallback === 'function' ? bodyOrCallback : callback;
      cb?.(new Error('Network request failed'));
    });
    const { callApi, setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(createClient({ api }));

    await expect(callApi('POST', '/ui_log', { level: 'info' })).rejects.toThrow(
      'Homey api POST /ui_log failed: Network request failed',
    );
    expect(api).toHaveBeenCalledTimes(1);
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
    vi.useFakeTimers();
    const { callApi, setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(createClient());

    const pending = callApi('GET', '/ui_bootstrap');
    const settled = expect(pending).rejects.toThrow(
      'Homey api GET /ui_bootstrap not available',
    );
    // "Homey api ... not available" is treated as a transient SDK-warmup error,
    // so the GET path retries 2x before surfacing the final rejection.
    await vi.advanceTimersByTimeAsync(1100);
    await settled;
  });

  it('retries POST writes that surface PELS_APP_NOT_READY until the runtime responds', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const api = vi.fn((
      _method: string,
      _uri: string,
      bodyOrCallback: unknown,
      callback?: HomeyCallback<unknown>,
    ) => {
      attempts += 1;
      const cb = typeof bodyOrCallback === 'function' ? bodyOrCallback : callback;
      if (attempts <= 2) {
        cb?.(new Error('PELS_APP_NOT_READY: Refresh devices unavailable while PELS is starting'));
        return;
      }
      cb?.(null, { devices: [] });
    });
    const { callApi, setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(createClient({ api }));

    // POST is normally not retried for transient transport errors, but
    // the App-Not-Ready sentinel is a runtime-only signal (not a partial
    // write), so retrying is safe and matches TODO 744's "loading state".
    const pending = callApi('POST', '/ui_refresh_devices', {});
    await vi.advanceTimersByTimeAsync(1000); // 250 + 500
    await expect(pending).resolves.toEqual({ devices: [] });
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('surfaces the App-Not-Ready error after the retry budget is exhausted', async () => {
    vi.useFakeTimers();
    const api = vi.fn((
      _method: string,
      _uri: string,
      bodyOrCallback: unknown,
      callback?: HomeyCallback<unknown>,
    ) => {
      const cb = typeof bodyOrCallback === 'function' ? bodyOrCallback : callback;
      cb?.(new Error('PELS_APP_NOT_READY: Refresh prices unavailable while PELS is starting'));
    });
    const { callApi, setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(createClient({ api }));

    const pending = callApi('POST', '/ui_refresh_prices', {});
    const settled = expect(pending).rejects.toThrow(/PELS_APP_NOT_READY/);
    // Walk past every entry in the App-Not-Ready backoff schedule
    // (250 + 500 + 1000 + 1500 + 2000 + 3000 = 8250ms) plus a buffer.
    await vi.advanceTimersByTimeAsync(9000);
    await settled;
  });
});
