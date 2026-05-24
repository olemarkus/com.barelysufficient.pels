import v8 from 'node:v8';
import { resolveMemoryMb } from '../lib/diagnostics/resourceWarnings';

const MB = 1024 * 1024;
const enoent = (): never => {
  throw Object.assign(new Error('ENOENT: no such file or directory, uv_resident_set_memory'), {
    code: 'ENOENT',
    errno: -2,
    syscall: 'uv_resident_set_memory',
  });
};

const fakeHeap = {
  used_heap_size: 50 * MB,
  total_heap_size: 80 * MB,
  heap_size_limit: 200 * MB,
  external_memory: 5 * MB,
  malloced_memory: MB,
} as ReturnType<typeof v8.getHeapStatistics>;

describe('resolveMemoryMb', () => {
  const originalMemoryUsage = process.memoryUsage;
  const originalGetHeapStatistics = v8.getHeapStatistics;

  beforeEach(() => {
    v8.getHeapStatistics = (() => fakeHeap) as unknown as typeof v8.getHeapStatistics;
  });

  afterEach(() => {
    process.memoryUsage = originalMemoryUsage;
    v8.getHeapStatistics = originalGetHeapStatistics;
  });

  it('returns RSS + heap stats when both succeed', () => {
    process.memoryUsage = (() => ({
      rss: 130 * MB,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: MB * 2,
    })) as unknown as typeof process.memoryUsage;
    const result = resolveMemoryMb();
    expect(result).toEqual({
      rssMb: 130,
      heapUsedMb: 50,
      heapTotalMb: 80,
      heapLimitMb: 200,
      externalMb: 5,
      arrayBuffersMb: 2,
      mallocMb: 1,
    });
  });

  it('keeps heap stats when process.memoryUsage throws ENOENT (Homey libuv quirk)', () => {
    process.memoryUsage = enoent as unknown as typeof process.memoryUsage;
    const result = resolveMemoryMb();
    expect(result).toEqual({
      heapUsedMb: 50,
      heapTotalMb: 80,
      heapLimitMb: 200,
      externalMb: 5,
      mallocMb: 1,
    });
    expect(result.rssMb).toBeUndefined();
    expect(result.arrayBuffersMb).toBeUndefined();
  });

  it('collapses to { source: "unavailable" } when v8.getHeapStatistics itself throws', () => {
    v8.getHeapStatistics = (() => {
      throw new Error('no v8');
    }) as unknown as typeof v8.getHeapStatistics;
    process.memoryUsage = (() => ({
      rss: 130 * MB,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    })) as unknown as typeof process.memoryUsage;
    expect(resolveMemoryMb()).toEqual({ source: 'unavailable' });
  });
});
