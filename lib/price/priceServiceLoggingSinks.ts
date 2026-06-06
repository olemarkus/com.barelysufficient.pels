import type { StructuredDebugEmitter, Logger as PinoLogger } from '../logging/logger';

/**
 * Logging/error sinks `PriceService` writes through, bundled into one object so the
 * constructor signature stops growing a positional param per sink. `log` is now only the
 * httpClient SSL-fallback passthrough; the rest are the structured/error emitters.
 */
export type PriceServiceLoggingSinks = {
  log: (...args: unknown[]) => void;
  debugStructured: StructuredDebugEmitter;
  errorLog?: (...args: unknown[]) => void;
  structuredLog?: PinoLogger;
};
