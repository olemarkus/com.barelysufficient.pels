import { Writable } from 'node:stream';

const PINO_ERROR_LEVEL = 50;

export type HomeyLogCallbacks = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export const createHomeyDestination = (callbacks: HomeyLogCallbacks): Writable => {
  let pending = '';

  const flushLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;

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
  };

  return new Writable({
    write(chunk: Buffer | string, _encoding: string, callback: (error?: Error | null) => void): void {
      try {
        pending += typeof chunk === 'string' ? chunk : chunk.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.length > 0 ? (lines[lines.length - 1] ?? '') : '';
        for (const line of lines.slice(0, -1)) {
          flushLine(line);
        }
      } catch {
        // Never throw into app code.
      }
      callback();
    },
    final(callback: (error?: Error | null) => void): void {
      try {
        flushLine(pending);
        pending = '';
      } catch {
        // Never throw into app code.
      }
      callback();
    },
  });
};
