import pino from 'pino';
import type { Logger as PinoLogger } from 'pino';
import type { Writable } from 'node:stream';
import { getCurrentContext, runWithContext } from './alsContext';

export type { Logger } from 'pino';
export type StructuredDebugEmitter = (payload: Record<string, unknown>) => void;

/**
 * Cross-cutting logger bundle every consumer takes. Structured-only:
 * the legacy prose loggers (`log`/`logDebug`/`error`) are being removed
 * per consumer as part of the Phase 4 RuntimeContext narrowing. New code
 * must emit through `structuredLog` (info/error/etc. via JSON payloads)
 * or `debugStructured` (topic-gated JSON debug events).
 *
 * Topic-specific `*DebugStructured` emitters stay separate — those belong
 * on the domain context for the concern they instrument, not on the
 * cross-cutting bundle.
 *
 * Both inner fields are optional so test harnesses can omit logging
 * entirely. The production contract is established by `createPlanService`
 * (lib/app/appInit.ts) which always supplies both emitters — a unit test
 * passing `{}` is not evidence the call site is safe.
 */
export type Loggers = {
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
};

export const createRootLogger = (destination: Writable, level = 'info'): pino.Logger => pino(
  {
    level,
    timestamp: false,
    mixin: () => ({ ...getCurrentContext() }),
  },
  destination,
);

export const withRebuildContext = <T>(rebuildId: string, fn: () => T): T => (
  runWithContext({ rebuildId }, fn)
);
