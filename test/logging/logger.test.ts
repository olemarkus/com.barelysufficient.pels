/**
 * @jest-environment node
 */
import { PassThrough } from 'node:stream';
import { createRootLogger, withRebuildContext } from '../../lib/logging/logger';
import { runWithContext, getCurrentContext } from '../../lib/logging/alsContext';

function waitForLine(dest: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        dest.removeListener('data', onData);
        resolve(buffer.slice(0, idx));
      }
    };
    dest.on('data', onData);
  });
}

function logInNestedContext(logger: import('pino').Logger): void {
  runWithContext({ rebuildId: 'rb1', scope: 'outer' }, () => {
    runWithContext({ incidentId: 'inc1', scope: 'inner' }, () => { logger.info({ event: 'nested' }, 'deep'); });
  });
}

describe('logger', () => {
  it('emits valid JSON lines', async () => {
    const dest = new PassThrough();
    const pending = waitForLine(dest);
    const logger = createRootLogger(dest);

    logger.info({ event: 'test_event' }, 'hello');
    const line = await pending;

    const parsed = JSON.parse(line);
    expect(parsed.level).toBe(30);
    expect(parsed.event).toBe('test_event');
    expect(parsed.msg).toBe('hello');
  });

  it('does not include timestamp field', async () => {
    const dest = new PassThrough();
    const pending = waitForLine(dest);
    const logger = createRootLogger(dest);

    logger.info('no timestamp');
    const line = await pending;

    const parsed = JSON.parse(line);
    expect(parsed.time).toBeUndefined();
  });

  it('child logger bindings appear in output', async () => {
    const dest = new PassThrough();
    const pending = waitForLine(dest);
    const logger = createRootLogger(dest);
    const child = logger.child({ component: 'plan', driver: 'heater' });

    child.info({ event: 'plan_started' }, 'rebuilding');
    const line = await pending;

    const parsed = JSON.parse(line);
    expect(parsed.component).toBe('plan');
    expect(parsed.driver).toBe('heater');
    expect(parsed.event).toBe('plan_started');
  });

  it('ALS context is injected into log lines', async () => {
    const dest = new PassThrough();
    const pending = waitForLine(dest);
    const logger = createRootLogger(dest);

    await runWithContext({ correlationId: 'corr-123' }, async () => {
      logger.info({ event: 'test' }, 'with context');
      const line = await pending;
      const parsed = JSON.parse(line);
      expect(parsed.correlationId).toBe('corr-123');
    });
  });

  it('nested ALS scopes merge correctly with inner winning', async () => {
    const dest = new PassThrough();
    const pending = waitForLine(dest);
    const logger = createRootLogger(dest);

    logInNestedContext(logger);
    const parsed = JSON.parse(await pending);
    expect(parsed.rebuildId).toBe('rb1');
    expect(parsed.incidentId).toBe('inc1');
    expect(parsed.scope).toBe('inner');
  });

  it('missing ALS context does not break logging', async () => {
    const dest = new PassThrough();
    const pending = waitForLine(dest);
    const logger = createRootLogger(dest);

    logger.info({ event: 'no_context' }, 'safe');
    const line = await pending;

    const parsed = JSON.parse(line);
    expect(parsed.event).toBe('no_context');
    expect(parsed.msg).toBe('safe');
  });

  it('withRebuildContext sets rebuildId in ALS', () => {
    withRebuildContext('rb_test', () => {
      expect(getCurrentContext()).toEqual({ rebuildId: 'rb_test' });
    });
  });

  it('does not leak previous event payload fields through ALS context', async () => {
    const dest = new PassThrough();
    const firstPending = waitForLine(dest);
    const logger = createRootLogger(dest);

    await runWithContext({ rebuildId: 'rb1' }, async () => {
      logger.info({ event: 'first_event', reasonCode: 'initial' }, 'first');
      const first = JSON.parse(await firstPending);
      expect(first.rebuildId).toBe('rb1');
      expect(getCurrentContext()).toEqual({ rebuildId: 'rb1' });

      const secondPending = waitForLine(dest);
      logger.info({ event: 'second_event' }, 'second');
      const second = JSON.parse(await secondPending);
      expect(second.rebuildId).toBe('rb1');
      expect(second.reasonCode).toBeUndefined();
    });

    const finalPending = waitForLine(dest);
    logger.info({ event: 'outside_context' }, 'plain');
    const final = JSON.parse(await finalPending);
    expect(final.rebuildId).toBeUndefined();
    expect(final.reasonCode).toBeUndefined();
  });
});
