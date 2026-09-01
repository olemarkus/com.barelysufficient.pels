import fs from 'node:fs';
import path from 'node:path';
import { expect, injectHomeyHostCss, test, type Page } from './fixtures/test';

// PR-5 solar visibility: the Usage-tab Solar card and the Overview hero
// "Solar now" subline, driven end-to-end through the browser stub. The stub
// payload mirrors the REAL /ui_power shape: the tracker is served verbatim
// from `settings.power_tracker_state` (see homey.stub.js buildPowerPayload),
// so the field names below are the production `PowerTrackerState` ones.
//
// The plan meta is patched to stay numerically consistent with the tracker:
// an exporting home's net grid power is NEGATIVE, so "Power now" must not
// show a positive draw above a subline that claims 2.1 kW of export.

const HOUR_MS = 3_600_000;

// Exporting story: production 3.2 kW, home load 1.1 kW, export 2.1 kW
// → net = −2.1 kW; background segment carries the gross 1.1 kW home load.
const EXPORTING_PLAN_META_PATCH = {
  totalKw: -2.1,
  lastPowerUpdateMs: Date.now() - 5 * 1000,
  headroomKw: 4.4,
  hardCapHeadroomKw: 10.1,
  controlledKw: 0,
  uncontrolledKw: 1.1,
} as const;

// All-used-at-home story: production 3.2 kW fully consumed, net import 0.4 kW.
const ALL_USED_PLAN_META_PATCH = {
  totalKw: 0.4,
  lastPowerUpdateMs: Date.now() - 5 * 1000,
  headroomKw: 1.9,
  hardCapHeadroomKw: 7.6,
  controlledKw: 0,
  uncontrolledKw: 0.4,
} as const;

const buildSolarTracker = (nowMs: number, trackerOverrides: Record<string, unknown> = {}) => {
  const currentHourMs = nowMs - (nowMs % HOUR_MS);
  const h = (offset: number) => new Date(currentHourMs + offset * HOUR_MS).toISOString();
  return {
    // Double-digit history kWh so layout assertions cover realistic widths.
    tracker: {
      buckets: { [h(0)]: 0.4 },
      generationBuckets: { [h(0)]: 2, [h(-24)]: 23.5, [h(-25)]: 8.9, [h(-48)]: 12.4 },
      exportBuckets: { [h(0)]: 0.5, [h(-24)]: 11.2, [h(-48)]: 10.8 },
      lastPowerW: -2100,
      lastGenerationW: 3200,
      lastTimestamp: nowMs,
      ...trackerOverrides,
    },
    prices: [
      { startsAt: h(0), total: 100, exportPrice: 40 },
      { startsAt: h(-24), total: 110, exportPrice: 45 },
      { startsAt: h(-25), total: 105, exportPrice: 45 },
      { startsAt: h(-48), total: 100, exportPrice: 40 },
    ],
  };
};

const installSolarStub = async (
  page: Page,
  trackerOverrides: Record<string, unknown> = {},
  planMetaPatch: Record<string, unknown> = EXPORTING_PLAN_META_PATCH,
) => {
  const { tracker, prices } = buildSolarTracker(Date.now(), trackerOverrides);
  await page.addInitScript(({ trackerState, combinedPrices, metaPatch }) => {
    (window as unknown as { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
      settings: {
        power_source: 'homey_energy',
        power_tracker_state: trackerState,
        combined_prices: combinedPrices,
        plan_snapshot_meta_patch: metaPatch,
      },
    };
  }, { trackerState: tracker, combinedPrices: prices, metaPatch: planMetaPatch });
};

// Fresh solar home: a tracked PV device but no accounting yet. The snapshot
// override carries the solarpanel device the stub's power payload derives
// `hasManagedSolarDevice` from (mirroring the real producer).
const installGatheringStub = async (page: Page) => {
  await page.addInitScript(() => {
    (window as unknown as { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
      settings: {
        // The flag requires the homey_energy source — a flow home has no
        // solar signal and must never see the gathering card.
        power_source: 'homey_energy',
        target_devices_snapshot: [
          { id: 'dev_pv', name: 'Solar Roof', deviceClass: 'solarpanel', targets: [] },
        ],
        // Measured (latched) but with NO generation buckets yet: the
        // gathering story is "solar configured, data not accrued", not a
        // gated home — the stub's status classification keys on the latch.
        power_tracker_state: { lastPowerW: 1100, lastTimestamp: Date.now() - 12_000 },
      },
    };
  });
};

const openUsageTab = async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Usage' }).click();
  await expect(page.locator('#usage-panel')).toBeVisible();
  await expect(page.locator('#usage-panel')).toHaveAttribute('data-loading', 'false');
};

test.describe('Usage tab Solar card', () => {
  test('renders today numbers, money lines, and previous days from solar buckets', async ({ page }) => {
    await installSolarStub(page);
    await openUsageTab(page);

    const card = page.locator('#solar-usage-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Produced');
    await expect(card).toContainText('Used at home');
    await expect(card).toContainText('Exported');
    // Current-hour generation is always attributed to "today".
    await expect(card.locator('.usage-metric__value').first()).toContainText('kWh');
    // Both prices present → both money lines, today-scoped, with the ≈ marker.
    await expect(card).toContainText('Grid cost avoided today');
    await expect(card).toContainText('Earned from export today');
    await expect(card.locator('#solar-usage-money')).toContainText('≈');
    await expect(card.locator('#solar-usage-history')).toContainText('Previous days');
    // The usage hero reconciles its net-import headline with the card.
    await expect(page.locator('#usage-hero-solar')).toContainText('of your own solar');
  });

  test('never overflows the usage panel (down to the 320px project)', async ({ page }) => {
    await installSolarStub(page);
    await openUsageTab(page);

    const card = page.locator('#solar-usage-card');
    await expect(card).toBeVisible();
    // Regression gate for the 320px blowout: the min-content history grid once
    // measured 316px against a 275px panel while every text-presence assertion
    // stayed green. Compare geometry, not content.
    const cardBox = await card.boundingBox();
    const panelBox = await page.locator('#usage-panel').boundingBox();
    expect(cardBox).not.toBeNull();
    expect(panelBox).not.toBeNull();
    expect(cardBox!.width).toBeLessThanOrEqual(panelBox!.width);
    // And the page itself must not grow a horizontal scrollbar.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('renders nothing for the default non-solar stub', async ({ page }) => {
    await openUsageTab(page);

    await expect(page.locator('#solar-usage-mount')).toBeAttached();
    await expect(page.locator('#solar-usage-card')).toHaveCount(0);
    expect(await page.locator('#solar-usage-mount').innerHTML()).toBe('');
    await expect(page.locator('#usage-hero-solar')).toBeHidden();
  });

  test('shows the gathering state for a tracked solar device with no accounting yet', async ({ page }) => {
    await installGatheringStub(page);
    await openUsageTab(page);

    const card = page.locator('#solar-usage-card');
    await expect(card).toBeVisible();
    await expect(card.locator('#solar-usage-gathering')).toContainText('Watching your solar production');
    await expect(card.locator('.usage-metric-row')).toHaveCount(0);
  });
});

test.describe('Overview "Solar now" subline', () => {
  test('shows the live production split for a fresh generation sample', async ({ page }) => {
    await installSolarStub(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const subline = page.locator('#plan-hero-solar-now');
    await expect(subline).toBeVisible();
    await expect(subline).toHaveText('Solar now 3.2 kW — 1.1 kW at home, 2.1 kW exported');
  });

  test('says "all used at home" when export is negligible', async ({ page }) => {
    await installSolarStub(page, { lastPowerW: 400 }, ALL_USED_PLAN_META_PATCH);
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#plan-hero-solar-now')).toHaveText('Solar now 3.2 kW — all used at home');
  });

  test('stays absent for a stale generation sample', async ({ page }) => {
    await installSolarStub(page, { lastTimestamp: Date.now() - 10 * 60 * 1000 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // The hero itself renders (plan + power present) — only the solar line is gone.
    await expect(page.locator('#plan-redesign-surface .plan-hero')).toBeVisible();
    await expect(page.locator('#plan-hero-solar-now')).toHaveCount(0);
  });
});

// Review-harness capture (not a CI assertion): dark-mobile shots of the Solar
// card and the Overview subline at 360px and 320px. Dark is gated on TOUCH
// (coarse pointer), so the context needs isMobile + hasTouch — chromium only.
//   PELS_SOLAR_SHOTS_DIR=/tmp/out npx playwright test solar-usage --project=chromium-mobile-width
const SHOTS_DIR = process.env.PELS_SOLAR_SHOTS_DIR;
const CAPTURE_WIDTHS = [360, 320] as const;

test.describe('solar screenshots (capture harness)', () => {
  test('captures the Usage solar card and Overview subline at 360/320px dark', async ({ browser, browserName, baseURL }) => {
    test.skip(!SHOTS_DIR, 'PELS_SOLAR_SHOTS_DIR not set');
    test.skip(browserName !== 'chromium', 'dark theme needs isMobile (chromium only)');
    fs.mkdirSync(SHOTS_DIR!, { recursive: true });
    for (const width of CAPTURE_WIDTHS) {
      const context = await browser.newContext({
        baseURL,
        viewport: { width, height: 1600 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        const page = await context.newPage();
        await injectHomeyHostCss(page);
        await installSolarStub(page);
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#plan-hero-solar-now')).toBeVisible();
        await page.waitForTimeout(300);
        await page.locator('#plan-redesign-surface .plan-hero').screenshot({
          path: path.join(SHOTS_DIR!, `overview-solar-now.dark-${width}.png`),
        });
        await page.getByRole('tab', { name: 'Usage' }).click();
        await expect(page.locator('#solar-usage-card')).toBeVisible();
        await page.waitForTimeout(300);
        await page.locator('#solar-usage-card').screenshot({
          path: path.join(SHOTS_DIR!, `usage-solar-card.dark-${width}.png`),
        });
      } finally {
        await context.close();
      }
    }
  });
});
