import { AppHomeyEnergyHelpers } from '../lib/app/appHomeyEnergyHelpers';
import { mockHomeyInstance } from './mocks/homey';

describe('appHomeyEnergyHelpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockHomeyInstance.settings.clear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts polling only when Homey Energy is the configured power source', async () => {
    const pollHomePowerW = vi.fn().mockResolvedValue(2100);
    const recordPowerSample = vi.fn().mockResolvedValue(undefined);
    const helper = new AppHomeyEnergyHelpers({
      homey: mockHomeyInstance as any,
      getDeviceManager: () => ({ pollHomePowerW } as any),
      recordPowerSample,
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    helper.start();
    expect(pollHomePowerW).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    helper.start();
    await Promise.resolve();

    expect(pollHomePowerW).toHaveBeenCalledTimes(1);
    expect(recordPowerSample).toHaveBeenCalledWith(2100);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(pollHomePowerW).toHaveBeenCalledTimes(2);

    helper.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restarting polling replaces the old interval instead of adding another one', async () => {
    mockHomeyInstance.settings.set('power_source', 'homey_energy');

    const pollHomePowerW = vi.fn().mockResolvedValue(null);
    const helper = new AppHomeyEnergyHelpers({
      homey: mockHomeyInstance as any,
      getDeviceManager: () => ({ pollHomePowerW } as any),
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    helper.start();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);

    helper.restart();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(pollHomePowerW).toHaveBeenCalledTimes(3);
  });
});
