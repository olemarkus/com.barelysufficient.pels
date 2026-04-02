import pino from 'pino';
import type { Writable } from 'node:stream';
import { getCurrentContext, runWithContext } from './alsContext';

export type { Logger } from 'pino';

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
