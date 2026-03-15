/**
 * @jest-environment node
 *
 * RSS benchmark for the plan-price-image rendering pipeline.
 *
 * Run with:  npm run test:perf -- --testPathPatterns='planPriceImageRss'
 *
 * Requires --expose-gc (handled by the test:perf script).
 * When run without --expose-gc (e.g. in CI), the RSS tests are skipped.
 */
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../lib/dailyBudget/dailyBudgetTypes';
import { buildPlanPricePng } from '../lib/insights/planPriceImage';

const MB = 1024 * 1024;

const buildDay = (bucketCount: number): DailyBudgetDayPayload => {
  const startUtc = Array.from({ length: bucketCount }, (_, index) => (
    new Date(Date.UTC(2025, 2, 30, index, 0, 0, 0)).toISOString()
  ));
  const zeros = Array.from({ length: bucketCount }, () => 0);
  return {
    dateKey: '2025-03-30',
    timeZone: 'Europe/Oslo',
    nowUtc: '2025-03-30T12:00:00.000Z',
    dayStartUtc: '2025-03-30T00:00:00.000Z',
    currentBucketIndex: 12,
    budget: {
      enabled: true,
      dailyBudgetKWh: 10,
      priceShapingEnabled: false,
    },
    state: {
      usedNowKWh: 5,
      allowedNowKWh: 5,
      remainingKWh: 5,
      deviationKWh: 0,
      exceeded: false,
      frozen: false,
      confidence: 1,
      priceShapingActive: false,
    },
    buckets: {
      startUtc,
      startLocalLabels: startUtc.map((_, index) => String(index).padStart(2, '0') + ':00'),
      plannedWeight: Array.from({ length: bucketCount }, () => 1),
      plannedKWh: Array.from({ length: bucketCount }, () => 10 / bucketCount),
      actualKWh: Array.from({ length: bucketCount }, (_, index) => (index < 12 ? 0.4 : 0)),
      allowedCumKWh: zeros,
    },
  };
};

const buildSnapshot = (): DailyBudgetUiPayload => {
  const day = buildDay(24);
  return {
    days: { [day.dateKey]: day },
    todayKey: day.dateKey,
  };
};

const hasGc = typeof (globalThis as unknown as { gc?: unknown }).gc === 'function';

const forceGc = (): void => {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  if (typeof gc === 'function') gc();
};

const measureRss = (): number => {
  forceGc();
  return process.memoryUsage().rss;
};

const log = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

describe('planPriceImage RSS benchmark', () => {
  const snapshot = buildSnapshot();

  it('should produce a valid PNG', async () => {
    const png = await buildPlanPricePng({ snapshot, dayKey: snapshot.todayKey });
    expect(png).toBeInstanceOf(Uint8Array);
    expect(png.length).toBeGreaterThan(1000);
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
    expect(png[2]).toBe(0x4E);
    expect(png[3]).toBe(0x47);
  });

  const rssIt = hasGc ? it : it.skip;

  rssIt('first render should not increase RSS by more than 8 MB', async () => {
    const baselineRss = measureRss();
    await buildPlanPricePng({ snapshot, dayKey: snapshot.todayKey });
    const afterRss = measureRss();
    const deltaMb = (afterRss - baselineRss) / MB;
    log(`[RSS-GATE] first render delta=${deltaMb.toFixed(1)} MB`);
    expect(deltaMb).toBeLessThan(8);
  });

  rssIt('per-render RSS accumulation should stay below 2 MB', async () => {
    // Warmup: 3 renders to stabilize module/font loading costs
    for (let i = 0; i < 3; i += 1) {
      await buildPlanPricePng({ snapshot, dayKey: snapshot.todayKey });
      forceGc();
    }
    const warmRss = measureRss();

    const renderCount = 10;
    for (let i = 0; i < renderCount; i += 1) {
      await buildPlanPricePng({ snapshot, dayKey: snapshot.todayKey });
      forceGc();
    }
    const afterRss = measureRss();
    const perRenderMb = (afterRss - warmRss) / MB / renderCount;
    log(`[RSS-GATE] per-render=${perRenderMb.toFixed(2)} MB  (${renderCount} renders, warmup=${(warmRss / MB).toFixed(1)} MB, after=${(afterRss / MB).toFixed(1)} MB)`);
    expect(perRenderMb).toBeLessThan(2);
  }, 60_000);
});
