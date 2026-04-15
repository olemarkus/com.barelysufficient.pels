describe('settings UI logging', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('rate limits repeated network failure logs and emits structured payloads', async () => {
    const callApi = vi.fn().mockResolvedValue({ ok: true });
    vi.doMock('../src/ui/homey.ts', () => ({
      callApi,
    }));

    const { logSettingsError } = await import('../src/ui/logging.ts');

    const error = new Error('Homey api GET /ui_devices failed: socket hang up');
    await logSettingsError('Failed to refresh devices', error, 'refreshDevices');
    await logSettingsError('Failed to refresh devices', error, 'refreshDevices');

    expect(callApi).toHaveBeenCalledTimes(1);
    const [, , entry] = callApi.mock.calls[0];
    expect(entry.message).toBe('settings_ui_network_failure');
    expect(JSON.parse(entry.detail)).toMatchObject({
      event: 'settings_ui_network_failure',
      message: 'Failed to refresh devices',
      context: 'refreshDevices',
      error: 'Homey api GET /ui_devices failed: socket hang up',
      suppressedCount: 0,
    });

    await vi.advanceTimersByTimeAsync(5_001);
    await logSettingsError('Failed to refresh devices', error, 'refreshDevices');

    expect(callApi).toHaveBeenCalledTimes(2);
    const [, , nextEntry] = callApi.mock.calls[1];
    expect(JSON.parse(nextEntry.detail)).toMatchObject({
      event: 'settings_ui_network_failure',
      suppressedCount: 1,
    });
  });
});
