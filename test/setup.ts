// Global test setup and teardown
import https from 'https';
import { EventEmitter } from 'events';
import type { MockInstance } from 'vitest';
import { installCanvasContextStub } from './utils/canvasContextStub.ts';
import { resetLiveFeed } from './helpers/liveFeedSocketHarness.ts';

// Deterministic in-memory socket.io so the device live feed (lib/device/liveFeed.ts)
// NEVER opens a real websocket during tests. A real `io()` connect targets the local
// Homey API, ECONNREFUSEDs (`device_live_feed_connect_error`), and leaves pending real
// async (engine.io/ws timers) that fake-timer drains can't flush — the intermittent
// `*ShedControl` e2e flake under the all-tiers coverage run. This sits alongside the
// global `fetch`/`https.get` stubs below so NO runtime network seam reaches the wire in
// tests.
//
// The fake lives in `test/helpers/liveFeedSocketHarness.ts`. By default it refuses the
// connection, with no real I/O, so `start()`/`onInit` proceed without running the
// handshake/subscribe flow, whose microtasks would otherwise perturb a test's
// plan-cycle drain. A test that drives realtime device events calls
// `connectLiveFeed()` before init and emits frames through the same helper; the mode
// is reset after every test.
vi.mock('socket.io-client', async () => {
  const { liveFeedIo } = await import('./helpers/liveFeedSocketHarness.ts');
  return { io: liveFeedIo };
});

// Flag to temporarily allow console.error in tests that intentionally trigger errors
let allowConsoleError = false;
export const setAllowConsoleError = (allow: boolean): void => {
  allowConsoleError = allow;
};

// Fail fast on any console.error during tests to catch unexpected errors
let consoleErrorSpy: MockInstance;
export const getConsoleErrorSpy = (): MockInstance => consoleErrorSpy;
let consoleLogSpy: MockInstance;
let consoleWarnSpy: MockInstance;
let httpsGetSpy: MockInstance | undefined;
let originalFetch: typeof global.fetch | undefined;
let hadOriginalFetch = false;
let originalWindowFetch: typeof window.fetch | undefined;
let hadOriginalWindowFetch = false;
const originalConsoleError = console.error;

const mockHttpsGetImplementation = (): typeof https.get => (
  ((url: unknown, optionsOrCallback?: unknown, callbackMaybe?: unknown) => {
    let callback: ((res: NodeJS.EventEmitter) => void) | undefined;
    if (typeof optionsOrCallback === 'function') {
      callback = optionsOrCallback as (res: NodeJS.EventEmitter) => void;
    } else if (typeof callbackMaybe === 'function') {
      callback = callbackMaybe as (res: NodeJS.EventEmitter) => void;
    }

    const request = new EventEmitter() as NodeJS.EventEmitter & {
      setTimeout: MockInstance;
      destroy: MockInstance;
    };
    request.setTimeout = vi.fn().mockReturnValue(request);
    request.destroy = vi.fn().mockReturnValue(request);

    if (callback) {
      const response = new EventEmitter() as NodeJS.EventEmitter & {
        statusCode: number;
        statusMessage: string;
      };
      response.statusCode = 200;
      response.statusMessage = 'OK';
      callback(response);
      response.emit('data', '[]');
      response.emit('end');
    }

    return request as unknown as ReturnType<typeof https.get>;
  }) as typeof https.get
);

const installHttpsGetSpy = () => {
  if (httpsGetSpy) {
    httpsGetSpy.mockRestore();
  }
  httpsGetSpy = vi.spyOn(https, 'get').mockImplementation(mockHttpsGetImplementation());
};

beforeAll(() => {
  // JSDOM does not implement matchMedia; settings UI uses it for responsive behavior.
  const matchMediaStub = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
  if (typeof window !== 'undefined' && typeof (window as unknown as { matchMedia?: unknown }).matchMedia !== 'function') {
    (window as unknown as { matchMedia: typeof matchMediaStub }).matchMedia = matchMediaStub;
  }
  if (typeof (globalThis as unknown as { matchMedia?: unknown }).matchMedia !== 'function') {
    (globalThis as unknown as { matchMedia: typeof matchMediaStub }).matchMedia = matchMediaStub;
  }
  installCanvasContextStub();

  // Use deterministic network stubs in tests to avoid real outbound calls.
  const fetchStub = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ([]),
    text: async () => '[]',
  }) as typeof global.fetch;
  hadOriginalFetch = Object.prototype.hasOwnProperty.call(globalThis, 'fetch');
  originalFetch = global.fetch;
  global.fetch = fetchStub;
  if (typeof window !== 'undefined') {
    hadOriginalWindowFetch = Object.prototype.hasOwnProperty.call(window, 'fetch');
    originalWindowFetch = window.fetch;
    window.fetch = fetchStub as unknown as typeof window.fetch;
  }

  installHttpsGetSpy();

  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    // Suppress known/expected console errors when explicitly allowed.
    if (allowConsoleError) return;
    originalConsoleError(...args);
  });

  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  resetLiveFeed();
});

beforeEach(() => {
  // Some tests call vi.restoreAllMocks(); make sure the global no-network guard is reinstalled.
  if (!vi.isMockFunction(https.get)) {
    installHttpsGetSpy();
  }
});

afterAll(() => {
  consoleErrorSpy.mockRestore();
  consoleLogSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  httpsGetSpy?.mockRestore();
  if (hadOriginalFetch) {
    global.fetch = originalFetch as typeof global.fetch;
  } else {
    delete (global as unknown as { fetch?: typeof global.fetch }).fetch;
  }
  if (typeof window !== 'undefined') {
    if (hadOriginalWindowFetch) {
      window.fetch = originalWindowFetch as typeof window.fetch;
    } else {
      delete (window as unknown as { fetch?: typeof window.fetch }).fetch;
    }
  }
  // Ensure all timers are cleaned up after all tests complete
  vi.useRealTimers();
});
