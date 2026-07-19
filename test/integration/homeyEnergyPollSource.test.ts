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

  it('drops an in-flight reading from before a restart (stale meter selection)', async () => {
    // A poll awaiting the SDK resolved its meter selection before the read; a
    // restart (e.g. the whole-home meter changed) must fence it out so the old
    // meter's watts are never recorded over the new selection's sample.
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    const pollResolvers: Array<(value: { powerW: number }) => void> = [];
    const pollHomePower = vi.fn(() => new Promise<{ powerW: number }>((resolve) => {
      pollResolvers.push(resolve);
    }));
    const recordPowerSample = vi.fn().mockResolvedValue(undefined);
    const debugStructured = vi.fn();
    const source = new HomeyEnergyPollSource({
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      pollHomePower,
      recordPowerSample,
      debugStructured,
      error: vi.fn(),
    });

    source.start();
    expect(pollHomePower).toHaveBeenCalledTimes(1);

    source.restart();
    expect(pollHomePower).toHaveBeenCalledTimes(2);

    // The pre-restart poll resolves late with the OLD meter's watts.
    pollResolvers[0]({ powerW: 9999 });
    await Promise.resolve();
    expect(recordPowerSample).not.toHaveBeenCalled();
    expect(debugStructured).toHaveBeenCalledWith({ event: 'homey_energy_poll_discarded_stale' });

    // The post-restart poll still records normally.
    pollResolvers[1]({ powerW: 2100 });
    await Promise.resolve();
    expect(recordPowerSample).toHaveBeenCalledWith({ powerW: 2100 });
  });

  it('does NOT authorize the sub-meter fan-out for a poll superseded by a restart (stale generation not routed)', async () => {
    // The transport fans the sub-home meter readings out from INSIDE the read,
    // BEFORE the stale-generation discard below. The read gates that fan-out on the
    // `authorizeFanOut` predicate the source hands it; a poll superseded by a
    // restart (a whole-home-meter / power-source change) must be denied so its
    // out-of-order sub-meter readings are never routed to bundles.
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    const routeMeterReadings = vi.fn();
    const pollResolvers: Array<() => void> = [];
    // The stub plays the transport's role: it dispatches the sub-meter fan-out ONLY
    // when the source authorizes it (mirrors `pollHomePowerWithMeterFanOut`).
    const pollHomePower = vi.fn((authorizeFanOut: () => boolean) => (
      new Promise<{ powerW: number }>((resolve) => {
        pollResolvers.push(() => {
          if (authorizeFanOut()) routeMeterReadings({ 'm-a': 1000 });
          resolve({ powerW: 2100 });
        });
      })
    ));
    const source = new HomeyEnergyPollSource({
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      pollHomePower,
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
      debugStructured: vi.fn(),
      error: vi.fn(),
    });

    source.start();     // generation 1 (poll 0)
    source.restart();   // generation 2 (poll 1) supersedes poll 0

    // Poll 0 (stale generation) resolves late: its fan-out must NOT route.
    pollResolvers[0]();
    await Promise.resolve();
    expect(routeMeterReadings).not.toHaveBeenCalled();

    // Poll 1 (current generation) resolves: its fan-out routes normally.
    pollResolvers[1]();
    await Promise.resolve();
    expect(routeMeterReadings).toHaveBeenCalledWith({ 'm-a': 1000 });
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
