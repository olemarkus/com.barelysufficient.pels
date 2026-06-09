import { isWidgetNotFound, maybeReloadOnOrphan } from '../../widgets/_shared/widgetRuntime';

type FakeStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

const memoryStorage = (): FakeStorage => {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
  };
};

const makeWindow = (sessionStorage: FakeStorage = memoryStorage()) => {
  const reload = vi.fn();
  const win = { sessionStorage, location: { reload } } as unknown as Window;
  return { win, reload, sessionStorage };
};

describe('isWidgetNotFound', () => {
  it('matches the host "Widget Not Found" rejection (Error or string, any case)', () => {
    expect(isWidgetNotFound(new Error('Widget Not Found'))).toBe(true);
    expect(isWidgetNotFound('widget not found')).toBe(true);
    expect(isWidgetNotFound(new Error('Homey api GET /headroom failed: widget not found'))).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isWidgetNotFound(new Error('App is not available'))).toBe(false);
    expect(isWidgetNotFound('boom')).toBe(false);
    expect(isWidgetNotFound(undefined)).toBe(false);
  });
});

describe('maybeReloadOnOrphan', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reloads once and records the attempt', () => {
    const { win, reload, sessionStorage } = makeWindow();
    expect(maybeReloadOnOrphan(win)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('pels-widget-orphan-reload-at')).toBe('1000000');
  });

  it('does not reload again within the suppression window (no infinite loop)', () => {
    const store = memoryStorage();
    const first = makeWindow(store);
    expect(maybeReloadOnOrphan(first.win)).toBe(true);

    // Same session (the flag survives the reload), 30s later → must not reload.
    vi.setSystemTime(1_030_000);
    const second = makeWindow(store);
    expect(maybeReloadOnOrphan(second.win)).toBe(false);
    expect(second.reload).not.toHaveBeenCalled();
  });

  it('allows another reload once the window has elapsed', () => {
    const store = memoryStorage();
    expect(maybeReloadOnOrphan(makeWindow(store).win)).toBe(true);

    vi.setSystemTime(1_000_000 + 61_000);
    const next = makeWindow(store);
    expect(maybeReloadOnOrphan(next.win)).toBe(true);
    expect(next.reload).toHaveBeenCalledTimes(1);
  });

  it('never throws or reloads when sessionStorage is unavailable (sandboxed iframe)', () => {
    const reload = vi.fn();
    const win = {
      get sessionStorage() { throw new Error('blocked'); },
      location: { reload },
    } as unknown as Window;
    expect(maybeReloadOnOrphan(win)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
