import { startCpuSpikeMonitor } from '../lib/utils/cpuSpikeMonitor';

describe('startCpuSpikeMonitor', () => {
  let cpuUsageSpy: jest.SpyInstance;
  let hrtimeSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-02-28T08:00:00Z'));
    cpuUsageSpy = jest.spyOn(process, 'cpuUsage').mockImplementation((previous?: NodeJS.CpuUsage) => (
      previous ? { user: 0, system: 0 } : { user: 0, system: 0 }
    ));
    hrtimeSpy = jest.spyOn(process.hrtime, 'bigint').mockImplementation(() => (
      BigInt(Date.now()) * 1_000_000n
    ));
  });

  afterEach(() => {
    cpuUsageSpy.mockRestore();
    hrtimeSpy.mockRestore();
    jest.useRealTimers();
  });

  it('uses the clamped interval for delay detection and logging', () => {
    const log = jest.fn();

    const stop = startCpuSpikeMonitor({
      log,
      sampleIntervalMs: 100,
      cpuThresholdPct: 0,
      minConsecutiveSamples: 2,
      minLogIntervalMs: 0,
    });

    expect(log).toHaveBeenCalledWith('[perf] cpu spike monitor started interval=250ms threshold=0%');

    jest.advanceTimersByTime(250);
    let spikeMessages = log.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('[perf] cpu spike cpu='));
    expect(spikeMessages).toHaveLength(0);

    jest.advanceTimersByTime(250);
    spikeMessages = log.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('[perf] cpu spike cpu='));
    expect(spikeMessages).toHaveLength(1);
    expect(spikeMessages[0]).toContain('lag=0ms');

    stop();
  });

  it('does not log monitor startup while disabled', () => {
    const log = jest.fn();

    const stop = startCpuSpikeMonitor({
      log,
      isEnabled: () => false,
      sampleIntervalMs: 100,
      cpuThresholdPct: 0,
      minConsecutiveSamples: 1,
      minLogIntervalMs: 0,
    });

    expect(log).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1000);
    expect(log).not.toHaveBeenCalled();

    stop();
  });
});
