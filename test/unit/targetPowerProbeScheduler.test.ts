import { TimerRegistry } from '../../lib/utils/timerRegistry';
import { TargetPowerProbeScheduler } from '../../lib/device/targetPowerProbeScheduler';
import { testLogger } from '../utils/testLogger';

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

describe('TargetPowerProbeScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rechecks a due probe after a bounded delay when no command was issued', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const rebuildForDueProbe = vi.fn(async () => {});
    const scheduler = new TargetPowerProbeScheduler({
      timers: new TimerRegistry(),
      getNowMs: () => Date.now(),
      getNextProbe: () => ({ deviceId: 'charger', dueAtMs: 1_000 }),
      hasPendingProbe: () => false,
      rebuildForDueProbe,
      refreshForSettlement: vi.fn(async () => {}),
      getLogger: () => testLogger,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(rebuildForDueProbe).toHaveBeenCalledTimes(1);
    expect(rebuildForDueProbe).toHaveBeenLastCalledWith('charger');

    for (let refresh = 0; refresh < 11; refresh += 1) {
      await vi.advanceTimersByTimeAsync(5_000);
      scheduler.scheduleProbe();
    }
    await vi.advanceTimersByTimeAsync(4_999);
    expect(rebuildForDueProbe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rebuildForDueProbe).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('leaves the wake clock to settlement once the probe was issued', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let pending = false;
    const rebuildForDueProbe = vi.fn(async () => { pending = true; });
    const scheduler = new TargetPowerProbeScheduler({
      timers: new TimerRegistry(),
      getNowMs: () => Date.now(),
      getNextProbe: () => ({ deviceId: 'charger', dueAtMs: 1_000 }),
      hasPendingProbe: () => pending,
      rebuildForDueProbe,
      refreshForSettlement: vi.fn(async () => {}),
      getLogger: () => testLogger,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.scheduleProbe();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(rebuildForDueProbe).toHaveBeenCalledTimes(1);

    pending = false;
    scheduler.scheduleProbe();
    await vi.advanceTimersByTimeAsync(0);
    expect(rebuildForDueProbe).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('rechecks a changed candidate after an in-flight rebuild finishes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let probe = { deviceId: 'charger', dueAtMs: 1_000 };
    const rebuild = createDeferred();
    const rebuildForDueProbe = vi.fn().mockReturnValueOnce(rebuild.promise).mockResolvedValue(undefined);
    const scheduler = new TargetPowerProbeScheduler({
      timers: new TimerRegistry(),
      getNowMs: () => Date.now(),
      getNextProbe: () => probe,
      hasPendingProbe: () => false,
      rebuildForDueProbe,
      refreshForSettlement: vi.fn(async () => {}),
      getLogger: () => testLogger,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    probe = { deviceId: 'charger', dueAtMs: 3_000 };
    scheduler.scheduleProbe();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rebuildForDueProbe).toHaveBeenCalledTimes(1);

    rebuild.resolve();
    await vi.advanceTimersByTimeAsync(999);
    expect(rebuildForDueProbe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rebuildForDueProbe).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('ignores a rebuild completion from before a stop and restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const earlier = createDeferred();
    const restarted = createDeferred();
    const rebuildForDueProbe = vi.fn().mockReturnValueOnce(earlier.promise).mockReturnValueOnce(restarted.promise);
    const scheduler = new TargetPowerProbeScheduler({
      timers: new TimerRegistry(),
      getNowMs: () => Date.now(),
      getNextProbe: () => ({ deviceId: 'charger', dueAtMs: 1_000 }),
      hasPendingProbe: () => false,
      rebuildForDueProbe,
      refreshForSettlement: vi.fn(async () => {}),
      getLogger: () => testLogger,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.stop();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(rebuildForDueProbe).toHaveBeenCalledTimes(2);

    earlier.resolve();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(rebuildForDueProbe).toHaveBeenCalledTimes(2);

    scheduler.stop();
    restarted.resolve();
  });
});
