import { HomeyEnergyPollSource } from '../../lib/power/sources/homeyEnergyPoll';
import { createHomeyEnergyPollSource } from '../../setup/appInit/createHomeyEnergyPollSource';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import { requireConfiguredPowerSource } from '../../setup/powerSourceSettings';
import { mockHomeyInstance, resetMockHomey } from '../mocks/homey';
import type { HomeMeterRequest, LiveMeterReadings, MeterPowerSample } from '../../lib/ports/homeMeterReadings';
import { readMeterSample } from '../../lib/home/homeMeters';

const mockPowerSource = () => requireConfiguredPowerSource(mockHomeyInstance.settings);

// Main reads 'meter-main'; its sample goes to `recordPowerSample`.
const mainMeterRequests = (
  recordPowerSample: (sample: MeterPowerSample) => Promise<unknown>,
) => (): HomeMeterRequest => ({
  meterDeviceIds: ['meter-main'],
  record: async (readings) => {
    const sample = readMeterSample(readings, 'meter-main');
    if (sample) await recordPowerSample(sample);
  },
});
const mainReading = (powerW: number): LiveMeterReadings => ({ meterPowerW: { 'meter-main': powerW } });

describe('HomeyEnergyPollSource', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMockHomey();
    // A healthy non-empty store with no source key is the genuine Flow default.
    mockHomeyInstance.settings.set('another_setting', true);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts polling only when Homey Energy is the configured power source', async () => {
    const readMeters = vi.fn().mockResolvedValue(mainReading(2100));
    const recordPowerSample = vi.fn().mockResolvedValue(undefined);
    const debugStructured = vi.fn();
    const source = new HomeyEnergyPollSource({
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      readMeters,
      requestHomeMeters: mainMeterRequests(recordPowerSample),
      debugStructured,
      error: vi.fn(),
    });

    source.start();
    expect(readMeters).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    source.start();
    await Promise.resolve();

    expect(readMeters).toHaveBeenCalledTimes(1);
    expect(recordPowerSample).toHaveBeenCalledWith({ powerW: 2100, meterDeviceId: 'meter-main' });
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(readMeters).toHaveBeenCalledTimes(2);
    expect(recordPowerSample).toHaveBeenCalledTimes(2);
    expect(debugStructured).not.toHaveBeenCalled();

    source.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restarting polling replaces the old interval instead of adding another one', async () => {
    mockHomeyInstance.settings.set('power_source', 'homey_energy');

    const readMeters = vi.fn().mockResolvedValue(null);
    const source = new HomeyEnergyPollSource({
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      readMeters,
      requestHomeMeters: mainMeterRequests(vi.fn().mockResolvedValue(undefined)),
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
    expect(readMeters).toHaveBeenCalledTimes(3);
  });

  it('retries a restart after transient power-source reads fail', async () => {
    const readMeters = vi.fn().mockResolvedValue(mainReading(2100));
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
      readMeters,
      requestHomeMeters: mainMeterRequests(recordPowerSample),
      debugStructured: vi.fn(),
      error,
    });

    expect(() => source.restart()).not.toThrow();
    expect(readMeters).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    // Retry delays are 1s then 2s. The successful third read restores both
    // the immediate sample and the ordinary 10-second poll interval.
    await vi.advanceTimersByTimeAsync(3_000);
    // Successful `start()` reads once to choose the source, then the immediate
    // `pollNow()` reads again at its post-SDK stale-source fence.
    expect(sourceReads).toBe(4);
    expect(readMeters).toHaveBeenCalledOnce();
    expect(recordPowerSample).toHaveBeenCalledWith({ powerW: 2100, meterDeviceId: 'meter-main' });
    expect(vi.getTimerCount()).toBe(1);
    expect(error).toHaveBeenCalledTimes(2);

    source.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries and resumes when the persisted source key transiently reads undefined', async () => {
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    const readMeters = vi.fn().mockResolvedValue(mainReading(2_100));
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
      readMeters,
      requestHomeMeters: mainMeterRequests(recordPowerSample),
      debugStructured: vi.fn(),
      error,
    });

    source.start();

    expect(readMeters).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    expect(error).toHaveBeenCalledOnce();
    expect(setSpy).not.toHaveBeenCalled();

    sourceReadMissing = false;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(readMeters).toHaveBeenCalledOnce();
    expect(recordPowerSample).toHaveBeenCalledWith({ powerW: 2_100, meterDeviceId: 'meter-main' });
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stop cancels a pending restart recovery', async () => {
    const readMeters = vi.fn().mockResolvedValue(null);
    const source = new HomeyEnergyPollSource({
      getPowerSource: () => { throw new Error('settings unavailable'); },
      timers: new TimerRegistry(),
      readMeters,
      requestHomeMeters: mainMeterRequests(vi.fn().mockResolvedValue(undefined)),
      debugStructured: vi.fn(),
      error: vi.fn(),
    });

    source.start();
    expect(vi.getTimerCount()).toBe(1);
    source.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(readMeters).not.toHaveBeenCalled();
  });

  it('drops an in-flight reading from before a restart (stale meter selection)', async () => {
    // A poll awaiting the SDK resolved its meter selection before the read; a
    // restart (e.g. the whole-home meter changed) must fence it out so the old
    // meter's watts are never recorded over the new selection's sample.
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    const pollResolvers: Array<(value: LiveMeterReadings) => void> = [];
    const readMeters = vi.fn(() => new Promise<LiveMeterReadings>((resolve) => {
      pollResolvers.push(resolve);
    }));
    const recordPowerSample = vi.fn().mockResolvedValue(undefined);
    const debugStructured = vi.fn();
    const source = new HomeyEnergyPollSource({
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      readMeters,
      requestHomeMeters: mainMeterRequests(recordPowerSample),
      debugStructured,
      error: vi.fn(),
    });

    source.start();
    expect(readMeters).toHaveBeenCalledTimes(1);

    source.restart();
    expect(readMeters).toHaveBeenCalledTimes(2);

    // The pre-restart poll resolves late with the OLD meter's watts.
    pollResolvers[0](mainReading(9999));
    await Promise.resolve();
    expect(recordPowerSample).not.toHaveBeenCalled();
    expect(debugStructured).toHaveBeenCalledWith({ event: 'homey_energy_poll_discarded_stale' });

    // The post-restart poll still records normally.
    pollResolvers[1](mainReading(2100));
    await Promise.resolve();
    expect(recordPowerSample).toHaveBeenCalledWith({ powerW: 2100, meterDeviceId: 'meter-main' });
  });

  it('drops an in-flight old-meter reading when synchronously invalidated before restart', async () => {
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    let resolvePoll: (value: LiveMeterReadings) => void = () => undefined;
    const readMeters = vi.fn(() => new Promise<LiveMeterReadings>((resolve) => {
      resolvePoll = resolve;
    }));
    const recordPowerSample = vi.fn().mockResolvedValue(undefined);
    const debugStructured = vi.fn();
    const source = new HomeyEnergyPollSource({
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      readMeters,
      requestHomeMeters: mainMeterRequests(recordPowerSample),
      debugStructured,
      error: vi.fn(),
    });

    source.start();
    source.invalidate();
    resolvePoll(mainReading(9_999));
    await Promise.resolve();

    expect(recordPowerSample).not.toHaveBeenCalled();
    expect(debugStructured).toHaveBeenCalledWith({ event: 'homey_energy_poll_discarded_stale' });
  });

  it('routes no home\'s reading, sub-home included, from a poll superseded by a restart', async () => {
    // Every home's reading is routed after the stale-generation check, so a
    // poll a restart superseded (a whole-home-meter or power-source change)
    // delivers to no home at all.
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    const routeMeterReadings = vi.fn();
    const pollResolvers: Array<() => void> = [];
    const readMeters = vi.fn(() => new Promise<LiveMeterReadings>((resolve) => {
      pollResolvers.push(() => resolve({ meterPowerW: { 'meter-main': 2100, 'm-a': 1000 } }));
    }));
    const source = new HomeyEnergyPollSource({
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      readMeters,
      requestHomeMeters: () => ({
        meterDeviceIds: ['meter-main', 'm-a'],
        record: async (readings) => { routeMeterReadings(readings.meterPowerW); },
      }),
      debugStructured: vi.fn(),
      error: vi.fn(),
    });

    source.start();     // generation 1 (poll 0)
    source.restart();   // generation 2 (poll 1) supersedes poll 0

    pollResolvers[0]();
    await Promise.resolve();
    expect(routeMeterReadings).not.toHaveBeenCalled();

    pollResolvers[1]();
    await Promise.resolve();
    expect(routeMeterReadings).toHaveBeenCalledWith({ 'meter-main': 2100, 'm-a': 1000 });
  });

  it('drops an in-flight reading when the source switches away from Homey Energy', async () => {
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    let resolvePoll: (value: LiveMeterReadings) => void = () => undefined;
    const readMeters = vi.fn(() => new Promise<LiveMeterReadings>((resolve) => {
      resolvePoll = resolve;
    }));
    const recordPowerSample = vi.fn().mockResolvedValue(undefined);
    const source = new HomeyEnergyPollSource({
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      readMeters,
      requestHomeMeters: mainMeterRequests(recordPowerSample),
      debugStructured: vi.fn(),
      error: vi.fn(),
    });

    source.start();
    expect(readMeters).toHaveBeenCalledTimes(1);

    mockHomeyInstance.settings.set('power_source', 'flow');
    source.restart();
    resolvePoll(mainReading(2100));
    await Promise.resolve();

    expect(recordPowerSample).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads Main and every sub-home from one report, routing each to its home', async () => {
    // The identity rides the sample into `recordPowerSample`, and the
    // pipeline's admission decides whether it publishes.
    mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
    const recordPowerSample = vi.fn().mockResolvedValue({ state: 'admitted', revision: 1 });
    const routeMeterReadings = vi.fn();
    const readMeters = vi.fn().mockResolvedValue({
      meterPowerW: { 'meter-main': 2_100, 'm-area': 700 },
      generationW: 300,
    });
    const source = createHomeyEnergyPollSource({
      getPowerSource: () => 'homey_energy',
      timers: new TimerRegistry(),
      homey: mockHomeyInstance,
      deviceManager: { readMeters },
      getSubHomeMeters: () => ({ getMeterDeviceIds: () => ['m-area'], routeMeterReadings }),
      error: vi.fn(),
    }, { recordPowerSample });

    await source.pollNow();

    expect(readMeters).toHaveBeenCalledWith(['meter-main', 'm-area']);
    expect(routeMeterReadings).toHaveBeenCalledWith({ 'meter-main': 2_100, 'm-area': 700 }, expect.any(Number));
    expect(recordPowerSample).toHaveBeenCalledWith(2_100, undefined, {
      powerW: 2_100,
      generationW: 300,
      meterDeviceId: 'meter-main',
    });
  });
});
