import { expect, test, type Page } from './fixtures/test';

const openDeadlinePlan = async (page: Page) => {
  await page.goto('/deadline-plan.html?deviceId=dev_connected300', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.plan-hero__headline')).toBeVisible();
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
    const response = await request.get('/deadline-plan.html');
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
    await openDeadlinePlan(page);

    await expect(page.locator('.plan-hero__section-label')).toHaveText(/Temperature plan/);
    await expect(page.locator('.plan-hero__subline').first()).toContainText('Connected 300');
    await expect(page.locator('.plan-hero__subline').first()).toContainText('°C');
    await expect(page.getByText('Price horizon', { exact: true })).toBeVisible();
    await expect(page.getByLabel(/Deadline plan/).getByText('Heating', { exact: true })).toBeVisible();
    await expect(page.getByLabel(/Deadline plan/).getByText('Background usage', { exact: true })).toBeVisible();
    await expect(page.getByLabel(/Deadline plan/).getByText('Charging', { exact: true })).toHaveCount(0);
    await expect(page.locator('.deadline-horizon-chart svg')).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('keeps the surface contained at 480px', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 900 });
    await openDeadlinePlan(page);

    await expect(page.getByLabel(/Deadline plan/)).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('shows the temperature kind chip and confidence chip without duplicates', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 860 });
    await openDeadlinePlan(page);

    await expect(page.locator('.plan-chip', { hasText: 'Temperature' })).toBeVisible();
    await expect(page.locator('.plan-chip', { hasText: 'Confidence high' })).toBeVisible();
    const chipTexts = await page.locator('.plan-chip').allTextContents();
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
    await openDeadlinePlan(page);

    await expect(page.getByText('Price horizon', { exact: true })).toBeVisible();
    await expect(page.locator('.deadline-horizon-chart svg')).toBeVisible();
  });

  test('shows the error state when the device has no objective', async ({ page }) => {
    await page.addInitScript(() => {
      (window as typeof window & { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
        settings: {
          deferred_objectives: { version: 1, objectivesByDeviceId: {} },
        },
      };
    });
    await page.goto('/deadline-plan.html?deviceId=dev_connected300', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: 'Deadline plan unavailable' })).toBeVisible();
    await expect(page.getByText('Deadline plan data is not available for this device.')).toBeVisible();
  });
});
