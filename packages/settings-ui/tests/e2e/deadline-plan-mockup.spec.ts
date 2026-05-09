import { expect, test, type Page } from './fixtures/test';

const openMockup = async (page: Page, scenario?: string) => {
  const suffix = scenario ? `?scenario=${scenario}` : '';
  const joiner = suffix ? `${suffix}&` : '?';
  await page.goto(`/deadline-plan.html${joiner}deviceId=dev_connected300`, { waitUntil: 'domcontentloaded' });
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

test.describe('Deadline plan mockup', () => {
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

  test('shows the EV deadline plan layers at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await openMockup(page);

    await expect(page.getByText(/Target 65\.0 °C/)).toBeVisible();
    await expect(page.getByText('Known-price horizon')).toBeVisible();
    await expect(page.getByLabel(/Deadline plan/).getByText('Planned', { exact: true })).toBeVisible();
    await expect(page.getByLabel(/Deadline plan/).getByText('Charging', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Other load', { exact: true })).toBeVisible();
    await expect(page.getByText('This device', { exact: true })).toBeVisible();
    await expect(page.locator('.deadline-horizon-chart svg')).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('keeps the mockup contained at 480px', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 900 });
    await openMockup(page);

    await expect(page.getByLabel(/Deadline plan/)).toBeVisible();
    await expect(page.getByText('Fallback hours', { exact: true })).toHaveCount(0);
    await expect(page.getByText('What the plan assumes', { exact: true })).toHaveCount(0);
    await expectNoPageOverflow(page);
  });

  test('renders the priority 1 capacity-off scenario from mocked Homey state', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 860 });
    await openMockup(page, 'priority1-cap-off');

    await expect(page.locator('.plan-chip', { hasText: 'Temperature' })).toBeVisible();
    await expect(page.locator('.plan-chip', { hasText: 'Confidence high' })).toBeVisible();
    await expect(page.getByText(/Known prices until/)).toBeVisible();
    await expect(page.getByText(/This view stops at the deadline/)).toBeVisible();
    await expect(page.getByLabel(/Deadline plan/).getByText(/kWh/).first()).toBeVisible();
    await expect(page.locator('.deadline-horizon-chart svg')).toBeVisible();
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
    await expect(page.locator('.deadline-horizon-chart svg')).toBeVisible();
  });

  test('shows the controlled error state when the device has no objective', async ({ page }) => {
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
