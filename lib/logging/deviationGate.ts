import { shouldEmitOnChange, type LogDedupeEntry } from './logDedupe';
import type { Logger as PinoLogger, StructuredDebugEmitter } from './logger';

/**
 * A structured line is "surprising" when its values are out of their expected
 * band — the caller computes this from the line's own expected-vs-observed
 * fields, keeping the predicate at the producer (no cross-layer state).
 */
export type DeviationSurprise = { level: 'info' | 'warn'; reasonCode: string } | null;

/**
 * Routes a structured log line by whether its values are surprising.
 *
 * - `surprise` set  → emit on the ungated `logger` at the given level (so the
 *   line reaches a no-debug diagnostics report) with `reasonCode` attached. An
 *   optional `dedupe` window keyed on the surprise signature collapses a
 *   *persistent* anomaly to one line + heartbeat instead of one per cycle.
 * - `surprise` null → route to the topic-gated `debugEmitter`: invisible by
 *   default, available when the debug topic is on.
 *
 * The promoted line must be self-contained (carry expected AND observed values)
 * so it survives the 100-line ring buffer in isolation. See
 * `notes/logging/diagnostics-report-deviation-gating.md`.
 */
export function emitGated(args: {
  logger: PinoLogger | undefined;
  debugEmitter: StructuredDebugEmitter;
  event: string;
  fields: Record<string, unknown>;
  surprise: DeviationSurprise;
  dedupe?: {
    state: Map<string, LogDedupeEntry>;
    key: string;
    now: number;
    repeatAfterMs?: number;
    pruneOlderThanMs?: number;
  };
}): void {
  const {
    logger, debugEmitter, event, fields, surprise, dedupe,
  } = args;

  // Build the payload once, carrying reasonCode whenever the line is surprising,
  // so a surprise is never silently lost: if there is no ungated logger, or the
  // surprise is deduped, it still reaches the topic-gated debug tier WITH its
  // reasonCode for a topic-on deep dive.
  const payload = surprise
    ? { event, ...fields, reasonCode: surprise.reasonCode }
    : { event, ...fields };

  if (surprise && logger) {
    const allow = dedupe
      ? shouldEmitOnChange({ ...dedupe, signature: surprise.reasonCode })
      : true;
    if (allow) {
      if (surprise.level === 'warn') logger.warn(payload);
      else logger.info(payload);
      return;
    }
  }

  debugEmitter(payload);
}
