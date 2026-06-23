import { HomeyEnergyPollSource } from '../../lib/power/sources/homeyEnergyPoll';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import { normalizePowerSource } from '../../lib/power/powerSource';
import { mockHomeyInstance } from '../mocks/homey';

const mockPowerSource = () => normalizePowerSource(mockHomeyInstance.settings.get('power_source'));

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
    const pollHomePower = vi.fn().mockResolvedValue({ powerW: 2100 });
    const recordPowerSample = vi.fn().mockResolvedValue(undefined);
    const source = new HomeyEnergyPollSource({
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      pollHomePower,
      recordPowerSample,
      debugStructured: vi.fn(),
      error: vi.fn(),
    });

    source.start();
    expect(pollHomePower).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    source.start();
    await Promise.resolve();

    expect(pollHomePower).toHaveBeenCalledTimes(1);
    expect(recordPowerSample).toHaveBeenCalledWith({ powerW: 2100 });
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
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      pollHomePower,
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
      debugStructured: vi.fn(),
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

  it('drops an in-flight reading when the source switches away from Homey Energy', async () => {
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    let resolvePoll: (value: { powerW: number }) => void = () => undefined;
    const pollHomePower = vi.fn(() => new Promise<{ powerW: number }>((resolve) => {
      resolvePoll = resolve;
    }));
    const recordPowerSample = vi.fn().mockResolvedValue(undefined);
    const source = new HomeyEnergyPollSource({
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      pollHomePower,
      recordPowerSample,
      debugStructured: vi.fn(),
      error: vi.fn(),
    });

    source.start();
    expect(pollHomePower).toHaveBeenCalledTimes(1);

    mockHomeyInstance.settings.set('power_source', 'flow');
    source.restart();
    resolvePoll({ powerW: 2100 });
    await Promise.resolve();

    expect(recordPowerSample).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
