import { expect, test, type Page } from './fixtures/test';

const openMockup = async (page: Page, scenario?: string) => {
  const suffix = scenario ? `?scenario=${scenario}` : '';
  await page.goto(`/deadline-plan-mockup.html${suffix}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.plan-hero__headline')).toBeVisible();
};

const expectNoPageOverflow = async (page: Page) => {
  const overflow = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
    lastAxisRight: document.querySelector('.deadline-horizon__axis span:last-child')?.getBoundingClientRect().right ?? 0,
    horizonRight: document.querySelector('.deadline-horizon')?.getBoundingClientRect().right ?? 0,
  }));
  expect(
    overflow.bodyScrollWidth,
    `Page should not overflow horizontally: ${JSON.stringify(overflow)}`,
  ).toBeLessThanOrEqual(overflow.viewportWidth + 1);
  expect(
    overflow.lastAxisRight,
    `Horizon axis should stay inside the card: ${JSON.stringify(overflow)}`,
  ).toBeLessThanOrEqual(overflow.horizonRight + 1);
};

test.describe('Deadline plan mockup', () => {
  test('installs the Homey ready hook before loading homey.js', async ({ request }) => {
    const response = await request.get('/deadline-plan-mockup.html');
    expect(response.ok()).toBeTruthy();
    const html = await response.text();
    const readyHookIndex = html.indexOf('window.__PELS_HOMEY_READY__');
    const homeyScriptIndex = html.indexOf('src="/homey.js"');

    expect(readyHookIndex).toBeGreaterThanOrEqual(0);
    expect(homeyScriptIndex).toBeGreaterThanOrEqual(0);
    expect(readyHookIndex).toBeLessThan(homeyScriptIndex);
  });

  test('shows the EV deadline plan layers at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await openMockup(page);

    await expect(page.getByText('Use 5 cheap hours and keep 2 fallback hours')).toBeVisible();
    await expect(page.getByText('Known-price horizon')).toBeVisible();
    await expect(page.getByLabel(/Hourly charging plan/).getByText('Planned load', { exact: true })).toBeVisible();
    await expect(page.getByLabel(/Hourly charging plan/).getByText('Charging plan', { exact: true })).toBeVisible();
    await expect(page.getByText('Other load', { exact: true })).toBeVisible();
    await expect(page.getByText('Charger', { exact: true })).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('keeps the mockup contained at 480px', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 900 });
    await openMockup(page);

    await expect(page.getByLabel(/Known-price horizon/)).toBeVisible();
    await expect(page.getByText('Fallback hours', { exact: true })).toHaveCount(0);
    await expect(page.getByText('What the plan assumes', { exact: true })).toHaveCount(0);
    await expectNoPageOverflow(page);
  });

  test('renders the priority 1 capacity-off scenario from mocked Homey state', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 860 });
    await openMockup(page, 'priority1-cap-off');

    await expect(page.locator('.plan-chip', { hasText: 'Priority 1' })).toBeVisible();
    await expect(page.locator('.plan-chip', { hasText: 'Power-limit off' })).toBeVisible();
    await expect(page.getByText('Known prices until target 08:00')).toBeVisible();
    await expect(page.getByText('The objective targets 08:00. Fallback hours are reserves before the target, not guaranteed charging.')).toBeVisible();
    await expect(page.locator('.deadline-horizon-price[data-marker]')).toHaveCount(0);
    await expect(page.locator('.deadline-horizon-price[data-deadline]')).toHaveCount(0);
    await expect(page.locator('.deadline-horizon__axis span').last()).toHaveText('08');
    await expectNoPageOverflow(page);
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
    await openMockup(page, 'priority1-cap-off');

    await expect(page.getByText('Known-price horizon')).toBeVisible();
    await expect(page.locator('.deadline-horizon-price')).toHaveCount(20);
  });

  test('shows the controlled error state for malformed preview data', async ({ page }) => {
    await page.addInitScript(() => {
      (window as typeof window & { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
        settings: {
          deferred_objective_preview: {
            timeline: { hours: [] },
          },
        },
      };
    });
    await page.goto('/deadline-plan-mockup.html', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: 'Deadline plan unavailable' })).toBeVisible();
    await expect(page.getByText('Deadline plan data is not available.')).toBeVisible();
  });
});
