// An absent `overshoot_behaviors` key is the first-run state, no limit saved,
// but a populated key can also read null for a moment. The suggestion to set a
// limited temperature trusts "nothing saved" only once fresh reads a moment
// apart still find no map.

const loadShedLoader = async () => {
  vi.resetModules();

  const getSetting = vi.fn();
  const getSettingFresh = vi.fn();
  const logSettingsError = vi.fn().mockResolvedValue(undefined);
  const refreshRecommendationSurfaces = vi.fn();

  vi.doMock('../src/ui/homey.ts', () => ({
    getSetting,
    getSettingFresh,
    setSetting: vi.fn().mockResolvedValue(undefined),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  }));
  vi.doMock('../src/ui/logging.ts', () => ({ logSettingsError }));
  vi.doMock('../src/ui/recommendations.ts', () => ({ refreshRecommendationSurfaces }));

  const { loadShedBehaviors } = await import('../src/ui/deviceDetail/shedBehaviorsLoad.ts');
  const { state } = await import('../src/ui/state.ts');
  return { getSetting, getSettingFresh, logSettingsError, refreshRecommendationSurfaces, loadShedBehaviors, state };
};

const SAVED = { heater: { action: 'set_temperature', temperature: 55, coolingTemperature: 28 } };

describe('loading saved limits', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('takes a map at once', async () => {
    const { getSetting, getSettingFresh, loadShedBehaviors, state } = await loadShedLoader();
    getSetting.mockResolvedValue(SAVED);

    await loadShedBehaviors();

    expect(state.shedBehaviorsLoaded).toBe(true);
    expect(state.shedBehaviors).toEqual(SAVED);
    expect(getSettingFresh).not.toHaveBeenCalled();
  });

  it('keeps a populated key that read null for a moment', async () => {
    const { getSetting, getSettingFresh, loadShedBehaviors, refreshRecommendationSurfaces, state } = (
      await loadShedLoader()
    );
    getSetting.mockResolvedValue(null);
    getSettingFresh.mockResolvedValue(SAVED);

    await loadShedBehaviors();
    expect(state.shedBehaviorsLoaded).toBe(false);
    await vi.advanceTimersByTimeAsync(250);

    expect(state.shedBehaviorsLoaded).toBe(true);
    expect(state.shedBehaviors).toEqual(SAVED);
    expect(refreshRecommendationSurfaces).toHaveBeenCalledTimes(1);
  });

  it('reads nothing saved only once fresh reads a moment apart agree', async () => {
    const { getSetting, getSettingFresh, loadShedBehaviors, refreshRecommendationSurfaces, state } = (
      await loadShedLoader()
    );
    getSetting.mockResolvedValue(null);
    getSettingFresh.mockResolvedValue(undefined);

    await loadShedBehaviors();
    await vi.advanceTimersByTimeAsync(250);
    expect(state.shedBehaviorsLoaded).toBe(false);
    await vi.advanceTimersByTimeAsync(750);

    expect(getSettingFresh).toHaveBeenCalledTimes(2);
    expect(state.shedBehaviorsLoaded).toBe(true);
    expect(state.shedBehaviors).toEqual({});
    expect(refreshRecommendationSurfaces).toHaveBeenCalledTimes(1);
  });

  it('lets a later load decide over an earlier one still confirming', async () => {
    const { getSetting, getSettingFresh, loadShedBehaviors, state } = await loadShedLoader();
    getSetting.mockResolvedValue(null);
    // The first load's two fresh reads find nothing; the second load, started
    // before the first one's last read, finds the map a moment later.
    getSettingFresh.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValue(SAVED);

    await loadShedBehaviors();
    await vi.advanceTimersByTimeAsync(900);
    await loadShedBehaviors();
    await vi.advanceTimersByTimeAsync(1000);

    expect(state.shedBehaviorsLoaded).toBe(true);
    expect(state.shedBehaviors).toEqual(SAVED);
  });

  it('claims nothing when a fresh read fails', async () => {
    const { getSetting, getSettingFresh, loadShedBehaviors, logSettingsError, state } = await loadShedLoader();
    getSetting.mockResolvedValue(null);
    getSettingFresh.mockRejectedValue(new Error('settings backend unavailable'));

    await loadShedBehaviors();
    await vi.advanceTimersByTimeAsync(1000);

    expect(state.shedBehaviorsLoaded).toBe(false);
    expect(logSettingsError).toHaveBeenCalledWith(
      'Failed to confirm shed behaviors', expect.any(Error), 'loadShedBehaviors',
    );
  });
});
