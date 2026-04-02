/**
 * @jest-environment node
 */
import { createHomeyDestination } from '../../lib/logging/homeyDestination';

function writeChunk(dest: ReturnType<typeof createHomeyDestination>, chunk: string): Promise<void> {
  return new Promise((resolve) => {
    dest.write(chunk, 'utf8', () => resolve());
  });
}

describe('homeyDestination', () => {
  it('routes info-level lines to log callback', (done) => {
    const log = jest.fn();
    const error = jest.fn();
    const dest = createHomeyDestination({ log, error });

    const line = JSON.stringify({ level: 30, pid: 1, hostname: 'homey', msg: 'hello' }) + '\n';
    dest.write(line, 'utf8', () => {
      expect(log).toHaveBeenCalledWith(JSON.stringify({ msg: 'hello' }));
      expect(error).not.toHaveBeenCalled();
      done();
    });
  });

  it('routes error-level lines to error callback', (done) => {
    const log = jest.fn();
    const error = jest.fn();
    const dest = createHomeyDestination({ log, error });

    const line = JSON.stringify({ level: 50, pid: 1, hostname: 'homey', msg: 'fail' }) + '\n';
    dest.write(line, 'utf8', () => {
      expect(error).toHaveBeenCalledWith(JSON.stringify({ msg: 'fail' }));
      expect(log).not.toHaveBeenCalled();
      done();
    });
  });

  it('routes fatal-level lines to error callback', (done) => {
    const log = jest.fn();
    const error = jest.fn();
    const dest = createHomeyDestination({ log, error });

    const line = JSON.stringify({ level: 60, pid: 1, hostname: 'homey', msg: 'fatal' }) + '\n';
    dest.write(line, 'utf8', () => {
      expect(error).toHaveBeenCalledWith(JSON.stringify({ msg: 'fatal' }));
      done();
    });
  });

  it('handles lines without trailing newline', (done) => {
    const log = jest.fn();
    const error = jest.fn();
    const dest = createHomeyDestination({ log, error });

    const line = JSON.stringify({ level: 30, pid: 1, hostname: 'homey', msg: 'no newline' });
    dest.end(line, 'utf8', () => {
      expect(log).toHaveBeenCalledWith(JSON.stringify({ msg: 'no newline' }));
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

  it('buffers partial chunks until a full line is available', async () => {
    const log = jest.fn();
    const error = jest.fn();
    const dest = createHomeyDestination({ log, error });
    const line = JSON.stringify({ level: 50, pid: 1, hostname: 'homey', msg: 'split' }) + '\n';
    const mid = Math.floor(line.length / 2);

    await writeChunk(dest, line.slice(0, mid));
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    await writeChunk(dest, line.slice(mid));
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(JSON.stringify({ msg: 'split' }));
  });
});
