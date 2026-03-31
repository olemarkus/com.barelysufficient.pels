import { AsyncLocalStorage } from 'node:async_hooks';

type LogContext = Record<string, unknown>;

const als = new AsyncLocalStorage<LogContext>();

export const getCurrentContext = (): LogContext => als.getStore() ?? {};

export const runWithContext = <T>(ctx: LogContext, fn: () => T): T => {
  const parent = getCurrentContext();
  const merged = { ...parent, ...ctx };
  return als.run(merged, fn);
};
