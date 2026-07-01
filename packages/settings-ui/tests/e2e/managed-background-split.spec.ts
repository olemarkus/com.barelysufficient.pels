import { expect, test, type Page } from './fixtures/test';

// Managed vs background usage made visible (owner-requested): the Usage
// hourly chart stacks Background + Managed instead of a single Measured bar,
// and the Budget hero renders the split as a compact labeled stacked bar.
// These tests drive the real bundle through the stub seam and assert the
// rendered surfaces, complementing the option-level unit tests in
// `test/power-ui.test.ts` and `test/budgetHeroSplit.test.ts`.

const FIXED_NOW_MS = Date.UTC(2025, 0, 6, 12, 30, 0);
const HOUR_MS = 60 * 60 * 1000;

// Every completed hour of the stub day carries the same measured total and
// managed/background split, so any selected hour asserts the same numbers —
// no fragile pixel-to-column math. The in-progress current hour gets its own
// distinct values for the default-selection assertion.
const buildSplitTrackerState = (nowMs = FIXED_NOW_MS) => {
  const currentHourStartMs = nowMs - (nowMs % HOUR_MS);
  const dayStartMs = currentHourStartMs - 12 * HOUR_MS; // fixed time is 12:30Z on a UTC stub day
  const buckets: Record<string, number> = {};
  const controlledBuckets: Record<string, number> = {};
  const uncontrolledBuckets: Record<string, number> = {};
  for (let ms = dayStartMs; ms < currentHourStartMs; ms += HOUR_MS) {
    const iso = new Date(ms).toISOString();
    buckets[iso] = 2.5;
    controlledBuckets[iso] = 1.0;
    uncontrolledBuckets[iso] = 1.5;
  }
  const currentIso = new Date(currentHourStartMs).toISOString();
  buckets[currentIso] = 1.2;
  controlledBuckets[currentIso] = 0.5;
  uncontrolledBuckets[currentIso] = 0.7;
  return { buckets, controlledBuckets, uncontrolledBuckets };
};

const installFixedNow = async (page: Page) => {
  await page.addInitScript(({ fixedNowMs, tracker }) => {
    const RealDate = Date;
    class FixedDate extends RealDate {
      constructor(value?: number | string | Date) {
        if (value === undefined) {
          super(fixedNowMs);
          return;
        }
        super(value);
      }

      static override now(): number {
        return fixedNowMs;
      }
    }

    Object.defineProperty(window, 'Date', {
      configurable: true,
      writable: true,
      value: FixedDate,
    });
    (window as unknown as { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
      settings: {
        power_tracker_state: tracker,
      },
    };
  }, { fixedNowMs: FIXED_NOW_MS, tracker: buildSplitTrackerState() });
};

test.describe('Managed vs background split visibility', () => {
  // The pinned readout row is the touch modality's caption surface (desktop
  // pointers get the floating tooltip instead), so ONLY the Usage tap test
  // runs in the chart-readout-touch spec's coarse-pointer emulation — the
  // static-DOM Budget-hero test below stays on every project, Firefox
  // included.
  test.describe('Usage day chart (touch readout)', () => {
    test.use({ hasTouch: true });
    test.skip(({ browserName }) => browserName !== 'chromium', 'pointer-coarse emulation is Chromium-only');

    test('stacks Background + Managed with a two-entry legend and reconciling readout', async ({ page }) => {
      await installFixedNow(page);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.getByRole('tab', { name: 'Usage' }).click();
      await expect(page.locator('#usage-panel')).toBeVisible();
      await expect(page.locator('#usage-day-bars svg').first()).toBeVisible();

      // Legend names the two stacked series — and only those (every measured
      // hour carries a split, so no fallback "Measured" legend entry and no
      // "Warning" entry appear).
      const chartText = page.locator('#usage-day-bars');
      await expect(chartText).toContainText('Background');
      await expect(chartText).toContainText('Managed');
      await expect(chartText).not.toContainText('Measured');
      await expect(chartText).not.toContainText('Warning');

      // Default readout selection is the in-progress current hour; its numbers
      // reconcile with the stacked segments (same bucket values feed both).
      const readout = page.locator('#usage-day-readout');
      await expect(readout).toBeVisible();
      await expect(readout).toContainText('Measured 1.20 kWh so far');
      await expect(readout).toContainText('Managed 0.50 kWh');
      await expect(readout).toContainText('Background 0.70 kWh');

      // Tap a completed hour (every completed hour carries the same split, so
      // the assertion is column-independent): the readout follows and its
      // Managed/Background figures match the tracker's buckets.
      const chart = page.locator('#usage-day-bars');
      await chart.scrollIntoViewIfNeeded();
      const box = await chart.boundingBox();
      expect(box).not.toBeNull();
      if (!box) return;
      await page.touchscreen.tap(box.x + box.width * 0.3, box.y + box.height * 0.5);
      await expect(readout).toContainText('Measured 2.50 kWh');
      await expect(readout).toContainText('Managed 1.00 kWh');
      await expect(readout).toContainText('Background 1.50 kWh');
    });
  });

  test('Budget hero renders the labeled managed/background split bar', async ({ page }) => {
    // Pin the clock so the stub payload's time-derived actual split is
    // deterministic (same idiom as budget-screenshots.spec.ts).
    await page.clock.setFixedTime(new Date('2026-01-15T11:13:00Z'));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Budget' }).click();
    await expect(page.locator('#budget-redesign-surface')).toBeVisible();

    const split = page.locator('#budget-redesign-split');
    await expect(split).toBeVisible();
    await expect(split).toContainText(/Managed \d+(\.\d+)? kWh/);
    await expect(split).toContainText(/Background \d+(\.\d+)? kWh/);
    // The stacked track renders both segments (mid-morning stub actuals are
    // non-zero on both sides).
    await expect(split.locator('.budget-hero-split__seg--managed')).toBeVisible();
    await expect(split.locator('.budget-hero-split__seg--background')).toBeVisible();
  });
});
