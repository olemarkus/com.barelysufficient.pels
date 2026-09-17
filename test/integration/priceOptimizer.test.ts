import { PriceOptimizer, type PriceOptimizerDeps } from '../../lib/price/priceOptimizer';
import type { CombinedPricePeriod } from '../../lib/price/priceTypes';

const makeHour = (startsAt: string, totalPrice: number): CombinedPricePeriod => ({
  startsAt,
  totalPrice,
  durationMinutes: 60,
});

/**
 * A day of flat prices, with the hour covering `now` priced apart from the rest
 * so it classifies at the level the test asked for. The optimizer resolves the
 * mode from the series itself, so this is how a test says "it is expensive now".
 */
const dayWithCurrentHour = (currentPrice: number): CombinedPricePeriod[] => {
  const hourStartMs = new Date(Date.now()).setMinutes(0, 0, 0);
  return Array.from({ length: 24 }, (_, index) => makeHour(
    new Date(hourStartMs + (index - 12) * 3_600_000).toISOString(),
    index === 12 ? currentPrice : 100,
  ));
};

const makeDeps = (overrides: { currentPrice?: number } = {}) => {
  const rebuildPlan = vi.fn().mockResolvedValue(undefined);
  const structuredLog = { info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const state = { prices: dayWithCurrentHour(overrides.currentPrice ?? 100) };
  const deps: PriceOptimizerDeps = {
    priceStatus: {
      getCombinedPricePeriods: () => state.prices,
    },
    getSettings: () => ({ 'device-1': { enabled: true, cheapDelta: 10, expensiveDelta: 10 } }),
    isEnabled: () => true,
    getThresholdPercent: () => 20,
    getMinDiffOre: () => 5,
    rebuildPlan,
    debugStructured: vi.fn(),
    // Partial pino mock: only the methods the optimizer logs through are stubbed.
    structuredLog: structuredLog as unknown as PriceOptimizerDeps['structuredLog'],
  };
  return { deps, rebuildPlan, structuredLog, state };
};

describe('PriceOptimizer.applyOnce', () => {
  it('emits previousMode=null on first call', async () => {
    const { deps, structuredLog } = makeDeps();
    const optimizer = new PriceOptimizer(deps);

    await optimizer.applyOnce();

    expect(structuredLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'price_optimization_completed',
        previousMode: null,
        resultingMode: 'normal',
        mode: 'normal',
        transition: 'price_period_transition',
      }),
    );
  });

  it('emits previousMode matching the previous call mode', async () => {
    const { deps, structuredLog, state } = makeDeps({ currentPrice: 300 });
    const optimizer = new PriceOptimizer(deps);

    await optimizer.applyOnce();  // mode = expensive

    // The price falls back in line with the rest of the day.
    state.prices = dayWithCurrentHour(100);
    await optimizer.applyOnce();

    const calls = structuredLog.info.mock.calls.map((c: unknown[]) => c[0]);
    const second = calls.find((c) => (c as Record<string, unknown>)['previousMode'] === 'expensive');
    expect(second).toBeDefined();
    expect(second).toMatchObject({
      previousMode: 'expensive',
      resultingMode: 'normal',
      mode: 'normal',
      transition: 'price_period_transition',
    });
  });

  it('emits same mode for both previousMode and mode when mode is unchanged', async () => {
    const { deps, structuredLog } = makeDeps();
    const optimizer = new PriceOptimizer(deps);

    await optimizer.applyOnce();
    await optimizer.applyOnce();

    const calls = structuredLog.info.mock.calls.map((c: unknown[]) => c[0]);
    const second = calls[1] as Record<string, unknown>;
    expect(second?.['previousMode']).toBe('normal');
    expect(second?.['mode']).toBe('normal');
    expect(second?.['resultingMode']).toBe('normal');
    expect(second?.['transition']).toBe('steady');
  });
});

// The optimizer wakes when the price changes. On a 15-minute zone that is four
// times an hour, and it has to be: a cheap quarter the owner's heating never
// hears about is a cheap quarter that did not happen.
describe('PriceOptimizer cadence', () => {
  const quarterAt = (startsAt: string, totalPrice: number) => ({
    startsAt,
    totalPrice,
    durationMinutes: 15,
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-applies at each quarter boundary on a 15-minute zone', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    const { deps, structuredLog } = makeDeps();
    deps.priceStatus.getCombinedPricePeriods = () => [
      quarterAt('2026-01-01T12:00:00.000Z', 10),
      quarterAt('2026-01-01T12:15:00.000Z', 20),
      quarterAt('2026-01-01T12:30:00.000Z', 30),
    ];
    const optimizer = new PriceOptimizer(deps);

    await optimizer.start(false);
    const afterStart = structuredLog.info.mock.calls.length;

    await vi.advanceTimersByTimeAsync(15 * 60_000 + 2_000);
    const afterFirstQuarter = structuredLog.info.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    const afterSecondQuarter = structuredLog.info.mock.calls.length;

    optimizer.stop();
    expect(afterFirstQuarter).toBe(afterStart + 1);
    expect(afterSecondQuarter).toBe(afterStart + 2);
  });

  it('waits out the whole hour on an hourly zone', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    const { deps, structuredLog } = makeDeps();
    deps.priceStatus.getCombinedPricePeriods = () => [
      { startsAt: '2026-01-01T12:00:00.000Z', totalPrice: 10, durationMinutes: 60 },
      { startsAt: '2026-01-01T13:00:00.000Z', totalPrice: 20, durationMinutes: 60 },
    ];
    const optimizer = new PriceOptimizer(deps);

    await optimizer.start(false);
    const afterStart = structuredLog.info.mock.calls.length;

    await vi.advanceTimersByTimeAsync(45 * 60_000);
    const midHour = structuredLog.info.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 2_000);
    const afterHour = structuredLog.info.mock.calls.length;

    optimizer.stop();
    expect(midHour).toBe(afterStart);
    expect(afterHour).toBe(afterStart + 1);
  });

  // Each firing arms the next, so a stopped optimizer that is still mid-start
  // would otherwise re-arm itself forever and keep rebuilding plans on a
  // torn-down app. Starting waits on two network refreshes, so teardown really
  // can land before there is any timer to clear.
  it('stays stopped when teardown lands while it is still starting', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    const { deps, structuredLog } = makeDeps();
    deps.priceStatus.getCombinedPricePeriods = () => [
      quarterAt('2026-01-01T12:00:00.000Z', 10),
      quarterAt('2026-01-01T12:15:00.000Z', 20),
    ];
    const optimizer = new PriceOptimizer(deps);

    // Teardown arrives mid-start, before there is any timer to clear.
    const starting = optimizer.start();
    optimizer.stop();
    await starting;
    const afterStart = structuredLog.info.mock.calls.length;

    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(structuredLog.info.mock.calls.length).toBe(afterStart);
  });

  it('stops firing once stopped', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    const { deps, structuredLog } = makeDeps();
    deps.priceStatus.getCombinedPricePeriods = () => [
      quarterAt('2026-01-01T12:00:00.000Z', 10),
      quarterAt('2026-01-01T12:15:00.000Z', 20),
    ];
    const optimizer = new PriceOptimizer(deps);

    await optimizer.start(false);
    optimizer.stop();
    const afterStop = structuredLog.info.mock.calls.length;

    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(structuredLog.info.mock.calls.length).toBe(afterStop);
  });

  // A settings read can fail transiently. If that took the chain with it, the
  // app would stop following prices until it restarted.
  it('keeps scheduling when the price read throws at a boundary', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    const { deps, structuredLog } = makeDeps();
    let failing = false;
    deps.priceStatus.getCombinedPricePeriods = () => {
      if (failing) throw new Error('settings read failed');
      return [
        quarterAt('2026-01-01T12:00:00.000Z', 10),
        quarterAt('2026-01-01T12:15:00.000Z', 20),
        quarterAt('2026-01-01T13:15:00.000Z', 30),
      ];
    };
    const optimizer = new PriceOptimizer(deps);

    await optimizer.start(false);
    failing = true;
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 2_000);
    const afterFailedBoundary = structuredLog.info.mock.calls.length;

    // The read recovers, and the chain is still alive to use it.
    failing = false;
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    optimizer.stop();
    expect(structuredLog.info.mock.calls.length).toBeGreaterThan(afterFailedBoundary);
  });

  it('wakes at the next priced period when one is missing from the current hour', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01T12:20:00.000Z'));
    const { deps, structuredLog } = makeDeps();
    // The :15 quarter is gone; :30 is still priced and is 10 minutes away.
    deps.priceStatus.getCombinedPricePeriods = () => [
      quarterAt('2026-01-01T12:00:00.000Z', 10),
      quarterAt('2026-01-01T12:30:00.000Z', 20),
    ];
    const optimizer = new PriceOptimizer(deps);

    await optimizer.start(false);
    const afterStart = structuredLog.info.mock.calls.length;

    await vi.advanceTimersByTimeAsync(10 * 60_000 + 2_000);

    optimizer.stop();
    // Sleeping to the top of the hour would have skipped the :30 transition.
    expect(structuredLog.info.mock.calls.length).toBe(afterStart + 1);
  });

  it('retires an overlapping start rather than running two chains', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    const { deps, structuredLog } = makeDeps();
    deps.priceStatus.getCombinedPricePeriods = () => [
      quarterAt('2026-01-01T12:00:00.000Z', 10),
      quarterAt('2026-01-01T12:15:00.000Z', 20),
      quarterAt('2026-01-01T12:30:00.000Z', 30),
    ];
    const optimizer = new PriceOptimizer(deps);

    // Two starts overlap: both get past their own `stop()` before either arms.
    const first = optimizer.start();
    const second = optimizer.start();
    await Promise.all([first, second]);
    const afterStarts = structuredLog.info.mock.calls.length;

    await vi.advanceTimersByTimeAsync(15 * 60_000 + 2_000);

    optimizer.stop();
    // One boundary, one firing — not one per abandoned chain.
    expect(structuredLog.info.mock.calls.length).toBe(afterStarts + 1);
  });

  it('falls back to the next hour when no period covers now', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01T12:20:00.000Z'));
    const { deps, structuredLog } = makeDeps();
    deps.priceStatus.getCombinedPricePeriods = () => [];
    const optimizer = new PriceOptimizer(deps);

    await optimizer.start(false);
    const afterStart = structuredLog.info.mock.calls.length;

    await vi.advanceTimersByTimeAsync(39 * 60_000);
    const beforeHour = structuredLog.info.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const afterHour = structuredLog.info.mock.calls.length;

    optimizer.stop();
    expect(beforeHour).toBe(afterStart);
    expect(afterHour).toBe(afterStart + 1);
  });
});
