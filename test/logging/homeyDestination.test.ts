/**
 * @vitest-environment node
 */
import { createHomeyDestination } from '../../lib/logging/homeyDestination';

function writeChunk(dest: ReturnType<typeof createHomeyDestination>, chunk: string): Promise<void> {
  return new Promise((resolve) => {
    dest.write(chunk, 'utf8', () => resolve());
  });
}

function endChunk(dest: ReturnType<typeof createHomeyDestination>, chunk: string): Promise<void> {
  return new Promise((resolve) => {
    dest.end(chunk, 'utf8', () => resolve());
  });
}

describe('homeyDestination', () => {
  it('routes info-level lines to log callback', async () => {
    const log = vi.fn();
    const error = vi.fn();
    const dest = createHomeyDestination({ log, error });

    const line = JSON.stringify({ level: 30, pid: 1, hostname: 'homey', msg: 'hello' }) + '\n';
    await writeChunk(dest, line);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ msg: 'hello' }));
    expect(error).not.toHaveBeenCalled();
  });

  it('routes error-level lines to error callback', async () => {
    const log = vi.fn();
    const error = vi.fn();
    const dest = createHomeyDestination({ log, error });

    const line = JSON.stringify({ level: 50, pid: 1, hostname: 'homey', msg: 'fail' }) + '\n';
    await writeChunk(dest, line);
    expect(error).toHaveBeenCalledWith(JSON.stringify({ msg: 'fail' }));
    expect(log).not.toHaveBeenCalled();
  });

  it('routes fatal-level lines to error callback', async () => {
    const log = vi.fn();
    const error = vi.fn();
    const dest = createHomeyDestination({ log, error });

    const line = JSON.stringify({ level: 60, pid: 1, hostname: 'homey', msg: 'fatal' }) + '\n';
    await writeChunk(dest, line);
    expect(error).toHaveBeenCalledWith(JSON.stringify({ msg: 'fatal' }));
  });

  it('handles lines without trailing newline', async () => {
    const log = vi.fn();
    const error = vi.fn();
    const dest = createHomeyDestination({ log, error });

    const line = JSON.stringify({ level: 30, pid: 1, hostname: 'homey', msg: 'no newline' });
    await endChunk(dest, line);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ msg: 'no newline' }));
  });

  it('handles unparseable lines as info level', async () => {
    const log = vi.fn();
    const error = vi.fn();
    const dest = createHomeyDestination({ log, error });

    await writeChunk(dest, 'not json\n');
    expect(log).toHaveBeenCalledWith('not json');
    expect(error).not.toHaveBeenCalled();
  });

  it('never throws when callback throws', async () => {
    const throwing = vi.fn(() => { throw new Error('boom'); });
    const dest = createHomeyDestination({ log: throwing, error: vi.fn() });

    await writeChunk(dest, JSON.stringify({ level: 30 }) + '\n');
    // If we reach here, no uncaught exception was thrown
  });

  it('buffers partial chunks until a full line is available', async () => {
    const log = vi.fn();
    const error = vi.fn();
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
