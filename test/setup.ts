// Global test setup and teardown

// Ensure all timers are cleaned up after all tests complete
afterAll(() => {
  jest.useRealTimers();
});
