const readFileSyncMock = jest.fn();

jest.mock('node:fs', () => ({
  __esModule: true,
  default: {
    readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  },
}));

describe('smaps_rollup detection', () => {
  const loadModule = () => require('../lib/app/smapsRollup') as {
    resolveSmapsSummary: () => Record<string, number> | null;
  };

  beforeEach(() => {
    jest.resetModules();
    readFileSyncMock.mockReset();
  });

  it('caches unsupported detection and does not retry failed reads', () => {
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('not supported'), { code: 'ENOENT' });
    });
    const { resolveSmapsSummary } = loadModule();

    expect(resolveSmapsSummary()).toBeNull();
    expect(resolveSmapsSummary()).toBeNull();

    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
    expect(readFileSyncMock).toHaveBeenCalledWith('/proc/self/smaps_rollup', 'utf8');
  });

  it('uses the successful detection read before switching to normal reads', () => {
    readFileSyncMock
      .mockReturnValueOnce([
        'Rss:                2048 kB',
        'Pss:                1024 kB',
        'Pss_Anon:            512 kB',
        'Pss_File:            256 kB',
      ].join('\n'))
      .mockReturnValueOnce([
        'Rss:                4096 kB',
        'Pss:                3072 kB',
        'Pss_Anon:           2048 kB',
        'Pss_File:           1024 kB',
      ].join('\n'));
    const { resolveSmapsSummary } = loadModule();

    expect(resolveSmapsSummary()).toEqual({
      rssMb: 2,
      pssMb: 1,
      pssAnonMb: 1,
      pssFileMb: 0,
    });
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);

    expect(resolveSmapsSummary()).toEqual({
      rssMb: 4,
      pssMb: 3,
      pssAnonMb: 2,
      pssFileMb: 1,
    });
    expect(readFileSyncMock).toHaveBeenCalledTimes(2);
  });
});
