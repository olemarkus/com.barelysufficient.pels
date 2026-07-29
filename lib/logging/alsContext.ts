import { AsyncLocalStorage } from 'node:async_hooks';

type LogContext = Record<string, unknown>;

const als = new AsyncLocalStorage<LogContext>();

export const getCurrentContext = (): LogContext => als.getStore() ?? {};

export const runWithContext = <T>(ctx: LogContext, fn: () => T): T => {
  const parent = getCurrentContext();
  const merged = { ...parent, ...ctx };
  return als.run(merged, fn);
};

/**
 * Starts a deliberately uncorrelated async branch. Use at a global handoff
 * (for example a whole-app refresh timer) that must not inherit the home or
 * rebuild which happened to schedule it.
 */
export const runWithoutContext = <T>(fn: () => T): T => als.run({}, fn);
