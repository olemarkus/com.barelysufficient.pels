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
    chartRight: document.querySelector('.deadline-schedule-chart svg')?.getBoundingClientRect().right ?? 0,
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
    // Question-shaped card titles replace the old "Price horizon" heading +
    // 5-entry legend (the legend and its series were deleted with the
    // two-chart split).
    await expect(panel.getByText('When will it run, and at what price?', { exact: true })).toBeVisible();
    await expect(panel.getByText('Will it reach 65.0 °C in time?', { exact: true })).toBeVisible();
    // Kind verb lives in the planned-band markArea label inside the chart —
    // temperature must say Heating and never Charging.
    await expect(panel.getByLabel(/Smart task schedule/).getByText('Heating', { exact: true })).toBeVisible();
    await expect(panel.getByLabel(/Smart task schedule/).getByText('Charging', { exact: true })).toHaveCount(0);
    await expect(panel.locator('.deadline-schedule-chart svg')).toBeVisible();
    await expect(panel.locator('.deadline-trajectory-chart svg')).toBeVisible();
    // Trajectory stateline answers the card's question in one sentence.
    await expect(panel.locator('.deadline-stateline')).toBeVisible();
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

    await expect(panel.getByText('When will it run, and at what price?', { exact: true })).toBeVisible();
    await expect(panel.locator('.deadline-schedule-chart svg')).toBeVisible();
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

  // Pinned readout row: the default selection is the current ("Now") hour,
  // and the stub's latest revision drops the current hour from the plan
  // (prices_revised), so the default readout exercises the idle-now copy
  // contract (never claim "Heating" while the hero says it starts later).
  // At rest the secondary line is the scrub hint — gesture discoverability
  // wins over the Now hour's revision narrative, which surfaces once the
  // user actively selects an hour (including re-selecting Now).
  test('pinned readout defaults to the idle Now hour with the scrub hint', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 860 });
    const panel = await openDeadlinePlan(page);
    const readout = panel.locator('.deadline-readout__primary');
    await expect(readout).toHaveText(/^Now · \d+\.\d{2} (kr|øre)\/kWh · Idle — heating starts \d{2}:\d{2}$/);
    const secondary = panel.locator('.deadline-readout__secondary');
    await expect(secondary).toHaveText('Drag across the chart to read any hour');

    // Actively selecting the Now hour (press at the far-left plot column)
    // surfaces the changed-hour revision reason the default state withheld.
    const chart = panel.locator('.deadline-schedule-chart');
    await expect(chart.locator('svg')).toBeVisible();
    const box = await chart.boundingBox();
    if (!box) throw new Error('schedule chart has no bounding box');
    await page.mouse.move(box.x + box.width * 0.08, box.y + box.height * 0.55);
    await page.mouse.down();
    await expect(readout).toHaveText(/^Now · /);
    await expect(secondary).toHaveText('Updated as new prices arrived');
    await page.mouse.up();
  });

  // Danger state: the under-booked stub plan (needs 35 kWh, books 12) keeps
  // the projected staircase short of the target, so the trajectory card must
  // answer its question with the danger stateline and the time-stamped (red)
  // deadline marker. No explicit viewport — runs at each project's width so
  // the narrow project covers 320 px.
  test('under-booked plan renders the cannot-finish stateline and danger deadline', async ({ page }) => {
    await page.addInitScript(() => {
      (window as typeof window & { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
        deadlinePlanUnderBooked: true,
      };
    });
    await page.goto('/?page=deadline-plan&deviceId=dev_connected300', { waitUntil: 'domcontentloaded' });
    const panel = deadlinePanel(page);
    // The cannot-finish hero suppresses the headline (chip + body carry the
    // verdict), so wait on the trajectory surface instead of openDeadlinePlan.
    await expect(panel.locator('.deadline-trajectory-chart svg')).toBeVisible();
    const stateline = panel.locator('.deadline-stateline');
    await expect(stateline).toHaveClass(/deadline-stateline--danger/);
    await expect(stateline).toHaveText(/^Projected \d+(\.\d+)? °C at the deadline · \d+(\.\d+)? °C short$/);
    // Danger deadline marker carries the clock time (the on-track variant is
    // the bare word) — user-visible text inside the chart SVG.
    const svgText = await panel.locator('.deadline-trajectory-chart svg').evaluate((svg) => svg.textContent ?? '');
    expect(svgText).toMatch(/deadline \d{2}:\d{2}/);
  });

  for (const width of [320, 480] as const) {
    test(`scrubbing the schedule chart drives the pinned readout at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const panel = await openDeadlinePlan(page);
      const readout = panel.locator('.deadline-readout__primary');
      await expect(readout).toHaveText(/^Now · /);

      const chart = panel.locator('.deadline-schedule-chart');
      await expect(chart.locator('svg')).toBeVisible();
      const box = await chart.boundingBox();
      if (!box) throw new Error('schedule chart has no bounding box');
      // Press in the middle of the plot area and drag right — the readout
      // snaps to hour columns under the pointer (individual bars are too
      // thin to tap at 320px; drag-scrub is the contract).
      await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.55);
      await page.mouse.down();
      await expect(readout).toHaveText(/^\d{2}:\d{2} · \d+\.\d{2} (kr|øre)\/kWh · /);
      const midScrubText = await readout.textContent();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.55);
      await expect(readout).toHaveText(/^\d{2}:\d{2} · /);
      const lateScrubText = await readout.textContent();
      expect(lateScrubText).not.toBe(midScrubText);
      await page.mouse.up();

      // A tap outside the plot area (top-left chart padding) restores the
      // default Now selection.
      await page.mouse.click(box.x + 2, box.y + 2);
      await expect(readout).toHaveText(/^Now · /);
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
