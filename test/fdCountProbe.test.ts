const readdirSyncMock = vi.fn();

vi.mock('node:fs', () => ({
  default: {
    readdirSync: (...args: unknown[]) => readdirSyncMock(...args),
    // perfLogging only uses readdirSync; provide stubs the runtime ignores.
    readFileSync: vi.fn(() => {
      throw Object.assign(new Error('not mocked'), { code: 'ENOENT' });
    }),
  },
}));

import { resolveFdCount, __resetFdCountProbeForTests } from '../lib/app/perfLogging';

describe('resolveFdCount probe', () => {
  beforeEach(() => {
    __resetFdCountProbeForTests();
    readdirSyncMock.mockReset();
  });

  it('returns the fd count when readdirSync succeeds', () => {
    readdirSyncMock.mockReturnValue(['0', '1', '2', '3']);
    expect(resolveFdCount()).toBe(4);
    expect(readdirSyncMock).toHaveBeenCalledWith('/proc/self/fd');
  });

  it('caches as unsupported on platform-level ENOENT', () => {
    readdirSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('not supported'), { code: 'ENOENT' });
    });
    expect(resolveFdCount()).toBeNull();
    expect(resolveFdCount()).toBeNull();
    expect(readdirSyncMock).toHaveBeenCalledTimes(1);
  });

  it('retries after a transient EMFILE so descriptor-pressure spikes do not silence the metric', () => {
    readdirSyncMock
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
      })
      .mockReturnValueOnce(['0', '1']);
    expect(resolveFdCount()).toBeNull();
    expect(resolveFdCount()).toBe(2);
    expect(readdirSyncMock).toHaveBeenCalledTimes(2);
  });

  it('also retries after EAGAIN and EIO', () => {
    readdirSyncMock
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('eagain'), { code: 'EAGAIN' });
      })
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('eio'), { code: 'EIO' });
      })
      .mockReturnValueOnce(['0']);
    expect(resolveFdCount()).toBeNull();
    expect(resolveFdCount()).toBeNull();
    expect(resolveFdCount()).toBe(1);
    expect(readdirSyncMock).toHaveBeenCalledTimes(3);
  });
});
