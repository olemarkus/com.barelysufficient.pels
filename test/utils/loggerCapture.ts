/**
 * Test helper that captures log output emitted via `getLogger(...)`.
 *
 * Usage:
 *   let capture: ReturnType<typeof captureLogger>;
 *   beforeEach(() => { capture = captureLogger(); });
 *   afterEach(() => { capture.restore(); });
 *
 *   // ... exercise code that calls logger.info / .debug / .error ...
 *
 *   expect(capture.findEvent('binary_command_succeeded')).toMatchObject({
 *     deviceId: 'socket1',
 *     desired: true,
 *   });
 */
import { PassThrough } from 'node:stream';
import { createRootLogger, setRootLogger } from '../../lib/logging/logger';

export type CapturedLogLine = Record<string, unknown> & { event?: string; msg?: string };

export type LoggerCapture = {
  events: CapturedLogLine[];
  findEvent: (event: string) => CapturedLogLine | undefined;
  findEvents: (event: string) => CapturedLogLine[];
  eventNames: () => (string | undefined)[];
  restore: () => void;
};

export const captureLogger = (level: 'debug' | 'info' | 'silent' = 'debug'): LoggerCapture => {
  const dest = new PassThrough();
  const events: CapturedLogLine[] = [];
  let buffer = '';
  dest.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        try {
          events.push(JSON.parse(line) as CapturedLogLine);
        } catch {
          // Non-JSON line — skip; production transport always emits JSON.
        }
      }
      idx = buffer.indexOf('\n');
    }
  });
  setRootLogger(createRootLogger(dest, level));
  return {
    events,
    findEvent: (event) => events.find((e) => e.event === event),
    findEvents: (event) => events.filter((e) => e.event === event),
    eventNames: () => events.map((e) => e.event),
    restore: () => {
      setRootLogger(createRootLogger(new PassThrough(), 'silent'));
    },
  };
};
