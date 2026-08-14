import { HomeyEnergyPollSource } from '../../lib/power/sources/homeyEnergyPoll';
import { createHomeyEnergyPollSource } from '../../setup/appInit/createHomeyEnergyPollSource';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import { requireConfiguredPowerSource } from '../../setup/powerSourceSettings';
import { mockHomeyInstance } from '../mocks/homey';

const mockPowerSource = () => requireConfiguredPowerSource(mockHomeyInstance.settings);

describe('HomeyEnergyPollSource', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockHomeyInstance.settings.clear();
    // A healthy non-empty store with no source key is the genuine Flow default.
    mockHomeyInstance.settings.set('another_setting', true);
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

  it('retries a restart after transient power-source reads fail', async () => {
    const pollHomePower = vi.fn().mockResolvedValue({ powerW: 2100 });
    const recordPowerSample = vi.fn().mockResolvedValue(undefined);
    const error = vi.fn();
    let sourceReads = 0;
    const source = new HomeyEnergyPollSource({
      getPowerSource: () => {
        sourceReads += 1;
        if (sourceReads <= 2) throw new Error('transient settings read');
        return 'homey_energy';
      },
      timers: new TimerRegistry(),
      pollHomePower,
      recordPowerSample,
      debugStructured: vi.fn(),
      error,
    });

    expect(() => source.restart()).not.toThrow();
    expect(pollHomePower).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    // Retry delays are 1s then 2s. The successful third read restores both
    // the immediate sample and the ordinary 10-second poll interval.
    await vi.advanceTimersByTimeAsync(3_000);
    // Successful `start()` reads once to choose the source, then the immediate
    // `pollNow()` reads again at its post-SDK stale-source fence.
    expect(sourceReads).toBe(4);
    expect(pollHomePower).toHaveBeenCalledOnce();
    expect(recordPowerSample).toHaveBeenCalledWith({ powerW: 2100 });
    expect(vi.getTimerCount()).toBe(1);
    expect(error).toHaveBeenCalledTimes(2);

    source.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries and resumes when the persisted source key transiently reads undefined', async () => {
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    const pollHomePower = vi.fn().mockResolvedValue({ powerW: 2_100 });
    const recordPowerSample = vi.fn().mockResolvedValue(undefined);
    const error = vi.fn();
    const originalGet = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
    let sourceReadMissing = true;
    vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementation((key) => (
      sourceReadMissing && key === 'power_source' ? undefined : originalGet(key)
    ));
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set');
    const source = new HomeyEnergyPollSource({
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      pollHomePower,
      recordPowerSample,
      debugStructured: vi.fn(),
      error,
    });

    source.start();

    expect(pollHomePower).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    expect(error).toHaveBeenCalledOnce();
    expect(setSpy).not.toHaveBeenCalled();

    sourceReadMissing = false;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(pollHomePower).toHaveBeenCalledOnce();
    expect(recordPowerSample).toHaveBeenCalledWith({ powerW: 2_100 });
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stop cancels a pending restart recovery', async () => {
    const pollHomePower = vi.fn().mockResolvedValue(null);
    const source = new HomeyEnergyPollSource({
      getPowerSource: () => { throw new Error('settings unavailable'); },
      timers: new TimerRegistry(),
      pollHomePower,
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
      debugStructured: vi.fn(),
      error: vi.fn(),
    });

    source.start();
    expect(vi.getTimerCount()).toBe(1);
    source.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(pollHomePower).not.toHaveBeenCalled();
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

  it('drops an in-flight old-meter reading when synchronously invalidated before restart', async () => {
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    let resolvePoll: (value: { powerW: number }) => void = () => undefined;
    const pollHomePower = vi.fn(() => new Promise<{ powerW: number }>((resolve) => {
      resolvePoll = resolve;
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
    source.invalidate();
    resolvePoll({ powerW: 9_999 });
    await Promise.resolve();

    expect(recordPowerSample).not.toHaveBeenCalled();
    expect(debugStructured).toHaveBeenCalledWith({ event: 'homey_energy_poll_discarded_stale' });
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

  it.each([
    ['admitted', true],
    ['superseded', false],
  ] as const)('retains an Automatic meter only when its poll sample is %s', async (state, retained) => {
    const noteAdmittedAutomaticHomeMeter = vi.fn();
    const source = createHomeyEnergyPollSource({
      getPowerSource: () => 'homey_energy',
      timers: new TimerRegistry(),
      deviceManager: {
        pollHomePowerW: vi.fn().mockResolvedValue({
          powerW: 2_100,
          resolvedHomeMeterDeviceId: 'meter-main',
          automaticHomeMeterDeviceId: 'meter-main',
          homeMeterArrangement: 'identified',
        }),
        noteAdmittedAutomaticHomeMeter,
      },
      getStructuredDebugEmitter: () => vi.fn(),
      error: vi.fn(),
    }, {
      recordPowerSample: vi.fn().mockResolvedValue(state === 'admitted'
        ? { state: 'admitted', revision: 1 }
        : { state: 'superseded', revision: 1, latestRevision: 2 }),
    });

    await source.pollNow();

    if (retained) {
      expect(noteAdmittedAutomaticHomeMeter).toHaveBeenCalledWith('meter-main');
    } else {
      expect(noteAdmittedAutomaticHomeMeter).not.toHaveBeenCalled();
    }
  });
});
