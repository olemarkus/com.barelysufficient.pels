import type { StructuredDebugEmitter, Logger as PinoLogger } from '../logging/logger';

/**
 * Logging/error sinks `PriceService` writes through, bundled into one object so the
 * constructor signature stops growing a positional param per sink.
 */
export type PriceServiceLoggingSinks = {
  debugStructured: StructuredDebugEmitter;
  errorLog?: (...args: unknown[]) => void;
  structuredLog: PinoLogger;
};
