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
 *
 * Events emitted through `getDebugEmitter(component, topic)` are gated on the
 * enabled topic set as well as the level, so the capture switches every topic
 * on by default and `restore()` switches them all back off. Pass a narrower
 * list to assert that a topic gate actually closes.
 *
 * Switch a topic on THROUGH THIS HELPER rather than calling `setDebugTopics`
 * directly. The topic set is process-wide and a debug child sits at
 * `level: 'debug'`, which outranks even the default silent root — so an enabled
 * topic with no capture installed writes to the real stdout, in a lane that
 * runs with `silent: true` and will not show you where it came from. The
 * capture owns the destination and the reset together.
 */
import { PassThrough } from 'node:stream';
import { createRootLogger, setDebugTopics, setRootLogger } from '../../lib/logging/logger';
import {
  ALL_DEBUG_LOGGING_TOPICS,
  type DebugLoggingTopic,
} from '../../packages/shared-domain/src/utils/debugLogging';

export type CapturedLogLine = Record<string, unknown> & { event?: string; msg?: string };

export type LoggerCapture = {
  events: CapturedLogLine[];
  findEvent: (event: string) => CapturedLogLine | undefined;
  findEvents: (event: string) => CapturedLogLine[];
  eventNames: () => (string | undefined)[];
  restore: () => void;
};

export const captureLogger = (
  level: 'debug' | 'info' | 'silent' = 'debug',
  topics: readonly DebugLoggingTopic[] = ALL_DEBUG_LOGGING_TOPICS,
): LoggerCapture => {
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
  setDebugTopics(new Set(topics));
  return {
    events,
    findEvent: (event) => events.find((e) => e.event === event),
    findEvents: (event) => events.filter((e) => e.event === event),
    eventNames: () => events.map((e) => e.event),
    restore: () => {
      setRootLogger(createRootLogger(new PassThrough(), 'silent'));
      setDebugTopics(new Set());
    },
  };
};
