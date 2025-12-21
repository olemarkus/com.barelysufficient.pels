export type HomeyCallback<T> = (err: Error | null, value?: T) => void;

export type HomeySettingsClient = {
  ready: () => Promise<void>;
  get: (key: string, cb: HomeyCallback<unknown>) => void;
  set: (key: string, value: unknown, cb: HomeyCallback<void>) => void;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
};

// Homey global injected by runtime.
declare const Homey: HomeySettingsClient;

type WindowWithHomey = Window & {
  Homey?: HomeySettingsClient;
};

let homeyClient: HomeySettingsClient | null = null;

export const getHomeyClient = () => homeyClient;

export const setHomeyClient = (client: HomeySettingsClient | null) => {
  homeyClient = client;
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
  return new Promise((resolve, reject) => {
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
    homeyClient?.set(key, value, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
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
      homeyClient = candidate;
      return candidate;
    }
    await sleep(interval);
  }
  return null;
};
