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
    let forwarded = trimmed;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        level = typeof record.level === 'number' ? record.level : 0;
        // `level` is the one field that must be read here and must not be
        // forwarded: it is how a record is routed to Homey's error channel
        // rather than its log channel, and pino cannot express that routing in
        // the serialized line alone. `pid`/`hostname` are no longer emitted
        // (`base: null` in createRootLogger), so this is all that is stripped.
        const { level: _level, ...forwardRecord } = record;
        forwarded = JSON.stringify(forwardRecord);
      }
    } catch {
      // If parsing fails, treat as info-level and forward the raw line.
    }

    if (level >= PINO_ERROR_LEVEL) {
      callbacks.error(forwarded);
    } else {
      callbacks.log(forwarded);
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
