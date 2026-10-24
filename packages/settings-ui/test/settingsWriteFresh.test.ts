// Coverage for the snapshot-fallback semantics of writeFreshSetting.
// See packages/settings-ui/src/ui/deviceDetail/settingsWrite.ts. When the
// fresh SDK read transiently resolves to null/undefined or returns a
// malformed value, the helper must fall back to the caller-provided
// snapshot rather than to `{}` — otherwise the subsequent write would
// erase unrelated keys (project memory feedback_homey_sdk_unreliable).

const loadHelper = async () => {
  vi.resetModules();

  const getSettingFresh = vi.fn();
  const setSetting = vi.fn().mockResolvedValue(undefined);
  const logSettingsError = vi.fn().mockResolvedValue(undefined);
  const showToastError = vi.fn().mockResolvedValue(undefined);
  const showToast = vi.fn().mockResolvedValue(undefined);

  vi.doMock('../src/ui/homey.ts', () => ({
    getSettingFresh,
    setSetting,
  }));
  vi.doMock('../src/ui/logging.ts', () => ({
    logSettingsError,
  }));
  vi.doMock('../src/ui/toast.ts', () => ({
    showToast,
    showToastError,
  }));

  const module = await import('../src/ui/deviceDetail/settingsWrite.ts');

  return {
    getSettingFresh,
    setSetting,
    logSettingsError,
    showToast,
    showToastError,
    ...module,
  };
};

describe('writeFreshSetting snapshot-fallback semantics', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes a merged value when the fresh read returns a valid object', async () => {
    const {
      getSettingFresh,
      setSetting,
      writeFreshSetting,
      logSettingsError,
      showToastError,
    } = await loadHelper();
    getSettingFresh.mockResolvedValueOnce({ existing: true });
    const mutate = vi.fn((current: Record<string, boolean>) => ({ ...current, next: true }));
    const commit = vi.fn();
    const rollback = vi.fn();

    const result = await writeFreshSetting<Record<string, boolean>>({
      key: 'budget_exempt_devices',
      context: 'device detail',
      logMessage: 'Failed',
      toastMessage: 'Failed.',
      fallbackValue: { snapshot: true },
      mutate,
      commit,
      rollback,
    });

    expect(result).toEqual({ existing: true, next: true });
    // The fresh value wins over the snapshot when both are present.
    expect(mutate).toHaveBeenCalledWith({ existing: true });
    expect(setSetting).toHaveBeenCalledWith('budget_exempt_devices', { existing: true, next: true });
    expect(commit).toHaveBeenCalledWith({ existing: true, next: true });
    expect(rollback).not.toHaveBeenCalled();
    expect(logSettingsError).not.toHaveBeenCalled();
    expect(showToastError).not.toHaveBeenCalled();
  });

  it('falls back to the caller snapshot when the fresh read resolves to null', async () => {
    // The realistic transient-blip scenario: SDK temporarily returns null
    // for a key that has persisted entries. The helper must use the
    // snapshot (which the UI keeps in `state.*`) rather than `{}` so the
    // merged write preserves entries for other devices.
    const {
      getSettingFresh,
      setSetting,
      writeFreshSetting,
      logSettingsError,
      showToastError,
    } = await loadHelper();
    getSettingFresh.mockResolvedValueOnce(null);
    const mutate = vi.fn((current: Record<string, boolean>) => ({
      ...current,
      'heater-1': true,
    }));
    const commit = vi.fn();
    const rollback = vi.fn();

    const result = await writeFreshSetting<Record<string, boolean>>({
      key: 'budget_exempt_devices',
      context: 'device detail',
      logMessage: 'Failed',
      toastMessage: 'Failed save toast',
      fallbackValue: { 'other-device': true },
      mutate,
      commit,
      rollback,
    });

    expect(result).toEqual({ 'other-device': true, 'heater-1': true });
    expect(mutate).toHaveBeenCalledWith({ 'other-device': true });
    expect(setSetting).toHaveBeenCalledWith('budget_exempt_devices', {
      'other-device': true,
      'heater-1': true,
    });
    expect(commit).toHaveBeenCalledWith({ 'other-device': true, 'heater-1': true });
    expect(rollback).not.toHaveBeenCalled();
    expect(logSettingsError).not.toHaveBeenCalled();
    expect(showToastError).not.toHaveBeenCalled();
  });

  it('falls back to the snapshot when the fresh read resolves to undefined', async () => {
    const { getSettingFresh, setSetting, writeFreshSetting } = await loadHelper();
    getSettingFresh.mockResolvedValueOnce(undefined);
    const mutate = vi.fn((current: Record<string, boolean>) => ({
      ...current,
      next: true,
    }));

    const result = await writeFreshSetting<Record<string, boolean>>({
      key: 'managed_devices',
      context: 'device detail',
      logMessage: 'Failed',
      toastMessage: 'Failed.',
      fallbackValue: { existing: true },
      mutate,
    });

    expect(result).toEqual({ existing: true, next: true });
    expect(mutate).toHaveBeenCalledWith({ existing: true });
    expect(setSetting).toHaveBeenCalledWith('managed_devices', { existing: true, next: true });
  });

  it('falls back to the snapshot when readFresh returns null on a non-object SDK value', async () => {
    const { getSettingFresh, setSetting, writeFreshSetting } = await loadHelper();
    getSettingFresh.mockResolvedValueOnce('corrupt-string');
    const mutate = vi.fn((current: Record<string, boolean>) => ({
      ...current,
      next: true,
    }));

    const result = await writeFreshSetting<Record<string, boolean>>({
      key: 'managed_devices',
      context: 'device detail',
      logMessage: 'Failed',
      toastMessage: 'Failed.',
      fallbackValue: { existing: true },
      mutate,
      readFresh: (value) => (
        value && typeof value === 'object' && !Array.isArray(value)
          ? value as Record<string, boolean>
          : null
      ),
    });

    expect(result).toEqual({ existing: true, next: true });
    expect(mutate).toHaveBeenCalledWith({ existing: true });
    expect(setSetting).toHaveBeenCalledWith('managed_devices', { existing: true, next: true });
  });

  it('falls back to the snapshot when readFresh returns undefined', async () => {
    const { getSettingFresh, setSetting, writeFreshSetting } = await loadHelper();
    getSettingFresh.mockResolvedValueOnce({ shape: 'wrong' });
    const mutate = vi.fn((current: Record<string, boolean>) => ({
      ...current,
      next: true,
    }));

    const result = await writeFreshSetting<Record<string, boolean>>({
      key: 'managed_devices',
      context: 'device detail',
      logMessage: 'Failed',
      toastMessage: 'Failed.',
      fallbackValue: { existing: true },
      mutate,
      readFresh: () => undefined,
    });

    expect(result).toEqual({ existing: true, next: true });
    expect(mutate).toHaveBeenCalledWith({ existing: true });
    expect(setSetting).toHaveBeenCalledWith('managed_devices', { existing: true, next: true });
  });

  it('propagates getSettingFresh rejections via toast and rollback', async () => {
    const {
      getSettingFresh,
      setSetting,
      writeFreshSetting,
      logSettingsError,
      showToastError,
    } = await loadHelper();
    const error = new Error('Homey SDK not ready');
    getSettingFresh.mockRejectedValueOnce(error);
    const rollback = vi.fn();

    const result = await writeFreshSetting<Record<string, boolean>>({
      key: 'managed_devices',
      context: 'device detail',
      logMessage: 'Failed to update managed device',
      toastMessage: 'Failed.',
      fallbackValue: {},
      mutate: vi.fn(),
      rollback,
    });

    expect(result).toBeNull();
    expect(setSetting).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(logSettingsError).toHaveBeenCalledWith(
      'Failed to update managed device',
      error,
      'device detail',
    );
    expect(showToastError).toHaveBeenCalledWith(error, 'Failed.');
  });

  it('allows a first write when SDK and snapshot are both empty (no other devices)', async () => {
    // Fresh-install case: the key has never been written, and the UI has
    // no local entries either. The user's change should still persist as
    // the sole entry — fail-closed semantics that ignored this case would
    // silently swallow every first interaction.
    const { getSettingFresh, setSetting, writeFreshSetting } = await loadHelper();
    getSettingFresh.mockResolvedValueOnce(null);
    const mutate = vi.fn((current: Record<string, boolean>) => ({
      ...current,
      'heater-1': true,
    }));

    const result = await writeFreshSetting<Record<string, boolean>>({
      key: 'budget_exempt_devices',
      context: 'device detail',
      logMessage: 'Failed',
      toastMessage: 'Failed.',
      fallbackValue: {},
      mutate,
    });

    expect(result).toEqual({ 'heater-1': true });
    expect(setSetting).toHaveBeenCalledWith('budget_exempt_devices', { 'heater-1': true });
  });

  it('falls back to the snapshot with the default readFresh on primitive SDK values', async () => {
    const { getSettingFresh, setSetting, writeFreshSetting } = await loadHelper();
    // No readFresh supplied — the helper's default treats non-objects as
    // unrecoverable and routes through the snapshot fallback so we never
    // mutate a primitive masquerading as state.
    getSettingFresh.mockResolvedValueOnce(42);
    const mutate = vi.fn((current: Record<string, boolean>) => ({
      ...current,
      'heater-1': true,
    }));

    const result = await writeFreshSetting<Record<string, boolean>>({
      key: 'managed_devices',
      context: 'device detail',
      logMessage: 'Failed',
      toastMessage: 'Failed.',
      fallbackValue: { 'other-device': true },
      mutate,
    });

    expect(result).toEqual({ 'other-device': true, 'heater-1': true });
    expect(mutate).toHaveBeenCalledWith({ 'other-device': true });
    expect(setSetting).toHaveBeenCalledWith('managed_devices', {
      'other-device': true,
      'heater-1': true,
    });
  });
});

describe('debounced Saved confirmation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('coalesces a burst of successful writes into one Saved toast', async () => {
    const { getSettingFresh, writeFreshSetting, showToast } = await loadHelper();
    getSettingFresh.mockResolvedValue({});
    const params = {
      key: 'k',
      context: 'test',
      logMessage: 'log',
      toastMessage: 'toast',
      fallbackValue: {},
      mutate: (value: Record<string, unknown>) => value,
    };
    await writeFreshSetting(params);
    await writeFreshSetting(params);
    await vi.advanceTimersByTimeAsync(500);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Saved', 'ok', { durationMs: 1500 });
  });

  it('cancels a pending Saved toast when a later write fails', async () => {
    const { getSettingFresh, setSetting, writeFreshSetting, showToast, showToastError } = await loadHelper();
    getSettingFresh.mockResolvedValue({});
    const params = {
      key: 'k',
      context: 'test',
      logMessage: 'log',
      toastMessage: 'toast',
      fallbackValue: {},
      mutate: (value: Record<string, unknown>) => value,
    };
    await writeFreshSetting(params);
    setSetting.mockRejectedValueOnce(new Error('sdk blip'));
    await writeFreshSetting(params);
    await vi.advanceTimersByTimeAsync(500);
    // The failure toast must not be overwritten by the stale Saved confirm.
    expect(showToast).not.toHaveBeenCalled();
    expect(showToastError).toHaveBeenCalled();
  });
});

describe('readRecordSettingStrict', () => {
  it('returns a shallow clone for plain objects', async () => {
    const { readRecordSettingStrict } = await loadHelper();
    const source = { a: true, b: false };
    const result = readRecordSettingStrict<boolean>(source);
    expect(result).toEqual(source);
    expect(result).not.toBe(source);
  });

  it('returns null for null, undefined, arrays, and primitives', async () => {
    const { readRecordSettingStrict } = await loadHelper();
    expect(readRecordSettingStrict<boolean>(null)).toBeNull();
    expect(readRecordSettingStrict<boolean>(undefined)).toBeNull();
    expect(readRecordSettingStrict<boolean>([])).toBeNull();
    expect(readRecordSettingStrict<boolean>(['a'])).toBeNull();
    expect(readRecordSettingStrict<boolean>('string')).toBeNull();
    expect(readRecordSettingStrict<boolean>(42)).toBeNull();
    expect(readRecordSettingStrict<boolean>(true)).toBeNull();
  });
});

describe('guided setup save barrier', () => {
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  const policyWrite = {
    key: 'device_start_policies',
    context: 'device detail',
    logMessage: 'Failed to save start policy',
    toastMessage: 'Failed to save start policy.',
    fallbackValue: {},
    mutate: (current: Record<string, string>) => ({ ...current, heater: 'pels_only' }),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/?setup=devices');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    window.history.replaceState(null, '', '/');
  });

  it('keeps activation waiting through the fresh read and local commit', async () => {
    const { getSettingFresh, setSetting, writeFreshSetting } = await loadHelper();
    const saves = await import('../src/ui/setupJourneyState.ts');
    const fresh = deferred<Record<string, string>>();
    const commitStarted = deferred<void>();
    const commitFinished = deferred<void>();
    getSettingFresh.mockReturnValueOnce(fresh.promise);
    const write = writeFreshSetting({
      ...policyWrite,
      commit: async () => { commitStarted.resolve(); await commitFinished.promise; },
    });
    expect(saves.setupSavePending()).toBe(true);
    let activated = false;
    const activation = saves.waitForSetupSaves().then(() => { activated = true; });
    await Promise.resolve();
    expect(setSetting).not.toHaveBeenCalled();
    expect(activated).toBe(false);
    fresh.resolve({});
    await commitStarted.promise;
    expect(setSetting).toHaveBeenCalledWith(policyWrite.key, { heater: 'pels_only' });
    expect(saves.setupSavePending()).toBe(true);
    expect(activated).toBe(false);
    commitFinished.resolve();
    await write;
    await activation;
    expect(activated).toBe(true);
  });

  it('blocks activation after a failed fresh read even when the field handles the error', async () => {
    const { getSettingFresh, writeFreshSetting, showToastError } = await loadHelper();
    const saves = await import('../src/ui/setupJourneyState.ts');
    getSettingFresh.mockRejectedValueOnce(new Error('bridge unavailable'));
    await expect(writeFreshSetting(policyWrite)).resolves.toBeNull();
    expect(showToastError).toHaveBeenCalled();
    await expect(saves.waitForSetupSaves()).rejects.toThrow('could not be saved');
  });

  it('registers queued edits immediately and waits until the last queued policy is committed', async () => {
    const { getSettingFresh, setSetting, writeFreshSetting, createSerializedAsyncRunner } = await loadHelper();
    const saves = await import('../src/ui/setupJourneyState.ts');
    const run = createSerializedAsyncRunner();
    const firstFinished = deferred<void>();
    const secondStarted = deferred<void>();
    const secondFresh = deferred<Record<string, string>>();
    const first = run(() => firstFinished.promise);
    getSettingFresh.mockImplementationOnce(() => {
      secondStarted.resolve();
      return secondFresh.promise;
    });
    const second = run(() => writeFreshSetting(policyWrite));
    expect(saves.setupSavePending()).toBe(true);
    let activated = false;
    const activation = saves.waitForSetupSaves().then(() => { activated = true; });
    expect(getSettingFresh).not.toHaveBeenCalled();
    firstFinished.resolve();
    await first;
    await secondStarted.promise;
    expect(saves.setupSavePending()).toBe(true);
    expect(activated).toBe(false);
    secondFresh.resolve({});
    await second;
    await activation;
    expect(setSetting).toHaveBeenCalledWith(policyWrite.key, { heater: 'pels_only' });
    expect(activated).toBe(true);
  });
});
