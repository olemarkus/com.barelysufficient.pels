const setFlagsFromString = vi.fn();

vi.mock('node:v8', () => ({ default: { setFlagsFromString } }));

describe('v8MemoryFlags', () => {
  beforeEach(() => {
    vi.resetModules();
    setFlagsFromString.mockReset();
  });

  it('sets every memory flag when the module loads', async () => {
    await import('../../lib/diagnostics/v8MemoryFlags.ts');

    expect(setFlagsFromString.mock.calls).toEqual([
      ['--optimize-for-size'],
      ['--flush-baseline-code'],
      ['--no-concurrent-recompilation'],
      ['--no-lazy-compile-dispatcher'],
      ['--no-parallel-compile-tasks-for-lazy'],
      ['--no-parallel-compile-tasks-for-eager-toplevel'],
    ]);
  });

  it('keeps loading when the runtime refuses a flag', async () => {
    setFlagsFromString.mockImplementationOnce(() => {
      throw new Error('refused');
    });

    await expect(import('../../lib/diagnostics/v8MemoryFlags.ts')).resolves.toBeDefined();
    expect(setFlagsFromString).toHaveBeenCalledTimes(6);
  });
});
