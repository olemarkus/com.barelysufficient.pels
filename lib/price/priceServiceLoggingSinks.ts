import { getDebugEmitter, type Logger as PinoLogger } from '../logging/logger';

/**
 * Logging/error sinks `PriceService` writes through, bundled into one object so the
 * constructor signature stops growing a positional param per sink.
 */
export type PriceServiceLoggingSinks = {
  errorLog?: (...args: unknown[]) => void;
  structuredLog: PinoLogger;
};

/** The `price` debug topic, where `PriceService` writes its debug events. */
export const emitPriceDebug = getDebugEmitter('price', 'price');
