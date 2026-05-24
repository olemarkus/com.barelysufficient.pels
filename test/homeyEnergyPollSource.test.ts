import { HomeyEnergyPollSource } from '../lib/power/sources/homeyEnergyPoll';
import { TimerRegistry } from '../lib/app/timerRegistry';
import { mockHomeyInstance } from './mocks/homey';

describe('HomeyEnergyPollSource', () => {
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
    const pollHomePower = vi.fn().mockResolvedValue(2100);
    const recordPowerSample = vi.fn().mockResolvedValue(undefined);
    const source = new HomeyEnergyPollSource({
      homey: mockHomeyInstance as any,
      timers: new TimerRegistry(),
      pollHomePower,
      recordPowerSample,
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    source.start();
    expect(pollHomePower).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    source.start();
    await Promise.resolve();

    expect(pollHomePower).toHaveBeenCalledTimes(1);
    expect(recordPowerSample).toHaveBeenCalledWith(2100);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(pollHomePower).toHaveBeenCalledTimes(2);

    source.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restarting polling replaces the old interval instead of adding another one', async () => {
    mockHomeyInstance.settings.set('power_source', 'homey_energy');

    const pollHomePower = vi.fn().mockResolvedValue(null);
    const source = new HomeyEnergyPollSource({
      homey: mockHomeyInstance as any,
      timers: new TimerRegistry(),
      pollHomePower,
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
      logDebug: vi.fn(),
      error: vi.fn(),
    });

    source.start();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);

    source.restart();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(pollHomePower).toHaveBeenCalledTimes(3);
  });
});
