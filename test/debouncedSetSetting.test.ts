const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const loadUtils = () => {
  jest.resetModules();

  const setSetting = jest.fn().mockResolvedValue(undefined);
  jest.doMock('../settings/src/ui/homey', () => ({
    setSetting,
  }));

  let utils: typeof import('../settings/src/ui/utils') | undefined;
  jest.isolateModules(() => {
    utils = require('../settings/src/ui/utils') as typeof import('../settings/src/ui/utils');
  });

  if (!utils) {
    throw new Error('Failed to load settings UI utils');
  }

  return { setSetting, ...utils };
};

describe('debouncedSetSetting', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('coalesces rapid calls and saves the latest value', async () => {
    const { debouncedSetSetting, setSetting } = loadUtils();
    const first = debouncedSetSetting('managed_devices', () => ({ value: 1 }));
    const second = debouncedSetSetting('managed_devices', () => ({ value: 2 }));

    expect(first).toBe(second);

    jest.advanceTimersByTime(300);
    await flushMicrotasks();

    await expect(first).resolves.toBeUndefined();
    expect(setSetting).toHaveBeenCalledTimes(1);
    expect(setSetting).toHaveBeenCalledWith('managed_devices', { value: 2 });
  });

  it('rejects when the save fails', async () => {
    const { debouncedSetSetting, setSetting } = loadUtils();
    setSetting.mockRejectedValueOnce(new Error('boom'));

    const promise = debouncedSetSetting('managed_devices', () => 'value');

    jest.advanceTimersByTime(300);
    await flushMicrotasks();

    await expect(promise).rejects.toThrow('boom');
    expect(setSetting).toHaveBeenCalledTimes(1);
  });

  it('allows retry after a failed flush', async () => {
    const { debouncedSetSetting, flushDebouncedSettingSaves, setSetting } = loadUtils();
    setSetting
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    const first = debouncedSetSetting('managed_devices', () => 'value');

    let flushError: unknown;
    try {
      await flushDebouncedSettingSaves();
    } catch (error) {
      flushError = error;
    }
    expect(flushError).toBeInstanceOf(Error);
    expect((flushError as Error).message).toBe('Failed to flush pending setting saves');
    expect((flushError as Error & { causes?: unknown[] }).causes).toHaveLength(1);
    await expect(first).rejects.toThrow('boom');

    const retry = debouncedSetSetting('managed_devices', () => 'value2');
    expect(retry).not.toBe(first);

    jest.advanceTimersByTime(300);
    await flushMicrotasks();

    await expect(retry).resolves.toBeUndefined();
    expect(setSetting).toHaveBeenCalledTimes(2);
    expect(setSetting).toHaveBeenLastCalledWith('managed_devices', 'value2');
  });

  it('flushes pending saves immediately', async () => {
    const { debouncedSetSetting, flushDebouncedSettingSaves, setSetting } = loadUtils();
    const promise = debouncedSetSetting('managed_devices', () => 'value');

    await flushDebouncedSettingSaves();
    await flushMicrotasks();

    await expect(promise).resolves.toBeUndefined();
    expect(setSetting).toHaveBeenCalledTimes(1);
    expect(setSetting).toHaveBeenCalledWith('managed_devices', 'value');

    jest.runOnlyPendingTimers();
    await flushMicrotasks();
    expect(setSetting).toHaveBeenCalledTimes(1);
  });

  it('flushes on beforeunload', async () => {
    const { debouncedSetSetting, initDebouncedSaveFlush, setSetting } = loadUtils();
    const cleanup = initDebouncedSaveFlush();
    const promise = debouncedSetSetting('managed_devices', () => 'value');

    window.dispatchEvent(new Event('beforeunload'));
    await flushMicrotasks();

    await expect(promise).resolves.toBeUndefined();
    expect(setSetting).toHaveBeenCalledTimes(1);

    jest.runOnlyPendingTimers();
    await flushMicrotasks();
    expect(setSetting).toHaveBeenCalledTimes(1);

    if (cleanup) cleanup();
  });

  it('flushes on pagehide', async () => {
    const { debouncedSetSetting, initDebouncedSaveFlush, setSetting } = loadUtils();
    const cleanup = initDebouncedSaveFlush();
    const promise = debouncedSetSetting('managed_devices', () => 'value');

    window.dispatchEvent(new Event('pagehide'));
    await flushMicrotasks();

    await expect(promise).resolves.toBeUndefined();
    expect(setSetting).toHaveBeenCalledTimes(1);

    if (cleanup) cleanup();
  });

  it('flushes multiple keys independently', async () => {
    const { debouncedSetSetting, flushDebouncedSettingSaves, setSetting } = loadUtils();
    const managed = debouncedSetSetting('managed_devices', () => 'managed');
    const controllable = debouncedSetSetting('controllable_devices', () => 'controllable');

    await flushDebouncedSettingSaves();
    await flushMicrotasks();

    await expect(managed).resolves.toBeUndefined();
    await expect(controllable).resolves.toBeUndefined();
    expect(setSetting).toHaveBeenCalledTimes(2);
    expect(setSetting).toHaveBeenCalledWith('managed_devices', 'managed');
    expect(setSetting).toHaveBeenCalledWith('controllable_devices', 'controllable');
  });

  it('flushes the latest value for a key', async () => {
    const { debouncedSetSetting, flushDebouncedSettingSaves, setSetting } = loadUtils();
    const first = debouncedSetSetting('managed_devices', () => 'value1');
    const second = debouncedSetSetting('managed_devices', () => 'value2');

    expect(first).toBe(second);

    await flushDebouncedSettingSaves();
    await flushMicrotasks();

    await expect(second).resolves.toBeUndefined();
    expect(setSetting).toHaveBeenCalledTimes(1);
    expect(setSetting).toHaveBeenCalledWith('managed_devices', 'value2');
  });
});
