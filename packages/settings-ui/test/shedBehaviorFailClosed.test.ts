// Coverage for writeShedBehaviors snapshot-fallback semantics.
// writeShedBehaviors wraps writeFreshSetting with the live
// `state.shedBehaviors` snapshot as the fallback, so a transient SDK blip
// (getSettingFresh resolving to null/undefined) does not erase shed
// configurations for other devices.

const loadShedHelpers = async () => {
  vi.resetModules();

  const getSettingFresh = vi.fn();
  const getSetting = vi.fn().mockResolvedValue({});
  const setSetting = vi.fn().mockResolvedValue(undefined);
  const logSettingsError = vi.fn().mockResolvedValue(undefined);
  const showToastError = vi.fn().mockResolvedValue(undefined);

  vi.doMock('../src/ui/homey.ts', () => ({
    getSettingFresh,
    getSetting,
    setSetting,
  }));
  vi.doMock('../src/ui/logging.ts', () => ({
    logSettingsError,
  }));
  vi.doMock('../src/ui/toast.ts', () => ({
    showToastError,
  }));
  vi.doMock('../src/ui/dom.ts', () => ({
    deviceDetailShedAction: null,
    deviceDetailShedStep: null,
    deviceDetailShedStepRow: null,
    deviceDetailShedTemp: null,
    deviceDetailShedTempRow: null,
  }));

  const module = await import('../src/ui/deviceDetail/shedBehavior.ts');
  const { state } = await import('../src/ui/state.ts');

  return {
    getSettingFresh,
    setSetting,
    logSettingsError,
    showToastError,
    state,
    ...module,
  };
};

describe('writeShedBehaviors snapshot-fallback semantics', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('merges with the persisted map when the fresh read succeeds', async () => {
    const {
      getSettingFresh,
      setSetting,
      writeShedBehaviors,
      state,
    } = await loadShedHelpers();
    state.shedBehaviors = {};
    getSettingFresh.mockResolvedValueOnce({
      'other-device': { action: 'turn_off' },
    });
    const commit = vi.fn();

    const result = await writeShedBehaviors({
      context: 'device detail',
      logMessage: 'Failed',
      toastMessage: 'Failed save.',
      mutate: (current) => ({
        ...current,
        'heater-1': { action: 'set_temperature', temperature: 18 },
      }),
      commit,
    });

    expect(result).toEqual({
      'other-device': { action: 'turn_off' },
      'heater-1': { action: 'set_temperature', temperature: 18 },
    });
    expect(setSetting).toHaveBeenCalledWith('overshoot_behaviors', {
      'other-device': { action: 'turn_off' },
      'heater-1': { action: 'set_temperature', temperature: 18 },
    });
    expect(commit).toHaveBeenCalledWith({
      'other-device': { action: 'turn_off' },
      'heater-1': { action: 'set_temperature', temperature: 18 },
    });
  });

  it('falls back to the live snapshot when the fresh read resolves to null', async () => {
    // Regression for the data-loss scenario: a transient SDK blip on a
    // populated overshoot_behaviors key would have synthesised `{}` and
    // erased the other-device entry. The snapshot fallback preserves
    // every entry the UI already knows about.
    const {
      getSettingFresh,
      setSetting,
      writeShedBehaviors,
      logSettingsError,
      showToastError,
      state,
    } = await loadShedHelpers();
    state.shedBehaviors = {
      'other-device': { action: 'turn_off' },
    };
    getSettingFresh.mockResolvedValueOnce(null);

    const result = await writeShedBehaviors({
      context: 'device detail',
      logMessage: 'Failed to save shed behavior',
      toastMessage: 'Failed save shed.',
      mutate: (current) => ({
        ...current,
        'heater-1': { action: 'set_temperature', temperature: 18 },
      }),
    });

    expect(result).toEqual({
      'other-device': { action: 'turn_off' },
      'heater-1': { action: 'set_temperature', temperature: 18 },
    });
    expect(setSetting).toHaveBeenCalledWith('overshoot_behaviors', {
      'other-device': { action: 'turn_off' },
      'heater-1': { action: 'set_temperature', temperature: 18 },
    });
    // No toast/log: the snapshot fallback is a planned, non-error path.
    expect(logSettingsError).not.toHaveBeenCalled();
    expect(showToastError).not.toHaveBeenCalled();
  });

  it('falls back to the snapshot when the fresh read resolves to a non-object value', async () => {
    const {
      getSettingFresh,
      setSetting,
      writeShedBehaviors,
      state,
    } = await loadShedHelpers();
    state.shedBehaviors = {
      'other-device': { action: 'turn_off' },
    };
    getSettingFresh.mockResolvedValueOnce('garbage');

    const result = await writeShedBehaviors({
      context: 'device detail',
      logMessage: 'Failed to save shed behavior',
      toastMessage: 'Failed save shed.',
      mutate: (current) => ({
        ...current,
        'heater-1': { action: 'turn_off' },
      }),
    });

    expect(result).toEqual({
      'other-device': { action: 'turn_off' },
      'heater-1': { action: 'turn_off' },
    });
    expect(setSetting).toHaveBeenCalledWith('overshoot_behaviors', {
      'other-device': { action: 'turn_off' },
      'heater-1': { action: 'turn_off' },
    });
  });

  it('rolls back when the SDK rejects with a transport error', async () => {
    const {
      getSettingFresh,
      setSetting,
      writeShedBehaviors,
      logSettingsError,
      showToastError,
      state,
    } = await loadShedHelpers();
    state.shedBehaviors = {
      'other-device': { action: 'turn_off' },
    };
    const error = new Error('Homey SDK not ready');
    getSettingFresh.mockRejectedValueOnce(error);
    const rollback = vi.fn();

    const result = await writeShedBehaviors({
      context: 'device detail',
      logMessage: 'Failed to save shed behavior',
      toastMessage: 'Failed save shed.',
      mutate: vi.fn(),
      rollback,
    });

    expect(result).toBeNull();
    expect(setSetting).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(logSettingsError).toHaveBeenCalledWith(
      'Failed to save shed behavior',
      error,
      'device detail',
    );
    expect(showToastError).toHaveBeenCalled();
  });
});
