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

test('heatmap cell tap drives the pinned readout between distinct cells', async ({ page }) => {
  await openUsageTab(page);

  // The heatmap lives in the collapsed "Detailed hourly view" section.
  await page.locator('#usage-detail-section summary').click();
  await expect(page.locator('#power-list svg')).toBeVisible();

  // Navigate to the previous week: the stub seeds 14 days of hourly buckets,
  // so every cell of the previous week has data — taps cannot silently land
  // on an empty cell (the dead-tap trap: both reads showing the default would
  // false-pass format-only assertions).
  await page.locator('#power-week-prev').click();
  await expect(page.locator('#power-list svg')).toBeVisible();

  // Default selection (most recent cell with data) — the row is never empty.
  const readoutPrimary = page.locator('#power-week-readout .chart-readout__primary');
  await expect(readoutPrimary).toHaveText(/ · \d{2}:00–\d{2}:00$/);
  const defaultText = await readoutPrimary.textContent();
  await expect(page.locator('#power-week-readout .chart-readout__secondary')).toContainText('kWh');

  // Tap two distinct cells (different day column AND hour row): the readout
  // must move between them, and exactly ONE cell carries the select ring.
  // ECharts keys select state by item name, and unnamed heatmap items fall
  // back to a per-column key — a regression here rings the entire 24-cell
  // day column, so the count must be exact, not `>= 1`.
  await tapChart(page, '#power-list', 0.25, 0.3);
  await expect(readoutPrimary).toHaveText(/ · \d{2}:00–\d{2}:00$/);
  const firstTapText = await readoutPrimary.textContent();
  // The first tap must move OFF the default too — a missed first tap with a
  // landed second tap would otherwise still pass the inequality below.
  expect(firstTapText).not.toBe(defaultText);
  expect(await countSelectBorders(page, '#power-list')).toBe(1);

  await tapChart(page, '#power-list', 0.55, 0.7);
  await expect(readoutPrimary).toHaveText(/ · \d{2}:00–\d{2}:00$/);
  const secondTapText = await readoutPrimary.textContent();
  expect(secondTapText).not.toBe(firstTapText);
  expect(await countSelectBorders(page, '#power-list')).toBe(1);

  // A tap above the plot grid restores the default selection — and leaves no
  // stale ring on the previously tapped cell next to the default's ring.
  await tapChart(page, '#power-list', 0.5, 0.005);
  await expect(readoutPrimary).toHaveText(defaultText ?? '');
  expect(await countSelectBorders(page, '#power-list')).toBe(1);
});

const openBudgetTab = async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('tablist')).toBeVisible();
  await page.getByRole('tab', { name: 'Budget' }).click();
  await expect(page.locator('#budget-panel')).toBeVisible();
  await expect(page.locator('#budget-redesign-chart svg')).toBeVisible();
};

// Selection visuals painted in the on-surface tone (`--text`), each narrowed
// by its structural signal so chart chrome that merely shares the tone (axis
// lines, labels-as-paths) cannot satisfy the count:
// - `hourly-border`: the bars' select border stroke ALSO carries the
//   configured `borderWidth: 2` (see `buildHourlyOption`'s `select` style).
// - `progress-marker`: the marker scatter symbol fill ALSO carries the
//   `symbolSize: 9` geometry. Counts BOTH `path` and `circle` elements — the
//   ECharts SVG renderer has emitted circle symbols as either across
//   versions (currently a unit-arc `path` scaled via a `matrix(4.5,…)`
//   transform), so the size is gated on the rendered bounding box (~9px)
//   rather than on any renderer-specific radius attribute.
const countSelectionToneShapes = (page: Page, probe: 'hourly-border' | 'progress-marker') => (
  page.evaluate((probeKind) => {
    const panel = document.querySelector('#budget-panel');
    const svg = document.querySelector('#budget-redesign-chart svg');
    if (!(panel instanceof HTMLElement) || !svg) return -1;
    const tone = getComputedStyle(panel).getPropertyValue('--text').trim().toLowerCase();
    if (!tone) return -1;
    if (probeKind === 'hourly-border') {
      return [...svg.querySelectorAll('path')].filter((shape) => (
        (shape.getAttribute('stroke') ?? '').trim().toLowerCase() === tone
          && shape.getAttribute('stroke-width') === '2'
      )).length;
    }
    return [...svg.querySelectorAll('path, circle')].filter((shape) => {
      if ((shape.getAttribute('fill') ?? '').trim().toLowerCase() !== tone) return false;
      const box = shape.getBoundingClientRect();
      return Math.abs(box.width - 9) <= 1.5 && Math.abs(box.height - 9) <= 1.5;
    }).length;
  }, probe)
);

test('budget chart drives the readout in both modes and stays coherent across the toggle', async ({ page }) => {
  await openBudgetTab(page);

  const readoutPrimary = page.locator('#budget-redesign-chart-readout .chart-readout__primary');
  const readoutSecondary = page.locator('#budget-redesign-chart-readout .chart-readout__secondary');

  // Progress mode (default view): the row is never empty — the default
  // selection (current hour on Today) renders cumulative figures, and the
  // single-symbol marker series carries the visible selection identity
  // (native select is invisible on the line series).
  await expect(readoutPrimary).toHaveText(/^By \d{2}:\d{2}$/);
  await expect(readoutSecondary).toContainText('Budget');
  expect(await countSelectionToneShapes(page, 'progress-marker')).toBeGreaterThanOrEqual(1);

  // Two taps on distinct columns must move the readout — a dead tap (both
  // reads still showing the default) cannot false-pass format-only asserts.
  await tapChart(page, '#budget-redesign-chart', 0.3, 0.45);
  await expect(readoutPrimary).toHaveText(/^By \d{2}:\d{2}$/);
  const progressFirstTap = await readoutPrimary.textContent();
  await tapChart(page, '#budget-redesign-chart', 0.75, 0.45);
  await expect(readoutPrimary).toHaveText(/^By \d{2}:\d{2}$/);
  const progressSecondTap = await readoutPrimary.textContent();
  expect(progressSecondTap).not.toBe(progressFirstTap);

  // No floating tooltip materialises on tap — the pinned row is the only
  // caption surface on touch. Probe for `Projection`: it appears only in the
  // floating structured-readout tooltip, never as permanent chart text (the
  // end-stop markPoint label is `Budget N kWh`, so `/Budget/` would always match).
  await expect(page.locator('#budget-redesign-chart').getByText(/Projection/)).toHaveCount(0);

  // Mode toggle: the selection survives and re-resolves into the hourly
  // grammar — the selected hour's end is the same boundary the progress
  // readout just named ("By 18:00" → "17:00–18:00").
  const selectedEnd = (progressSecondTap ?? '').replace(/^By /, '');
  await page.locator('#budget-panel .segmented__option').filter({ hasText: 'Hourly plan' }).click();
  await expect(page.locator('#budget-redesign-chart svg')).toBeVisible();
  await expect(readoutPrimary).toHaveText(new RegExp(`^\\d{2}:\\d{2}–${selectedEnd}$`));
  await expect(readoutSecondary).toContainText('Budget');

  // Surface the hourly-mode DEFAULT selection (current hour) before the
  // in-grid taps: an outside tap restores it, and capturing its exact text
  // lets the final restore assert full equality (the Usage-tab tests'
  // pattern) — a format-only check would pass even if the restore landed on
  // the wrong column.
  await tapChart(page, '#budget-redesign-chart', 0.5, 0.02);
  await expect(readoutPrimary).toHaveText(/^\d{2}:\d{2}–\d{2}:\d{2}$/);
  const hourlyDefaultText = await readoutPrimary.textContent();

  // Hourly mode taps: the readout follows, and the tapped column carries the
  // on-surface select border on its stacked bar segments.
  await tapChart(page, '#budget-redesign-chart', 0.3, 0.45);
  await expect(readoutPrimary).toHaveText(/^\d{2}:\d{2}–\d{2}:\d{2}$/);
  const hourlyFirstTap = await readoutPrimary.textContent();
  await tapChart(page, '#budget-redesign-chart', 0.6, 0.45);
  await expect(readoutPrimary).toHaveText(/^\d{2}:\d{2}–\d{2}:\d{2}$/);
  expect(await readoutPrimary.textContent()).not.toBe(hourlyFirstTap);
  expect(await countSelectionToneShapes(page, 'hourly-border')).toBeGreaterThanOrEqual(1);

  // A tap above the plot grid restores the default selection (current hour)
  // — the exact text captured above, not merely something hour-shaped.
  await tapChart(page, '#budget-redesign-chart', 0.5, 0.02);
  await expect(readoutPrimary).toHaveText(hourlyDefaultText ?? '');

  // The readout host stays within the panel width (320 px project included).
  const overflow = await page.evaluate(() => {
    const host = document.querySelector('#budget-redesign-chart-readout');
    if (!(host instanceof HTMLElement)) return null;
    const rect = host.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewport: window.innerWidth };
  });
  expect(overflow).not.toBeNull();
  if (!overflow) return;
  expect(overflow.left).toBeGreaterThanOrEqual(-1);
  expect(overflow.right).toBeLessThanOrEqual(overflow.viewport + 1);
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
