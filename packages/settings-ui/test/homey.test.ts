import type { HomeySettingsClient } from '../src/ui/homey.ts';

const setGlobalHomey = (value: unknown): void => {
  (globalThis as typeof globalThis & { Homey?: unknown }).Homey = value;
};

const clearGlobalHomey = (): void => {
  delete (globalThis as typeof globalThis & { Homey?: unknown }).Homey;
};

describe('waitForHomey', () => {
  afterEach(async () => {
    clearGlobalHomey();
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(null);
    vi.resetModules();
  });

  it('accepts an already-created Homey settings client', async () => {
    const client = {
      ready: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
      set: vi.fn(),
    } satisfies HomeySettingsClient;
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
