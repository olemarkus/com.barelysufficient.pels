import { Writable } from 'node:stream';

const PINO_ERROR_LEVEL = 50;

export type HomeyLogCallbacks = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export const createHomeyDestination = (callbacks: HomeyLogCallbacks): Writable => new Writable({
  write(chunk: Buffer | string, _encoding: string, callback: (error?: Error | null) => void): void {
    try {
      const line = typeof chunk === 'string' ? chunk : chunk.toString();
      const trimmed = line.endsWith('\n') ? line.slice(0, -1) : line;

      let level = 0;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && 'level' in parsed) {
          level = typeof (parsed as { level: unknown }).level === 'number'
            ? (parsed as { level: number }).level
            : 0;
        }
      } catch {
        // If parsing fails, treat as info-level and forward the raw line.
      }

      if (level >= PINO_ERROR_LEVEL) {
        callbacks.error(trimmed);
      } else {
        callbacks.log(trimmed);
      }
    } catch {
      // Never throw into app code.
    }
    callback();
  },
});
