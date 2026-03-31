/**
 * @jest-environment node
 */
import { createHomeyDestination } from '../../lib/logging/homeyDestination';

describe('homeyDestination', () => {
  it('routes info-level lines to log callback', (done) => {
    const log = jest.fn();
    const error = jest.fn();
    const dest = createHomeyDestination({ log, error });

    const line = JSON.stringify({ level: 30, msg: 'hello' }) + '\n';
    dest.write(line, 'utf8', () => {
      expect(log).toHaveBeenCalledWith(JSON.stringify({ level: 30, msg: 'hello' }));
      expect(error).not.toHaveBeenCalled();
      done();
    });
  });

  it('routes error-level lines to error callback', (done) => {
    const log = jest.fn();
    const error = jest.fn();
    const dest = createHomeyDestination({ log, error });

    const line = JSON.stringify({ level: 50, msg: 'fail' }) + '\n';
    dest.write(line, 'utf8', () => {
      expect(error).toHaveBeenCalledWith(JSON.stringify({ level: 50, msg: 'fail' }));
      expect(log).not.toHaveBeenCalled();
      done();
    });
  });

  it('routes fatal-level lines to error callback', (done) => {
    const log = jest.fn();
    const error = jest.fn();
    const dest = createHomeyDestination({ log, error });

    const line = JSON.stringify({ level: 60, msg: 'fatal' }) + '\n';
    dest.write(line, 'utf8', () => {
      expect(error).toHaveBeenCalledWith(JSON.stringify({ level: 60, msg: 'fatal' }));
      done();
    });
  });

  it('handles lines without trailing newline', (done) => {
    const log = jest.fn();
    const error = jest.fn();
    const dest = createHomeyDestination({ log, error });

    const line = JSON.stringify({ level: 30, msg: 'no newline' });
    dest.write(line, 'utf8', () => {
      expect(log).toHaveBeenCalledWith(line);
      done();
    });
  });

  it('handles unparseable lines as info level', (done) => {
    const log = jest.fn();
    const error = jest.fn();
    const dest = createHomeyDestination({ log, error });

    dest.write('not json\n', 'utf8', () => {
      expect(log).toHaveBeenCalledWith('not json');
      expect(error).not.toHaveBeenCalled();
      done();
    });
  });

  it('never throws when callback throws', (done) => {
    const throwing = jest.fn(() => { throw new Error('boom'); });
    const dest = createHomeyDestination({ log: throwing, error: jest.fn() });

    dest.write(JSON.stringify({ level: 30 }) + '\n', 'utf8', () => {
      // If we reach here, no uncaught exception was thrown
      done();
    });
  });
});
