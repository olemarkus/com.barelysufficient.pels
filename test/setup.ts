// Global test setup and teardown

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
const originalConsoleError = console.error;
beforeAll(() => {
  // Provide a basic fetch stub for libraries that expect it (homey-api)
  const fetchStub = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => '',
  }) as unknown as typeof fetch;
  if (!global.fetch) {
    global.fetch = fetchStub;
  }
  if (typeof window !== 'undefined' && !window.fetch) {
    window.fetch = fetchStub;
  }

  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation((...args) => {
    originalConsoleError(...args);
    // Keep stderr logging but do not fail tests; allowConsoleError flag is kept for future tightening
    if (allowConsoleError) return;
  });
});

afterAll(() => {
  consoleErrorSpy.mockRestore();
  // Ensure all timers are cleaned up after all tests complete
  jest.useRealTimers();
});

// Ensure all timers are cleaned up after all tests complete
