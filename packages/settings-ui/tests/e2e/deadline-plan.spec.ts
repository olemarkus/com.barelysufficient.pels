import { expect, test, type Locator, type Page } from './fixtures/test';
import type { DeferredObjectiveSettingsV1 } from '../../../contracts/src/deferredObjectiveSettings.ts';

type DeadlinePlanStubWindow = Window & {
  Homey: {
    __stub: {
      emitHomeyEvent: (event: string, ...args: unknown[]) => void;
      getApiCallCount: (key: string) => number;
      getSetting: (key: 'deferred_objectives') => DeferredObjectiveSettingsV1;
      setSetting: (key: 'deferred_objectives', value: DeferredObjectiveSettingsV1) => void;
    };
  };
};

// The deadline-plan view now lives as an in-page panel inside index.html, so
// queries must be scoped to `#deadline-plan-panel` — otherwise selectors like
// `.plan-hero__headline` collide with the Overview/Budget/Usage panels even
// when those are hidden.
const deadlinePanel = (page: Page): Locator => page.locator('#deadline-plan-panel');

const openDeadlinePlan = async (page: Page): Promise<Locator> => {
  await page.goto('/?page=deadline-plan&deviceId=dev_connected300', { waitUntil: 'domcontentloaded' });
  const panel = deadlinePanel(page);
  await expect(panel.locator('.plan-hero__headline')).toBeVisible();
  return panel;
};

const expectNoPageOverflow = async (page: Page) => {
  const overflow = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
    chartRight: document.querySelector('.deadline-horizon-chart svg')?.getBoundingClientRect().right ?? 0,
    cardRight: document.querySelector('.deadline-horizon-card')?.getBoundingClientRect().right ?? 0,
  }));
  expect(
    overflow.bodyScrollWidth,
    `Page should not overflow horizontally: ${JSON.stringify(overflow)}`,
  ).toBeLessThanOrEqual(overflow.viewportWidth + 1);
  expect(
    overflow.chartRight,
    `Horizon chart should stay inside the card: ${JSON.stringify(overflow)}`,
  ).toBeLessThanOrEqual(overflow.cardRight + 1);
};

test.describe('Deadline plan', () => {
  test('installs the Homey ready hook before loading homey.js', async ({ request }) => {
    const response = await request.get('/?page=deadline-plan');
    expect(response.ok()).toBeTruthy();
    const html = await response.text();
    const readyHookIndex = html.indexOf('window.__PELS_HOMEY_READY__');
    const homeyScriptIndex = html.indexOf('src="/homey.js"');

    expect(readyHookIndex).toBeGreaterThanOrEqual(0);
    expect(homeyScriptIndex).toBeGreaterThanOrEqual(0);
    expect(readyHookIndex).toBeLessThan(homeyScriptIndex);
  });

  test('renders the temperature deadline plan at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    const panel = await openDeadlinePlan(page);

    // Section eyebrow uses smart-task vocabulary, not planner-noun "plan".
    await expect(panel.locator('.plan-hero__section-label')).toHaveText(/Heating smart task/);
    // The device + target subline lives on the un-modified `.plan-hero__subline`
    // node (no `--reason` / `--muted` modifier). The headline-reason node now
    // renders above it for queued plans, so a positional `.first()` query is
    // not stable — match by class shape instead.
    const deviceTargetSubline = panel.locator(
      '.plan-hero__subline:not(.plan-hero__subline--reason):not(.plan-hero__subline--muted)',
    ).first();
    await expect(deviceTargetSubline).toContainText('Connected 300');
    await expect(deviceTargetSubline).toContainText('°C');
    await expect(panel.getByText('Price horizon', { exact: true })).toBeVisible();
    await expect(panel.getByLabel(/Smart task schedule/).getByText('Heating', { exact: true })).toBeVisible();
    await expect(panel.getByLabel(/Smart task schedule/).getByText('Original Heating', { exact: true })).toBeVisible();
    await expect(panel.getByLabel(/Smart task schedule/).getByText('Measured Heating', { exact: true })).toBeVisible();
    await expect(panel.getByLabel(/Smart task schedule/).getByText('Background usage', { exact: true })).toBeVisible();
    await expect(panel.getByLabel(/Smart task schedule/).getByText('Charging', { exact: true })).toHaveCount(0);
    await expect(panel.getByLabel(/Smart task schedule/).getByText('Measured Charging', { exact: true })).toHaveCount(0);
    await expect(panel.locator('.deadline-horizon-chart svg')).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('keeps the surface contained at 480px', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 900 });
    const panel = await openDeadlinePlan(page);

    await expect(panel.getByLabel(/Smart task schedule/)).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('shows the temperature kind chip without duplicates and without the high-confidence chip', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 860 });
    const panel = await openDeadlinePlan(page);

    await expect(panel.locator('.plan-chip', { hasText: 'Temperature' })).toBeVisible();
    // High-confidence learned profile no longer surfaces a Confidence chip —
    // suppressed by `resolveConfidenceChipText` to keep the chip row clean.
    await expect(panel.locator('.plan-chip', { hasText: /Confidence/ })).toHaveCount(0);
    const chipTexts = await panel.locator('.plan-chip').allTextContents();
    expect(new Set(chipTexts).size).toBe(chipTexts.length);
  });

  test('falls back to bootstrap prices when the refresh price call fails', async ({ page }) => {
    await page.addInitScript(() => {
      (window as typeof window & { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
        apiHandlers: {
          'GET /ui_prices': () => {
            throw new Error('Price refresh unavailable');
          },
        },
      };
    });
    await page.setViewportSize({ width: 390, height: 860 });
    const panel = await openDeadlinePlan(page);

    await expect(panel.getByText('Price horizon', { exact: true })).toBeVisible();
    await expect(panel.locator('.deadline-horizon-chart svg')).toBeVisible();
  });

  test('refreshes the open page when plan and device events arrive', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 860 });
    const panel = await openDeadlinePlan(page);
    // Match the device/target subline (no class modifier) so the new
    // headline-reason subline above it doesn't shift `.first()` underneath us.
    const deviceTargetSubline = panel.locator(
      '.plan-hero__subline:not(.plan-hero__subline--reason):not(.plan-hero__subline--muted)',
    ).first();
    await expect(deviceTargetSubline).toContainText('Target 65 °C');

    const initialBootstrapCalls = await page.evaluate(() => (
      (window as unknown as DeadlinePlanStubWindow).Homey.__stub.getApiCallCount('GET /ui_bootstrap')
    ));

    await page.evaluate(() => {
      const homey = (window as unknown as DeadlinePlanStubWindow).Homey;
      const current = homey.__stub.getSetting('deferred_objectives');
      const objective = current.objectivesByDeviceId.dev_connected300;
      if (!objective || objective.kind !== 'temperature') {
        throw new Error('Expected Connected 300 temperature objective in Homey stub');
      }
      homey.__stub.setSetting('deferred_objectives', {
        ...current,
        objectivesByDeviceId: {
          ...current.objectivesByDeviceId,
          dev_connected300: {
            ...objective,
            targetTemperatureC: 70,
          },
        },
      });
      homey.__stub.emitHomeyEvent('plan_updated', { plan: null });
      homey.__stub.emitHomeyEvent('devices_updated');
    });

    await expect(deviceTargetSubline).toContainText('Target 70 °C');
    const refreshedBootstrapCalls = await page.evaluate(() => (
      (window as unknown as DeadlinePlanStubWindow).Homey.__stub.getApiCallCount('GET /ui_bootstrap')
    ));
    expect(refreshedBootstrapCalls).toBe(initialBootstrapCalls + 1);
  });

  // TODO 628: ECharts auto-sizes bars per grid, so the price grid (1 bar
  // series) and load grid (2–4 bar series) used to publish bars whose centres
  // drifted apart at narrow widths. The fix pins `barWidth` + `barCategoryGap`
  // on every bar series so the layout stays grid-agnostic. The view writes
  // each grid's hour centres to `data-test-bar-centres` after the chart
  // renders so this spec can verify alignment by comparing the two arrays
  // hour-by-hour, without parsing SVG path geometry.
  for (const width of [320, 480] as const) {
    test(`load and price bars line up by hour at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const panel = await openDeadlinePlan(page);
      const chart = panel.locator('.deadline-horizon-chart');
      await expect(chart).toBeVisible();
      // Wait until the chart has settled to the real viewport width — the
      // cold-mount path resizes once on the next frame and the centres
      // attribute refreshes on every resize.
      await page.waitForFunction(() => {
        const node = document.querySelector('.deadline-horizon-chart');
        if (!(node instanceof HTMLElement)) return false;
        const raw = node.getAttribute('data-test-bar-centres');
        if (!raw) return false;
        try {
          const parsed = JSON.parse(raw) as { price: number[]; load: number[] };
          return parsed.price.length > 0
            && parsed.price.length === parsed.load.length;
        } catch {
          return false;
        }
      });

      const centres = await chart.evaluate((node) => {
        const raw = node.getAttribute('data-test-bar-centres') ?? '{}';
        return JSON.parse(raw) as { price: number[]; load: number[] };
      });

      expect(centres.price.length).toBeGreaterThan(0);
      expect(centres.price.length).toBe(centres.load.length);
      // Every price bar's centre must align with the corresponding load bar's
      // centre — they share the same xAxis categories, so the values should
      // be identical to the floating-point rounding that `convertToPixel`
      // produces. 1 px tolerance covers any sub-pixel drift between the two
      // grid coord-sys resolutions.
      const offending = centres.price.flatMap((x, i) => {
        const loadX = centres.load[i];
        if (loadX === undefined) return [{ index: i, price: x, load: null, dx: null }];
        const dx = Math.abs(x - loadX);
        return dx <= 1 ? [] : [{ index: i, price: x, load: loadX, dx }];
      });
      expect(offending, `Bar centres drift at ${width}px: ${JSON.stringify(offending)}`).toEqual([]);
    });
  }

  test('shows the error state when the device has no objective', async ({ page }) => {
    await page.addInitScript(() => {
      (window as typeof window & { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
        settings: {
          deferred_objectives: { version: 1, objectivesByDeviceId: {} },
        },
      };
    });
    await page.goto('/?page=deadline-plan&deviceId=dev_connected300', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: 'Smart task unavailable' })).toBeVisible();
    await expect(page.getByText('Smart task data is not available for this device.')).toBeVisible();
  });

  // Regression: clicking a smart-task chip on an Overview device card used to
  // leave the "Overview" tab marked as selected even though the plan-detail
  // panel had taken over. The router now keeps the shell-nav visible and
  // lights up "Smart tasks" so the user keeps the breadcrumb. (TODO ~line 2308)
  test.describe('Tab indicator follows the deep-link', () => {
    const overviewTab = (page: Page): Locator => page.getByRole('tab', { name: 'Overview' });
    const smartTasksTab = (page: Page): Locator => page.getByRole('tab', { name: 'Smart tasks' });

    test('clicking the Overview smart-task chip lights the Smart tasks tab', async ({ page }) => {
      await page.setViewportSize({ width: 480, height: 900 });
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('#overview-panel')).toBeVisible();
      await expect(overviewTab(page)).toHaveAttribute('aria-selected', 'true');
      await expect(smartTasksTab(page)).toHaveAttribute('aria-selected', 'false');

      // Plant a sentinel that only survives an in-place SPA transition. A full
      // document navigation (the regression) reloads index.html and wipes it.
      // This guards the real-WebView failure mode: the chip's own
      // `stopPropagation` (to suppress the parent card's activation) must not
      // also stop the router's capture-phase interceptor, or the `<a href>`
      // full-navigates and the Homey mobile WebView never re-injects the SDK —
      // every API call stalls and the deep-linked page hangs on "Loading".
      await page.evaluate(() => {
        (window as unknown as { __SPA_SENTINEL__?: boolean }).__SPA_SENTINEL__ = true;
      });

      // The Overview surface renders one chip per device with an active smart
      // task; the dev_connected300 temperature objective is enabled in the
      // stub bootstrap so the chip is present without any extra patching.
      const chip = page.locator('#overview-panel a.plan-chip--link[aria-label*="Smart task"]').first();
      await expect(chip).toBeVisible();
      await chip.click();

      const panel = deadlinePanel(page);
      await expect(panel).toBeVisible();
      await expect(panel.locator('.plan-hero__headline')).toBeVisible();
      const spaSurvived = await page.evaluate(
        () => (window as unknown as { __SPA_SENTINEL__?: boolean }).__SPA_SENTINEL__ === true,
      );
      expect(
        spaSurvived,
        'chip click must route in-place (pushState); a wiped sentinel means a full document navigation that hangs the real WebView',
      ).toBe(true);
      // Breadcrumb follows the deep-link: Smart tasks lit, Overview cleared,
      // shell-nav still visible (not hidden) so the user can pivot tabs.
      await expect(page.locator('#shell-nav')).toBeVisible();
      await expect(smartTasksTab(page)).toHaveAttribute('aria-selected', 'true');
      await expect(overviewTab(page)).toHaveAttribute('aria-selected', 'false');
    });

    test('direct URL into plan-detail lands on the Smart tasks tab', async ({ page }) => {
      await page.setViewportSize({ width: 480, height: 900 });
      const panel = await openDeadlinePlan(page);
      await expect(panel).toBeVisible();
      await expect(page.locator('#shell-nav')).toBeVisible();
      await expect(smartTasksTab(page)).toHaveAttribute('aria-selected', 'true');
      await expect(overviewTab(page)).toHaveAttribute('aria-selected', 'false');
    });

    test('clicking a different shell-nav tab from plan-detail clears the deep-link URL', async ({ page }) => {
      await page.setViewportSize({ width: 480, height: 900 });
      await openDeadlinePlan(page);

      await page.getByRole('tab', { name: 'Budget' }).click();
      await expect(page.locator('#budget-panel')).toBeVisible();
      await expect(deadlinePanel(page)).toBeHidden();
      // URL should be reset so a reload doesn't re-open the closed plan.
      await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBeNull();
      await expect(page.getByRole('tab', { name: 'Budget' })).toHaveAttribute('aria-selected', 'true');
    });
  });
});
