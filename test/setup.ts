// Global test setup and teardown
import https from 'https';
import { EventEmitter } from 'events';

// Mock the homey-api module globally to route device actions to the in-memory mock.
jest.mock('homey-api', () => ({
  HomeyAPI: {
    createAppAPI: jest.fn().mockResolvedValue(require('./mocks/homey').mockHomeyApiInstance),
  },
}));

// Flag to temporarily allow console.error in tests that intentionally trigger errors
let allowConsoleError = false;
export const setAllowConsoleError = (allow: boolean): void => {
  allowConsoleError = allow;
};

// Fail fast on any console.error during tests to catch unexpected errors
let consoleErrorSpy: jest.SpyInstance;
let consoleLogSpy: jest.SpyInstance;
let httpsGetSpy: jest.SpyInstance | undefined;
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
      setTimeout: jest.Mock;
      destroy: jest.Mock;
    };
    request.setTimeout = jest.fn().mockReturnValue(request);
    request.destroy = jest.fn().mockReturnValue(request);

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
  httpsGetSpy = jest.spyOn(https, 'get').mockImplementation(mockHttpsGetImplementation());
};

beforeAll(() => {
  // JSDOM does not implement matchMedia; settings UI uses it for responsive behavior.
  const matchMediaStub = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(), // deprecated
    removeListener: jest.fn(), // deprecated
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  });
  if (typeof window !== 'undefined' && typeof (window as unknown as { matchMedia?: unknown }).matchMedia !== 'function') {
    (window as unknown as { matchMedia: typeof matchMediaStub }).matchMedia = matchMediaStub;
  }
  if (typeof (globalThis as unknown as { matchMedia?: unknown }).matchMedia !== 'function') {
    (globalThis as unknown as { matchMedia: typeof matchMediaStub }).matchMedia = matchMediaStub;
  }

  // Use deterministic network stubs in tests to avoid real outbound calls.
  const fetchStub = jest.fn().mockResolvedValue({
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

  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation((...args) => {
    // Suppress known/expected console errors when explicitly allowed.
    if (allowConsoleError) return;
    originalConsoleError(...args);
  });

  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

beforeEach(() => {
  // Some tests call jest.restoreAllMocks(); make sure the global no-network guard is reinstalled.
  const getFn = https.get as unknown as { _isMockFunction?: boolean };
  if (getFn._isMockFunction !== true) {
    installHttpsGetSpy();
  }
});

afterAll(() => {
  consoleErrorSpy.mockRestore();
  consoleLogSpy.mockRestore();
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
  jest.useRealTimers();
});
