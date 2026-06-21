import { FlowPowerSampleFreshnessClock } from '../../setup/flowPowerSampleFreshnessClock';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import {
  POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
  POWER_SAMPLE_STALE_THRESHOLD_MS,
} from '../../packages/shared-domain/src/powerFreshness';
import type { PowerSource } from '../../lib/power/powerSource';

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

  it('requests planning-only hold ticks, then stale-hold and fail-closed transitions', async () => {
    const { clock, requests } = createClock();

    clock.noteSample(Date.now());

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requests).toEqual(['flow_power_sample_hold', 'flow_power_sample_hold']);

    await vi.advanceTimersByTimeAsync(POWER_SAMPLE_STALE_THRESHOLD_MS - 20_000);
    expect(requests).toEqual([
      'flow_power_sample_hold',
      'flow_power_sample_hold',
      'flow_power_sample_hold',
      'flow_power_sample_hold',
      'flow_power_sample_hold',
      'flow_power_sample_stale_hold',
    ]);

    await vi.advanceTimersByTimeAsync(
      POWER_SAMPLE_STALE_SHED_TIMEOUT_MS - POWER_SAMPLE_STALE_THRESHOLD_MS,
    );
    expect(requests).toEqual([
      'flow_power_sample_hold',
      'flow_power_sample_hold',
      'flow_power_sample_hold',
      'flow_power_sample_hold',
      'flow_power_sample_hold',
      'flow_power_sample_stale_hold',
      'flow_power_sample_fail_closed',
    ]);
  });

  it('seeds the silence ladder from a persisted fresh sample timestamp', async () => {
    const { clock, requests } = createClock();

    clock.syncLatestSample(Date.now() - 15_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(requests).toEqual(['flow_power_sample_hold']);
  });

  it('requests missed stale and fail-closed transitions when seeding an already old sample', async () => {
    const { clock, requests } = createClock();

    clock.syncLatestSample(Date.now() - POWER_SAMPLE_STALE_THRESHOLD_MS);
    expect(requests).toEqual(['flow_power_sample_stale_hold']);

    await vi.advanceTimersByTimeAsync(
      POWER_SAMPLE_STALE_SHED_TIMEOUT_MS - POWER_SAMPLE_STALE_THRESHOLD_MS,
    );
    expect(requests).toEqual([
      'flow_power_sample_stale_hold',
      'flow_power_sample_fail_closed',
    ]);
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

    await vi.advanceTimersByTimeAsync(15_000);
    expect(requests.at(-1)).toBe('flow_power_sample_stale_hold');
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
});
