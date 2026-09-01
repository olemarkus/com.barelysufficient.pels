import { FlowPowerSampleFreshnessClock } from '../../lib/power/flowPowerSampleFreshnessClock';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import {
  POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
  POWER_SAMPLE_STALE_THRESHOLD_MS,
} from '../../packages/shared-domain/src/powerFreshness';
import type { PowerSource } from '../../lib/power/powerSource';
import { requireConfiguredPowerSource } from '../../setup/powerSourceSettings';

describe('FlowPowerSampleFreshnessClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createClock = (options: { source?: PowerSource } = {}) => {
    const timers = new TimerRegistry();
    const requests: string[] = [];
    let source: PowerSource = options.source ?? 'flow';
    const clock = new FlowPowerSampleFreshnessClock({
      timers,
      getNowMs: () => Date.now(),
      getPowerSource: () => source,
      requestPlanRebuild: (reason) => {
        requests.push(reason);
      },
      onPowerSourceReadError: vi.fn(),
    });
    return {
      clock,
      requests,
      timers,
      setSource: (nextSource: PowerSource) => {
        source = nextSource;
      },
    };
  };

  it('heartbeats while fresh, holds quietly, and escalates only at the shed timeout', async () => {
    const { clock, requests } = createClock();

    clock.noteSample(Date.now());

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requests).toEqual(['flow_power_sample_hold', 'flow_power_sample_hold']);

    // Past the freshness threshold the clock asks for NOTHING: the sample being a
    // minute old is not a new decision, and the last reading carries forward.
    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_THRESHOLD_MS - 20_000);
    expect(requests.every((reason) => reason === 'flow_power_sample_hold')).toBe(true);
    const beforeTimeout = requests.length;

    // The shed timeout is the one escalation, and it is a one-shot.
    await vi.advanceTimersByTimeAsync(
      POWER_SAMPLE_STALE_SHED_TIMEOUT_MS - POWER_SAMPLE_STALE_THRESHOLD_MS,
    );
    expect(requests.slice(beforeTimeout)).toEqual(['flow_power_sample_fail_closed']);
  });

  it('seeds the silence ladder from a persisted fresh sample timestamp', async () => {
    const { clock, requests } = createClock();

    clock.syncLatestSample(Date.now() - 15_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(requests).toEqual(['flow_power_sample_hold']);
  });

  it('holds quietly for a sample already past freshness, then escalates at the timeout', async () => {
    const { clock, requests } = createClock();

    clock.syncLatestSample(Date.now() - POWER_SAMPLE_STALE_THRESHOLD_MS);
    expect(requests).toEqual([]);

    await vi.advanceTimersByTimeAsync(
      POWER_SAMPLE_STALE_SHED_TIMEOUT_MS - POWER_SAMPLE_STALE_THRESHOLD_MS,
    );
    expect(requests).toEqual(['flow_power_sample_fail_closed']);
  });

  it('requests fail-closed immediately when seeding a sample past the fail-closed timeout', () => {
    const { clock, requests, timers } = createClock();

    clock.syncLatestSample(Date.now() - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS);

    expect(requests).toEqual(['flow_power_sample_fail_closed']);
    expect(timers.has('flowPowerSampleFreshness')).toBe(false);
  });

  it('resets the silence ladder when a newer real sample arrives', async () => {
    const { clock, requests } = createClock();

    clock.noteSample(Date.now());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requests).toEqual(['flow_power_sample_hold']);

    await vi.advanceTimersByTimeAsync(5_000);
    clock.noteSample(Date.now());
    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_THRESHOLD_MS - 15_000);
    expect(requests).toEqual([
      'flow_power_sample_hold',
      'flow_power_sample_hold',
      'flow_power_sample_hold',
      'flow_power_sample_hold',
      'flow_power_sample_hold',
    ]);

    // Crossing the threshold asks for nothing; the ladder is quiet until the
    // shed timeout.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(requests.at(-1)).toBe('flow_power_sample_hold');
  });

  it('stops without requesting rebuilds when the power source is not flow', async () => {
    const { clock, requests, timers, setSource } = createClock();

    clock.noteSample(Date.now());
    expect(timers.has('flowPowerSampleFreshness')).toBe(true);

    setSource('homey_energy');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(requests).toEqual([]);
    expect(timers.has('flowPowerSampleFreshness')).toBe(false);

    clock.noteSample(Date.now());
    expect(timers.has('flowPowerSampleFreshness')).toBe(false);
  });

  it('does not seed when the power source is not flow', async () => {
    const { clock, requests, timers } = createClock({ source: 'homey_energy' });

    clock.syncLatestSample(Date.now());

    expect(requests).toEqual([]);
    expect(timers.has('flowPowerSampleFreshness')).toBe(false);
  });

  it('retries a failed source read from the timer without losing the silence ladder', async () => {
    const timers = new TimerRegistry();
    const requests: string[] = [];
    const onPowerSourceReadError = vi.fn();
    let sourceReads = 0;
    const clock = new FlowPowerSampleFreshnessClock({
      timers,
      getNowMs: () => Date.now(),
      getPowerSource: () => {
        sourceReads += 1;
        if (sourceReads === 2) throw new Error('transient settings read');
        return 'flow';
      },
      requestPlanRebuild: (reason) => { requests.push(reason); },
      onPowerSourceReadError,
    });

    clock.noteSample(Date.now());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requests).toEqual([]);
    expect(timers.has('flowPowerSampleFreshness')).toBe(true);
    expect(onPowerSourceReadError).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(requests).toEqual(['flow_power_sample_hold']);

    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_SHED_TIMEOUT_MS);
    expect(requests.at(-1)).toBe('flow_power_sample_fail_closed');
  });

  it('retries when the classified source callback sees an existing key read as undefined', async () => {
    const timers = new TimerRegistry();
    const requests: string[] = [];
    const onPowerSourceReadError = vi.fn();
    let rawSource: unknown = 'flow';
    const settings = {
      get: () => rawSource,
      getKeys: () => ['power_source'],
    };
    const clock = new FlowPowerSampleFreshnessClock({
      timers,
      getNowMs: () => Date.now(),
      getPowerSource: () => requireConfiguredPowerSource(settings),
      requestPlanRebuild: (reason) => { requests.push(reason); },
      onPowerSourceReadError,
    });

    clock.noteSample(Date.now());
    rawSource = undefined;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(requests).toEqual([]);
    expect(timers.has('flowPowerSampleFreshness')).toBe(true);
    expect(onPowerSourceReadError).toHaveBeenCalledOnce();

    rawSource = 'flow';
    await vi.advanceTimersByTimeAsync(1_000);

    expect(requests).toEqual(['flow_power_sample_hold']);
    expect(timers.has('flowPowerSampleFreshness')).toBe(true);
  });

  it('retains a persisted sample when the source-change sync read fails', async () => {
    const timers = new TimerRegistry();
    const requests: string[] = [];
    let sourceReadFails = true;
    const clock = new FlowPowerSampleFreshnessClock({
      timers,
      getNowMs: () => Date.now(),
      getPowerSource: () => {
        if (sourceReadFails) throw new Error('settings unavailable');
        return 'flow';
      },
      requestPlanRebuild: (reason) => { requests.push(reason); },
      onPowerSourceReadError: vi.fn(),
    });

    clock.syncLatestSample(Date.now() - POWER_SAMPLE_STALE_THRESHOLD_MS);
    expect(timers.has('flowPowerSampleFreshness')).toBe(true);

    sourceReadFails = false;
    await vi.advanceTimersByTimeAsync(1_000);
    // Recovered, past freshness, before the timeout: nothing requested, still armed
    // for the escalation the timeout owes.
    expect(requests).toEqual([]);
    expect(timers.has('flowPowerSampleFreshness')).toBe(true);
  });
});
