import { vi } from 'vitest';
import type { Loggers } from '../../lib/logging/logger';

/**
 * Full pino-shaped structured logger mock. Plan-layer consumers call
 * `info` / `error` / `warn` / `debug` via `loggers.structuredLog` —
 * stub every level so tests don't crash when production code emits
 * through a level the test doesn't assert on.
 */
export const createStructuredLogMock = () => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
});

/**
 * Full Loggers bundle for tests that don't need to inspect emissions.
 * Returns the bundle and the mocks separately so tests can assert
 * `structuredLog.error` / `debugStructured` directly.
 */
export const createLoggersMock = (): {
  loggers: Loggers;
  structuredLog: ReturnType<typeof createStructuredLogMock>;
  debugStructured: ReturnType<typeof vi.fn>;
} => {
  const structuredLog = createStructuredLogMock();
  const debugStructured = vi.fn();
  return {
    loggers: { structuredLog: structuredLog as never, debugStructured },
    structuredLog,
    debugStructured,
  };
};
