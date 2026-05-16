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
    await expect(panel.locator('.plan-hero__subline').first()).toContainText('Connected 300');
    await expect(panel.locator('.plan-hero__subline').first()).toContainText('°C');
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
    await expect(panel.locator('.plan-hero__subline').first()).toContainText('Target 65 °C');

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

    await expect(panel.locator('.plan-hero__subline').first()).toContainText('Target 70 °C');
    const refreshedBootstrapCalls = await page.evaluate(() => (
      (window as unknown as DeadlinePlanStubWindow).Homey.__stub.getApiCallCount('GET /ui_bootstrap')
    ));
    expect(refreshedBootstrapCalls).toBe(initialBootstrapCalls + 1);
  });

  test('shows the error state when the device has no objective', async ({ page }) => {
    await page.addInitScript(() => {
      (window as typeof window & { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
        settings: {
          deferred_objectives: { version: 1, objectivesByDeviceId: {} },
        },
      };
    });
    await page.goto('/?page=deadline-plan&deviceId=dev_connected300', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: 'Smart task plan unavailable' })).toBeVisible();
    await expect(page.getByText('Smart task plan data is not available for this device.')).toBeVisible();
  });
});
