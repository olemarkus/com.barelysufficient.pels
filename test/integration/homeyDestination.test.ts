import { PassThrough } from 'node:stream';
import { createHomeyDestination } from '../../lib/logging/homeyDestination';
import { createRootLogger } from '../../lib/logging/logger';
import { runWithContext } from '../../lib/logging/alsContext';

describe('Homey log forwarding through Pino', () => {
  it.each(['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const)(
    'routes %s to the Homey channel and omits transport metadata', (level) => {
      const log = vi.fn();
      const error = vi.fn();
      const logger = createRootLogger(createHomeyDestination({ log, error }), 'trace');
      logger[level]({ event: 'forwarded' }, 'hello');

      const expected = JSON.stringify({ event: 'forwarded', msg: 'hello' });
      if (level === 'error' || level === 'fatal') {
        expect(error).toHaveBeenCalledExactlyOnceWith(expected);
        expect(log).not.toHaveBeenCalled();
      } else {
        expect(log).toHaveBeenCalledExactlyOnceWith(expected);
        expect(error).not.toHaveBeenCalled();
      }
    },
  );

  it('preserves child bindings, context, nested data and escaped messages', () => {
    const log = vi.fn();
    const logger = createRootLogger(createHomeyDestination({ log, error: vi.fn() }));
    const child = logger.child({ module: 'test/forwarding' });
    runWithContext({ homeId: 'main', rebuildId: 'rb1' }, () => {
      child.info({ event: 'sample', nested: { level: 50, value: 'a"b' } }, 'first\nsecond');
    });
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      module: 'test/forwarding', homeId: 'main', rebuildId: 'rb1',
      event: 'sample', nested: { level: 50, value: 'a"b' }, msg: 'first\nsecond',
    });
  });

  it('forwards an empty record as valid JSON', () => {
    const log = vi.fn();
    createRootLogger(createHomeyDestination({ log, error: vi.fn() })).info({});
    expect(log).toHaveBeenCalledExactlyOnceWith('{}');
  });

  it('reserves the transport level from child bindings and allows debug children', () => {
    const log = vi.fn();
    const error = vi.fn();
    const logger = createRootLogger(createHomeyDestination({ log, error }));
    logger.child({ level: 60, component: 'test' }, { level: 'debug' }).debug({ event: 'debug_child' });
    expect(log).toHaveBeenCalledExactlyOnceWith('{"component":"test","event":"debug_child"}');
    expect(error).not.toHaveBeenCalled();
  });

  it('routes using the logging method even when a payload supplies its own level', () => {
    const log = vi.fn();
    const error = vi.fn();
    const logger = createRootLogger(createHomeyDestination({ log, error }));
    logger.info({ level: 60, event: 'info' });
    logger.error({ level: 10, event: 'error' });
    expect(log).toHaveBeenCalledExactlyOnceWith('{"event":"info"}');
    expect(error).toHaveBeenCalledExactlyOnceWith('{"event":"error"}');
  });

  it('preserves routing through reentrant callbacks and consecutive levels', () => {
    const error = vi.fn();
    const log = vi.fn(() => {
      logger.error({ event: 'nested_error' });
      logger.fatal({ event: 'nested_fatal' });
    });
    const logger = createRootLogger(createHomeyDestination({ log, error }));
    logger.info({ event: 'outer_info' });
    logger.warn({ event: 'outer_warn' });
    expect(log.mock.calls).toEqual([['{"event":"outer_info"}'], ['{"event":"outer_warn"}']]);
    expect(error.mock.calls).toEqual([
      ['{"event":"nested_error"}'], ['{"event":"nested_fatal"}'],
      ['{"event":"nested_error"}'], ['{"event":"nested_fatal"}'],
    ]);
  });

  it('contains callback failures and continues forwarding', () => {
    const log = vi.fn(() => { throw new Error('log failed'); });
    const error = vi.fn(() => { throw new Error('error failed'); });
    const logger = createRootLogger(createHomeyDestination({ log, error }));
    expect(() => logger.info({ event: 'info' })).not.toThrow();
    expect(() => logger.error({ event: 'error' })).not.toThrow();
    expect(() => logger.warn({ event: 'warn' })).not.toThrow();
    expect(log).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('preserves serialized errors', () => {
    const error = vi.fn();
    const logger = createRootLogger(createHomeyDestination({ log: vi.fn(), error }));
    logger.error({ event: 'failure', err: new Error('boom') });
    expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({
      event: 'failure', err: { type: 'Error', message: 'boom', stack: expect.any(String) },
    });
  });

  it('keeps numeric levels in other destinations', () => {
    const destination = new PassThrough();
    const data = vi.fn();
    destination.on('data', data);
    createRootLogger(destination).info({ event: 'capture' });
    expect(JSON.parse(data.mock.calls[0][0].toString())).toEqual({ level: 30, event: 'capture' });
  });
});
