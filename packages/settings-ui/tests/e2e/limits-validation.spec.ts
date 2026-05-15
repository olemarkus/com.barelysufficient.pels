import { expect, test, type Page } from './fixtures/test';

const openLimitsAndSafety = async (page: Page) => {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('[data-settings-target="limits"]').click();
  await expect(page.locator('#limits-panel')).toBeVisible();
};

const setNumericFieldValue = async (page: Page, selector: string, value: string) => {
  await page.locator(selector).evaluate((el, nextValue) => {
    const target = el as HTMLElement & { value: string };
    target.value = nextValue;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
};

test.describe('Limits & safety inline validation', () => {
  test('shows an inline alert when safety margin meets or exceeds the hard cap', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openLimitsAndSafety(page);

    const alert = page.locator('#settings-capacity-margin-alert');
    await expect(alert).toBeHidden();

    // Set hard cap to 8 kW, safety margin to 10 kW.
    await page.locator('#settings-capacity-limit').evaluate((el) => {
      (el as HTMLElement & { value: string }).value = '8';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.locator('#settings-capacity-margin').evaluate((el) => {
      (el as HTMLElement & { value: string }).value = '10';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Safety margin must be less than the hard cap');

    // Dial the margin back below the cap; the alert hides again.
    await page.locator('#settings-capacity-margin').evaluate((el) => {
      (el as HTMLElement & { value: string }).value = '0.5';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(alert).toBeHidden();
  });

  test('blocks the persisted save when the margin would equal or exceed the hard cap', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await openLimitsAndSafety(page);

    // Seed a known-good baseline so we can detect mutation.
    await page.evaluate(() => {
      const stub = (window as any).Homey.__stub;
      stub.setSetting('capacity_limit_kw', 8);
      stub.setSetting('capacity_margin_kw', 0.5);
    });

    // Try saving an invalid pair via the change event (auto-save trigger).
    await setNumericFieldValue(page, '#settings-capacity-margin', '10');

    const alert = page.locator('#settings-capacity-margin-alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Safety margin must be less than the hard cap');

    // The persisted margin must not have moved.
    const persistedMargin = await page.evaluate(() => new Promise<unknown>((resolve, reject) => {
      (window as any).Homey.get('capacity_margin_kw', (error: Error | null, value?: unknown) => {
        if (error) reject(error);
        else resolve(value);
      });
    }));
    expect(persistedMargin).toBe(0.5);
  });
});
