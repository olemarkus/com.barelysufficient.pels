/**
 * @vitest-environment node
 */
import { PassThrough } from 'node:stream';
import { createRootLogger, getLogger, setRootLogger, withRebuildContext } from '../../lib/logging/logger';
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

  it('getLogger returns a silent logger by default (before setRootLogger is called)', () => {
    // No setRootLogger call yet — default is silent. The call must not throw
    // and must produce a usable pino logger.
    const logger = getLogger('test/default');
    expect(typeof logger.info).toBe('function');
    expect(() => logger.info({ event: 'noop' })).not.toThrow();
  });

  it('getLogger adds the module field as a binding on every log line', async () => {
    const dest = new PassThrough();
    const pending = waitForLine(dest);
    setRootLogger(createRootLogger(dest));

    const logger = getLogger('plan/binary-control');
    logger.info({ event: 'binary_command_applied' }, 'applied');

    const parsed = JSON.parse(await pending);
    expect(parsed.module).toBe('plan/binary-control');
    expect(parsed.event).toBe('binary_command_applied');

    setRootLogger(createRootLogger(new PassThrough(), 'silent'));
  });

  it('getLogger propagates ALS context to module children', async () => {
    const dest = new PassThrough();
    const pending = waitForLine(dest);
    setRootLogger(createRootLogger(dest));

    const logger = getLogger('plan/engine');
    const parsed = await withRebuildContext('rb_xyz', async () => {
      logger.info({ event: 'plan_rebuild_started' });
      return JSON.parse(await pending);
    });
    expect(parsed.rebuildId).toBe('rb_xyz');
    expect(parsed.module).toBe('plan/engine');

    setRootLogger(createRootLogger(new PassThrough(), 'silent'));
  });

  it('getLogger references captured before setRootLogger still emit after (late binding)', async () => {
    // Reset to silent first — this models the production import-time state
    // where every module-scope `const logger = getLogger(...)` is evaluated
    // before `app.ts` calls `setRootLogger`.
    setRootLogger(createRootLogger(new PassThrough(), 'silent'));
    const captured = getLogger('plan/captured-early');

    // Later, app startup wires the real root.
    const dest = new PassThrough();
    const pending = waitForLine(dest);
    setRootLogger(createRootLogger(dest));

    // The reference captured before setRootLogger must still emit through the new root.
    captured.info({ event: 'late_bound' });
    const parsed = JSON.parse(await pending);
    expect(parsed.event).toBe('late_bound');
    expect(parsed.module).toBe('plan/captured-early');

    setRootLogger(createRootLogger(new PassThrough(), 'silent'));
  });

  it('getLogger exposes pino accessor properties (e.g. level) without crashing', () => {
    setRootLogger(createRootLogger(new PassThrough(), 'debug'));
    const logger = getLogger('plan/accessor');

    // Reading `.level` triggers a pino getter that depends on internal symbol
    // fields. If the proxy bound `this` to the proxy instead of the live
    // child, this would throw or return a wrong value.
    expect(logger.level).toBe('debug');

    setRootLogger(createRootLogger(new PassThrough(), 'silent'));
  });

  it('getLogger forwards property writes (e.g. logger.level = "debug") to the live child', async () => {
    const dest = new PassThrough();
    const lines: string[] = [];
    dest.on('data', (chunk: Buffer) => { lines.push(chunk.toString()); });
    setRootLogger(createRootLogger(dest, 'info'));

    const logger = getLogger('plan/level-write');
    // info passes; debug is suppressed at level 'info'
    logger.info({ event: 'before_level_change' });
    logger.debug({ event: 'suppressed' });

    // Forwarded property write must lower the live child's threshold.
    logger.level = 'debug';
    logger.debug({ event: 'after_level_change' });

    await new Promise((resolve) => setImmediate(resolve));
    const events = lines.join('').trim().split('\n').map((l) => JSON.parse(l));
    expect(events.find((e) => e.event === 'before_level_change')).toBeDefined();
    expect(events.find((e) => e.event === 'suppressed')).toBeUndefined();
    expect(events.find((e) => e.event === 'after_level_change')).toBeDefined();

    setRootLogger(createRootLogger(new PassThrough(), 'silent'));
  });

  it('setRootLogger reroutes subsequent getLogger calls', async () => {
    const firstDest = new PassThrough();
    const firstPending = waitForLine(firstDest);
    setRootLogger(createRootLogger(firstDest));

    getLogger('m').info({ event: 'first' });
    const first = JSON.parse(await firstPending);
    expect(first.event).toBe('first');

    const secondDest = new PassThrough();
    const secondPending = waitForLine(secondDest);
    setRootLogger(createRootLogger(secondDest));

    getLogger('m').info({ event: 'second' });
    const second = JSON.parse(await secondPending);
    expect(second.event).toBe('second');

    setRootLogger(createRootLogger(new PassThrough(), 'silent'));
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
