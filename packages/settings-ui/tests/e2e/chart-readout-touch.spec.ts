import { expect, test, type Page } from './fixtures/test';

// Phase 3 interaction grammar, touch modality: on coarse pointers the
// Usage-tab charts disable the ECharts floating tooltip and drive a pinned
// readout row under the plot instead — tap a column to select it (visible
// select border on the bar), tap outside the plot grid to restore the
// default selection. `hasTouch` flips Chromium's `(pointer: coarse)` media
// (the same gate the app's dark theme uses), which is exactly the signal
// `prefersCoarsePointer()` reads.
test.use({ hasTouch: true });

// `hasTouch` does not reliably flip the pointer media features in Firefox,
// so the touch grammar is asserted on the two Chromium width projects only.
test.skip(({ browserName }) => browserName !== 'chromium', 'pointer-coarse emulation is Chromium-only');

const openUsageTab = async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('tablist')).toBeVisible();
  await page.getByRole('tab', { name: 'Usage' }).click();
  await expect(page.locator('#usage-panel')).toBeVisible();
  await expect(page.locator('#hourly-pattern svg')).toBeVisible();
};

const tapChart = async (page: Page, selector: string, xFraction: number, yFraction: number) => {
  const chart = page.locator(selector);
  // `touchscreen.tap` works in raw viewport coordinates and does NOT
  // auto-scroll like locator actions do — bring the chart into view first.
  await chart.scrollIntoViewIfNeeded();
  const box = await chart.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  await page.touchscreen.tap(box.x + box.width * xFraction, box.y + box.height * yFraction);
};

const countSelectBorders = (page: Page, selector: string) => (
  page.evaluate((chartSelector) => {
    const svg = document.querySelector(`${chartSelector} svg`);
    if (!svg) return -1;
    return [...svg.querySelectorAll('path')].filter((path) => {
      const stroke = path.getAttribute('stroke');
      return path.getAttribute('stroke-width') === '2' && stroke !== null && stroke !== 'none';
    }).length;
  }, selector)
);

test('coarse pointers drive the pinned readout instead of a floating tooltip', async ({ page }) => {
  await openUsageTab(page);

  // Sanity: the emulated environment must actually report a coarse pointer,
  // otherwise every assertion below would test the desktop path.
  expect(await page.evaluate(() => window.matchMedia('(hover: none), (pointer: coarse)').matches)).toBe(true);

  // All three Usage-tab readout rows render their default selection — the
  // row is never empty.
  for (const readout of ['#usage-day-readout', '#daily-history-readout', '#hourly-pattern-readout']) {
    await expect(page.locator(`${readout} .chart-readout__primary`)).not.toHaveText('');
  }

  const readoutPrimary = page.locator('#hourly-pattern-readout .chart-readout__primary');
  await expect(readoutPrimary).toHaveText(/^\d{2}:00–\d{2}:00$/);
  const defaultText = await readoutPrimary.textContent();

  // The default selection already carries the visible select border.
  expect(await countSelectBorders(page, '#hourly-pattern')).toBeGreaterThanOrEqual(1);

  // Tap two distinct columns: the readout follows the tapped hour.
  await tapChart(page, '#hourly-pattern', 0.3, 0.6);
  await expect(readoutPrimary).toHaveText(/^\d{2}:00–\d{2}:00$/);
  const firstTapText = await readoutPrimary.textContent();

  await tapChart(page, '#hourly-pattern', 0.8, 0.6);
  await expect(readoutPrimary).toHaveText(/^\d{2}:00–\d{2}:00$/);
  const secondTapText = await readoutPrimary.textContent();
  expect(secondTapText).not.toBe(firstTapText);
  expect(await countSelectBorders(page, '#hourly-pattern')).toBe(1);

  // No floating tooltip materialises on tap — the readout row (outside the
  // chart container) is the only surface carrying the values.
  await expect(page.locator('#hourly-pattern').getByText(/Average/)).toHaveCount(0);

  // A tap above the plot grid restores the default selection.
  await tapChart(page, '#hourly-pattern', 0.5, 0.02);
  await expect(readoutPrimary).toHaveText(defaultText ?? '');
});

test('usage day chart tap selects a column and empty tap restores the default', async ({ page }) => {
  await openUsageTab(page);
  await expect(page.locator('#usage-day-bars svg')).toBeVisible();

  const readoutPrimary = page.locator('#usage-day-readout .chart-readout__primary');
  await expect(readoutPrimary).toHaveText(/^\d{2}:\d{2}–\d{2}:\d{2}$/);
  const defaultText = await readoutPrimary.textContent();
  await expect(page.locator('#usage-day-readout .chart-readout__secondary')).toContainText('Measured');

  // Tap two distinct columns (test 1's pattern): the readout must move
  // between them, so a dead tap — both reads still showing the default —
  // cannot false-pass the format-only assertions. The usage-day plot band is
  // shorter than the other charts (legend + axis labels share the 160 px
  // card), so tap at 40% height to land inside the grid; a 0.6-fraction tap
  // lands below the plot and silently restores the default.
  await tapChart(page, '#usage-day-bars', 0.15, 0.4);
  await expect(readoutPrimary).toHaveText(/^\d{2}:\d{2}–\d{2}:\d{2}$/);
  const tappedText = await readoutPrimary.textContent();
  expect(await countSelectBorders(page, '#usage-day-bars')).toBeGreaterThanOrEqual(1);

  await tapChart(page, '#usage-day-bars', 0.8, 0.4);
  await expect(readoutPrimary).toHaveText(/^\d{2}:\d{2}–\d{2}:\d{2}$/);
  const secondTapText = await readoutPrimary.textContent();
  expect(secondTapText).not.toBe(tappedText);

  // Tap above the grid: back to the default (current hour on Today).
  await tapChart(page, '#usage-day-bars', 0.5, 0.01);
  await expect(readoutPrimary).toHaveText(defaultText ?? '');
});
