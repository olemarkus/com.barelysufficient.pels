const readFileSyncMock = vi.fn();

vi.mock('node:fs', () => ({
  default: {
    readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  },
}));

import {
  resolveSmapsSummary,
  resolveSmapsDetail,
  _resetSmapsCacheForTests,
  __resetSmapsDetailCacheForTests,
} from '../../lib/diagnostics/smapsRollup.ts';

const sampleSmaps = [
  // anon mapping (private, no path)
  '7f0000000000-7f0000100000 rw-p 00000000 00:00 0',
  'Rss:                1024 kB',
  // heap
  '7f0000200000-7f0000300000 rw-p 00000000 00:00 0                          [heap]',
  'Rss:                 512 kB',
  // stack
  '7ffe00000000-7ffe00010000 rw-p 00000000 00:00 0                          [stack]',
  'Rss:                  64 kB',
  // file-backed
  '7f0000400000-7f0000500000 r-xp 00000000 fd:00 12345                      /usr/lib/libc.so.6',
  'Rss:                 256 kB',
  // larger anon (for topAnonRssMb ordering)
  '7f0000600000-7f0000700000 rw-p 00000000 00:00 0',
  'Rss:                4096 kB',
  '',
].join('\n');

const respondWith = (perPath: Record<string, string | (() => string)>): void => {
  readFileSyncMock.mockImplementation((path: string) => {
    const entry = perPath[path];
    if (entry === undefined) {
      throw Object.assign(new Error('unexpected path'), { code: 'ENOENT' });
    }
    return typeof entry === 'function' ? entry() : entry;
  });
};

describe('smaps_rollup detection', () => {
  beforeEach(() => {
    _resetSmapsCacheForTests();
    readFileSyncMock.mockReset();
  });

  it('caches unsupported detection and does not retry failed reads', () => {
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('not supported'), { code: 'ENOENT' });
    });

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

  it('retries after transient probe failures', () => {
    readFileSyncMock
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('temporary failure'), { code: 'EIO' });
      })
      .mockReturnValueOnce([
        'Rss:                2048 kB',
        'Pss:                1024 kB',
        'Pss_Anon:            512 kB',
        'Pss_File:            256 kB',
      ].join('\n'));

    expect(resolveSmapsSummary()).toBeNull();
    expect(resolveSmapsSummary()).toEqual({
      rssMb: 2,
      pssMb: 1,
      pssAnonMb: 1,
      pssFileMb: 0,
    });

    expect(readFileSyncMock).toHaveBeenCalledTimes(2);
  });
});

describe('resolveSmapsDetail', () => {
  beforeEach(() => {
    __resetSmapsDetailCacheForTests();
    readFileSyncMock.mockReset();
  });

  it('classifies mappings into anon/heap/stack/file and sorts top anon descending', () => {
    respondWith({ '/proc/self/smaps': sampleSmaps });
    const detail = resolveSmapsDetail();
    expect(detail).not.toBeNull();
    if (!detail) return;
    // anon = 1024 + 4096 = 5120 kB = 5.0 MB
    expect(detail.anonRssMb).toBeCloseTo(5, 3);
    expect(detail.heapRssMb).toBeCloseTo(0.5, 3);
    expect(detail.stackRssMb).toBeCloseTo(0.1, 3);
    // 256 kB = 0.25 MB, rounded to 1 decimal = 0.3
    expect(detail.fileRssMb).toBeCloseTo(0.3, 3);
    expect(detail.anonMappings).toBe(2);
    // topAnonRssMb is sorted descending: 4096 kB first, then 1024 kB
    expect(detail.topAnonRssMb).toEqual([4, 1]);
  });

  it('limits topAnonRssMb to TOP_ANON_COUNT (5) entries', () => {
    const manyAnonMappings = Array.from({ length: 10 }, (_, idx) => [
      `7f0000${(idx + 10).toString(16)}00000-7f0000${(idx + 11).toString(16)}00000 rw-p 00000000 00:00 0`,
      `Rss:                ${(idx + 1) * 100} kB`,
    ].join('\n')).join('\n') + '\n';
    respondWith({ '/proc/self/smaps': manyAnonMappings });
    const detail = resolveSmapsDetail();
    expect(detail?.anonMappings).toBe(10);
    expect(detail?.topAnonRssMb).toHaveLength(5);
    // largest five (kB → 1-decimal MB): 1000→1.0, 900→0.9, 800→0.8, 700→0.7, 600→0.6
    expect(detail?.topAnonRssMb).toEqual([1, 0.9, 0.8, 0.7, 0.6]);
  });

  it('caches unsupported probe so repeat calls do not re-read', () => {
    respondWith({
      '/proc/self/smaps': () => {
        throw Object.assign(new Error('not supported'), { code: 'ENOENT' });
      },
    });
    expect(resolveSmapsDetail()).toBeNull();
    expect(resolveSmapsDetail()).toBeNull();
    expect(resolveSmapsDetail()).toBeNull();
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('throttles reads: 1 read per SMAPS_DETAIL_SAMPLE_EVERY (6) calls', () => {
    respondWith({ '/proc/self/smaps': sampleSmaps });
    for (let i = 0; i < 6; i++) resolveSmapsDetail();
    // call 0 reads, calls 1..5 use cache
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
    resolveSmapsDetail();
    expect(readFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it('classifies named anon mappings ([anon:...], [anon_shmem:...]) as anonymous', () => {
    const namedAnon = [
      // unnamed anon
      '7f0000000000-7f0000100000 rw-p 00000000 00:00 0',
      'Rss:                 100 kB',
      // named anon — PR_SET_VMA_ANON_NAME
      '7f0000200000-7f0000300000 rw-p 00000000 00:00 0                          [anon:JS:heap]',
      'Rss:                 200 kB',
      // named shared anon
      '7f0000400000-7f0000500000 rw-s 00000000 00:00 0                          [anon_shmem:sysv]',
      'Rss:                 300 kB',
      // a real file-backed mapping for contrast
      '7f0000600000-7f0000700000 r-xp 00000000 fd:00 1                          /usr/lib/libc.so.6',
      'Rss:                 400 kB',
      '',
    ].join('\n');
    respondWith({ '/proc/self/smaps': namedAnon });
    const detail = resolveSmapsDetail();
    expect(detail).not.toBeNull();
    if (!detail) return;
    // 100 + 200 + 300 = 600 kB ≈ 0.6 MB anon
    expect(detail.anonRssMb).toBeCloseTo(0.6, 3);
    // only the libc mapping is file-backed: 400 kB ≈ 0.4 MB
    expect(detail.fileRssMb).toBeCloseTo(0.4, 3);
    expect(detail.anonMappings).toBe(3);
  });

  it('returns last cached value when an intermediate read fails transiently', () => {
    let nextThrows = false;
    respondWith({
      '/proc/self/smaps': () => {
        if (nextThrows) throw Object.assign(new Error('eio'), { code: 'EIO' });
        return sampleSmaps;
      },
    });
    const first = resolveSmapsDetail();
    expect(first?.anonRssMb).toBeCloseTo(5, 3);
    // Advance to next sampling tick
    for (let i = 0; i < 5; i++) resolveSmapsDetail();
    nextThrows = true;
    const cached = resolveSmapsDetail();
    expect(cached).toEqual(first);
  });
});
