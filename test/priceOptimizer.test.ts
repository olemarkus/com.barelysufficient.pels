import { PriceOptimizer } from '../lib/price/priceOptimizer';
import { PriceLevel } from '../lib/price/priceLevels';
import type { CombinedHourlyPrice } from '../lib/price/priceTypes';

const makeHour = (startsAt: string, totalPrice: number): CombinedHourlyPrice => ({
  startsAt,
  totalPrice,
  spotPrice: totalPrice,
  energyTax: 0,
  vatFactor: 1,
  gridTariff: 0,
  source: 'nordpool',
});

const makeDeps = (overrides: {
  isCheap?: boolean;
  isExpensive?: boolean;
  currentLevel?: PriceLevel;
} = {}) => {
  const rebuildPlan = vi.fn().mockResolvedValue(undefined);
  const structuredLog = { info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const prices = [makeHour('2024-01-01T12:00:00.000Z', 80)];
  const deps = {
    priceStatus: {
      getCurrentLevel: () => overrides.currentLevel ?? PriceLevel.NORMAL,
      isCurrentHourCheap: () => overrides.isCheap ?? false,
      isCurrentHourExpensive: () => overrides.isExpensive ?? false,
      getCombinedHourlyPrices: () => prices,
      getCurrentHourPriceInfo: () => 'N/A',
      getCurrentHourStartMs: () => new Date('2024-01-01T12:00:00.000Z').getTime(),
    },
    getSettings: () => ({ 'device-1': { enabled: true, cheapDelta: 10, expensiveDelta: 10 } }),
    isEnabled: () => true,
    getThresholdPercent: () => 20,
    getMinDiffOre: () => 5,
    rebuildPlan,
    log: vi.fn(),
    logDebug: vi.fn(),
    error: vi.fn(),
    structuredLog,
  };
  return { deps, rebuildPlan, structuredLog };
};

describe('PriceOptimizer.applyOnce', () => {
  it('emits previousMode=null on first call', async () => {
    const { deps, structuredLog } = makeDeps();
    const optimizer = new PriceOptimizer(deps);

    await optimizer.applyOnce();

    expect(structuredLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'price_optimization_completed', previousMode: null, mode: 'normal' }),
    );
  });

  it('emits previousMode matching the previous call mode', async () => {
    const { deps, structuredLog } = makeDeps({ isExpensive: true, currentLevel: PriceLevel.EXPENSIVE });
    const optimizer = new PriceOptimizer(deps);

    await optimizer.applyOnce();  // mode = expensive

    // Switch to normal
    deps.priceStatus.isCurrentHourExpensive = () => false;
    deps.priceStatus.getCurrentLevel = () => PriceLevel.NORMAL;
    await optimizer.applyOnce();

    const calls = structuredLog.info.mock.calls.map((c: unknown[]) => c[0]);
    const second = calls.find((c: Record<string, unknown>) => c['previousMode'] === 'expensive');
    expect(second).toBeDefined();
    expect(second?.['mode']).toBe('normal');
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
  });
});
