import { describe, it, expect, vi } from 'vitest';
import { emitGated } from '../../lib/logging/deviationGate';
import type { LogDedupeEntry } from '../../lib/logging/logDedupe';

const makeLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
});

describe('emitGated', () => {
  it('routes a non-surprising line to the debug emitter, never the logger', () => {
    const logger = makeLogger();
    const debugEmitter = vi.fn();
    emitGated({
      logger: logger as never,
      debugEmitter,
      event: 'thing_happened',
      fields: { a: 1 },
      surprise: null,
    });
    expect(debugEmitter).toHaveBeenCalledWith({ event: 'thing_happened', a: 1 });
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('promotes a surprising line to the logger at the given level with reasonCode', () => {
    const logger = makeLogger();
    const debugEmitter = vi.fn();
    emitGated({
      logger: logger as never,
      debugEmitter,
      event: 'thing_happened',
      fields: { a: 1 },
      surprise: { level: 'warn', reasonCode: 'too_big' },
    });
    expect(logger.warn).toHaveBeenCalledWith({ event: 'thing_happened', a: 1, reasonCode: 'too_big' });
    expect(logger.info).not.toHaveBeenCalled();
    expect(debugEmitter).not.toHaveBeenCalled();
  });

  it('falls back to the debug emitter (with reasonCode) when a surprise has no logger', () => {
    const debugEmitter = vi.fn();
    emitGated({
      logger: undefined,
      debugEmitter,
      event: 'clamp',
      fields: { deviceId: 'd1' },
      surprise: { level: 'warn', reasonCode: 'too_big' },
    });
    expect(debugEmitter).toHaveBeenCalledWith({ event: 'clamp', deviceId: 'd1', reasonCode: 'too_big' });
  });

  it('routes an info-level surprise to logger.info', () => {
    const logger = makeLogger();
    emitGated({
      logger: logger as never,
      debugEmitter: vi.fn(),
      event: 'e',
      fields: {},
      surprise: { level: 'info', reasonCode: 'r' },
    });
    expect(logger.info).toHaveBeenCalledWith({ event: 'e', reasonCode: 'r' });
  });

  it('dedupes a persistent surprise to one line + heartbeat, routing suppressed cycles to debug', () => {
    const logger = makeLogger();
    const debugEmitter = vi.fn();
    const state = new Map<string, LogDedupeEntry>();
    const fire = (now: number) => emitGated({
      logger: logger as never,
      debugEmitter,
      event: 'clamp',
      fields: { deviceId: 'd1' },
      surprise: { level: 'warn', reasonCode: 'stepped_load_clamp' },
      dedupe: { state, key: 'd1', now, repeatAfterMs: 10_000 },
    });

    fire(1_000);
    fire(2_000); // same signature, within heartbeat -> suppressed
    fire(20_000); // heartbeat elapsed -> re-emits

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(debugEmitter).toHaveBeenCalledTimes(1); // the suppressed cycle still records detail on debug
  });

  it('re-emits immediately when the surprise signature changes', () => {
    const logger = makeLogger();
    const state = new Map<string, LogDedupeEntry>();
    emitGated({
      logger: logger as never,
      debugEmitter: vi.fn(),
      event: 'e',
      fields: {},
      surprise: { level: 'warn', reasonCode: 'first' },
      dedupe: { state, key: 'd1', now: 1_000, repeatAfterMs: 10_000 },
    });
    emitGated({
      logger: logger as never,
      debugEmitter: vi.fn(),
      event: 'e',
      fields: {},
      surprise: { level: 'warn', reasonCode: 'second' },
      dedupe: { state, key: 'd1', now: 1_500, repeatAfterMs: 10_000 },
    });
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
