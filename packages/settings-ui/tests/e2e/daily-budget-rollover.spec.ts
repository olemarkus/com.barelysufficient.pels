import { expect, test, type Page } from './fixtures/test';
import { build as buildRuntimeBundle } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../../contracts/src/dailyBudgetTypes';

const TZ = 'Europe/Oslo';
const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

type DailyBudgetRuntimeModule = {
  DailyBudgetManager: typeof import('../../../../lib/dailyBudget/dailyBudgetManager').DailyBudgetManager;
  normalizeWeights: typeof import('../../../../lib/dailyBudget/dailyBudgetMath').normalizeWeights;
  getDateKeyInTimeZone: typeof import('../../../../lib/utils/dateUtils').getDateKeyInTimeZone;
  getDateKeyStartMs: typeof import('../../../../lib/utils/dateUtils').getDateKeyStartMs;
};

let runtimeBundleDir: string | null = null;
let dailyBudgetRuntimeModulePromise: Promise<DailyBudgetRuntimeModule> | null = null;

const loadDailyBudgetRuntimeModule = () => {
  if (dailyBudgetRuntimeModulePromise) return dailyBudgetRuntimeModulePromise;
  dailyBudgetRuntimeModulePromise = (async () => {
    runtimeBundleDir = mkdtempSync(path.join(tmpdir(), 'pels-daily-budget-e2e-'));
    const runtimeBundleFile = path.join(runtimeBundleDir, 'daily-budget-runtime.cjs');
    await buildRuntimeBundle({
      stdin: {
        contents: [
          "export { DailyBudgetManager } from './lib/dailyBudget/dailyBudgetManager';",
          "export { normalizeWeights } from './lib/dailyBudget/dailyBudgetMath';",
          "export { getDateKeyInTimeZone, getDateKeyStartMs } from './lib/utils/dateUtils';",
        ].join('\n'),
        resolveDir: repoRoot,
        sourcefile: path.join(repoRoot, 'daily-budget-rollover.runtime.ts'),
        loader: 'ts',
      },
      bundle: true,
      format: 'cjs',
      outfile: runtimeBundleFile,
      platform: 'node',
      target: 'node22',
      logLevel: 'silent',
    });
    return require(runtimeBundleFile) as DailyBudgetRuntimeModule;
  })();
  return dailyBudgetRuntimeModulePromise;
};

test.afterAll(() => {
  if (runtimeBundleDir) {
    rmSync(runtimeBundleDir, { recursive: true, force: true });
    runtimeBundleDir = null;
  }
  dailyBudgetRuntimeModulePromise = null;
});

const buildSettings = () => ({
  enabled: true,
  dailyBudgetKWh: 10,
  priceShapingEnabled: true,
  controlledUsageWeight: 1,
  priceShapingFlexShare: 1,
});

const wrapPayload = (day: DailyBudgetDayPayload): DailyBudgetUiPayload => ({
  days: { [day.dateKey]: day },
  todayKey: day.dateKey,
  tomorrowKey: null,
  yesterdayKey: null,
});

const buildRolloverPayloads = async () => {
  const {
    DailyBudgetManager,
    normalizeWeights,
    getDateKeyInTimeZone,
    getDateKeyStartMs,
  } = await loadDailyBudgetRuntimeModule();
  const manager = new DailyBudgetManager({
    log: () => undefined,
    logDebug: () => undefined,
  });
  const settings = buildSettings();
  const dateKey = getDateKeyInTimeZone(new Date(Date.UTC(2024, 0, 15, 0, 10)), TZ);
  const dayStart = getDateKeyStartMs(dateKey, TZ);
  const firstNow = dayStart + 10 * 60 * 1000;
  const secondNow = dayStart + 70 * 60 * 1000;
  const firstBucketKey = new Date(dayStart).toISOString();
  const secondBucketKey = new Date(dayStart + 60 * 60 * 1000).toISOString();
  const prices = [
    10,
    100,
    ...Array.from({ length: 22 }, () => 100),
  ].map((total, hour) => ({
    startsAt: new Date(dayStart + hour * 60 * 60 * 1000).toISOString(),
    total,
  }));

  manager.loadState({
    profileUncontrolled: {
      weights: normalizeWeights([1, 1, ...Array.from({ length: 22 }, () => 0)]),
      sampleCount: 14,
    },
    profileControlled: {
      weights: normalizeWeights([1, 1, ...Array.from({ length: 22 }, () => 0)]),
      sampleCount: 14,
    },
    profileControlledShare: 0.5,
    profileSampleCount: 14,
    profileSplitSampleCount: 14,
  });

  const before = manager.update({
    nowMs: firstNow,
    timeZone: TZ,
    settings,
    powerTracker: { buckets: { [firstBucketKey]: 0, [secondBucketKey]: 0 } },
    combinedPrices: { prices },
    priceOptimizationEnabled: true,
  }).snapshot;

  const after = manager.update({
    nowMs: secondNow,
    timeZone: TZ,
    settings,
    powerTracker: { buckets: { [firstBucketKey]: 0, [secondBucketKey]: 0 } },
    combinedPrices: { prices },
    priceOptimizationEnabled: true,
  }).snapshot;

  return {
    before: wrapPayload(before),
    after: wrapPayload(after),
  };
};

const installDailyBudgetStub = async (page: Page, payload: DailyBudgetUiPayload) => {
  const today = payload.days[payload.todayKey];
  await page.addInitScript((params) => {
    (window as StubbedHomeyWindow).__PELS_HOMEY_STUB__ = {
      settings: params.settings,
      dailyBudgetPayload: params.payload,
    };
  }, {
    settings: {
      daily_budget_enabled: today.budget.enabled,
      daily_budget_kwh: today.budget.dailyBudgetKWh,
      daily_budget_price_shaping_enabled: today.budget.priceShapingEnabled,
      daily_budget_controlled_weight: 1,
      daily_budget_price_flex_share: 1,
      daily_budget_breakdown_enabled: true,
    },
    payload,
  });
};

type BucketShape = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type BucketGeometry = {
  uncontrolled: BucketShape;
  controlled: BucketShape;
};

type StubbedHomeyWindow = Window & {
  __PELS_HOMEY_STUB__?: {
    settings: Record<string, unknown>;
    dailyBudgetPayload: DailyBudgetUiPayload;
  };
  Homey?: {
    __stub?: {
      getApiCallCount: (key: string) => number;
      setDailyBudgetPayload: (nextPayload: DailyBudgetUiPayload) => void;
      emitSettingsSet: (key: string) => void;
    };
  };
};

const getPlannedBucketGeometry = async (page: Page, bucketIndex: number): Promise<BucketGeometry | null> => (
  page.evaluate((targetBucketIndex) => {
    const barsEl = document.querySelector('#daily-budget-bars');
    const svg = barsEl?.querySelector('svg');
    if (!(barsEl instanceof HTMLElement) || !(svg instanceof SVGSVGElement)) {
      return null;
    }

    const normalizeColor = (value: string, fallback: string) => {
      const probe = document.createElement('div');
      probe.style.color = value || fallback;
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color.replace(/\s+/g, '');
      probe.remove();
      return color;
    };

    const styles = getComputedStyle(barsEl);
    const uncontrolledColor = normalizeColor(
      styles.getPropertyValue('--day-view-color-uncontrolled').trim(),
      '#3AA9FF',
    );
    const controlledColor = normalizeColor(
      styles.getPropertyValue('--day-view-color-controlled').trim(),
      '#F2A13E',
    );
    const maxChartY = svg.getBoundingClientRect().height - 40;
    const paths = Array.from(svg.querySelectorAll('path'))
      .map((path) => ({
        fill: getComputedStyle(path).fill.replace(/\s+/g, ''),
        bbox: path.getBBox(),
      }))
      .filter(({ fill, bbox }) => (
        bbox.width > 0
        && bbox.height > 0
        && bbox.y < maxChartY
        && (fill === uncontrolledColor || fill === controlledColor)
      ));

    const resolveBucket = (fillColor: string) => {
      const buckets = paths
        .filter((entry) => entry.fill === fillColor)
        .sort((left, right) => left.bbox.x - right.bbox.x);
      const match = buckets[targetBucketIndex];
      if (!match) return null;
      return {
        x: Number(match.bbox.x.toFixed(3)),
        y: Number(match.bbox.y.toFixed(3)),
        width: Number(match.bbox.width.toFixed(3)),
        height: Number(match.bbox.height.toFixed(3)),
      };
    };

    const uncontrolled = resolveBucket(uncontrolledColor);
    const controlled = resolveBucket(controlledColor);
    if (!uncontrolled || !controlled) return null;
    return { uncontrolled, controlled };
  }, bucketIndex)
);

const expectSameShape = (actual: BucketShape, expected: BucketShape) => {
  expect(actual.x).toBeCloseTo(expected.x, 3);
  expect(actual.y).toBeCloseTo(expected.y, 3);
  expect(actual.width).toBeCloseTo(expected.width, 3);
  expect(actual.height).toBeCloseTo(expected.height, 3);
};

const refreshDailyBudget = async (page: Page, payload: DailyBudgetUiPayload) => {
  const previousCallCount = await page.evaluate(() => {
    const homey = (window as StubbedHomeyWindow).Homey;
    return homey?.__stub?.getApiCallCount('GET /daily_budget') ?? 0;
  });
  await page.evaluate((nextPayload) => {
    const homey = (window as StubbedHomeyWindow).Homey;
    homey?.__stub?.setDailyBudgetPayload(nextPayload);
    homey?.__stub?.emitSettingsSet('power_tracker_state');
  }, payload);
  await page.waitForFunction((expectedPreviousCallCount) => {
    const homey = (window as StubbedHomeyWindow).Homey;
    return (homey?.__stub?.getApiCallCount('GET /daily_budget') ?? 0) > expectedPreviousCallCount;
  }, previousCallCount);
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
};

test.describe('Daily budget rollover chart', () => {
  test('keeps the planned split stable when a locked hour becomes past', async ({ page }) => {
    const { before, after } = await buildRolloverPayloads();
    const beforeDay = before.days[before.todayKey];
    const afterDay = after.days[after.todayKey];

    expect(beforeDay.currentBucketIndex).toBe(0);
    expect(afterDay.currentBucketIndex).toBe(1);
    expect(afterDay.buckets.plannedKWh[0]).toBeCloseTo(beforeDay.buckets.plannedKWh[0], 6);
    expect(afterDay.buckets.plannedUncontrolledKWh?.[0]).toBeCloseTo(beforeDay.buckets.plannedUncontrolledKWh?.[0] ?? 0, 6);
    expect(afterDay.buckets.plannedControlledKWh?.[0]).toBeCloseTo(beforeDay.buckets.plannedControlledKWh?.[0] ?? 0, 6);

    await installDailyBudgetStub(page, before);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Budget' }).click();
    await expect(page.locator('#budget-panel')).toBeVisible();
    await expect(page.locator('#daily-budget-bars svg')).toBeVisible();

    const beforeGeometry = await getPlannedBucketGeometry(page, 0);
    expect(beforeGeometry).not.toBeNull();

    await refreshDailyBudget(page, after);

    const afterGeometry = await getPlannedBucketGeometry(page, 0);
    expect(afterGeometry).not.toBeNull();
    expectSameShape(afterGeometry!.uncontrolled, beforeGeometry!.uncontrolled);
    expectSameShape(afterGeometry!.controlled, beforeGeometry!.controlled);
  });
});
