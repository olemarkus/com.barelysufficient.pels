import { TimerRegistry } from '../../lib/utils/timerRegistry';
import { TargetPowerProbeScheduler } from '../../lib/device/targetPowerProbeScheduler';

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
      getLogger: () => undefined,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(rebuildForDueProbe).toHaveBeenCalledTimes(1);
    expect(rebuildForDueProbe).toHaveBeenLastCalledWith('charger');

    await vi.advanceTimersByTimeAsync(59_999);
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
      getLogger: () => undefined,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(rebuildForDueProbe).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
});
