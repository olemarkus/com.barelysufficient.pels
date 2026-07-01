import { expect, test, type Page } from './fixtures/test';
import { readMdSwitchSelected, readMdValue, setMdSwitch, setMdValue } from './fixtures/materialWeb';

// Export (feed-in) price settings + the Budget tab's "Export price now"
// subline. The default stub home has a managed solar device
// (`hasManagedSolarDevice: true` in the /ui_devices payload), so the
// prosumer-gated export section is visible; export pricing itself defaults
// off. Tests that need an enabled config seed the same settings keys the
// runtime reads (`export_price_enabled` / `export_spot_factor` /
// `export_fixed`) via `__PELS_HOMEY_STUB__.settings`, and the stub mirrors the
// producer's export math (lib/price/exportPrice.ts) onto `combined_prices`.

const seedStubSettings = async (page: Page, settings: Record<string, unknown>) => {
  await page.addInitScript((seeded) => {
    const win = window as unknown as { __PELS_HOMEY_STUB__?: Record<string, unknown> };
    const existing = win.__PELS_HOMEY_STUB__ ?? {};
    const existingSettings = (existing.settings as Record<string, unknown> | undefined) ?? {};
    win.__PELS_HOMEY_STUB__ = { ...existing, settings: { ...existingSettings, ...seeded } };
  }, settings);
};

const openElectricityPrices = async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('.settings-nav-card[data-settings-target="electricity-prices"]').click();
  await expect(page.locator('#electricity-prices-panel')).toBeVisible();
};

const readHomeySetting = async <T,>(page: Page, key: string): Promise<T> => page.evaluate(
  (settingKey) => new Promise<unknown>((resolve, reject) => {
    const homey = (window as unknown as {
      Homey: {
        get: (key: string, callback: (error: Error | null, value?: unknown) => void) => void;
      };
    }).Homey;
    homey.get(settingKey, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  }),
  key,
) as Promise<T>;

test.describe('Export price settings', () => {
  test('section renders for the solar home, toggle reveals fields, values persist', async ({ page }) => {
    await openElectricityPrices(page);

    const section = page.locator('#electricity-prices-export-section');
    await expect(section).toBeVisible();
    // Off by default: only the toggle shows; the fields are structurally absent.
    expect(await readMdSwitchSelected(page, '#electricity-prices-export-enabled')).toBe(false);
    await expect(section.locator('#electricity-prices-export-spot-factor')).toHaveCount(0);
    await expect(section.locator('#electricity-prices-export-fixed')).toHaveCount(0);

    await setMdSwitch(page, '#electricity-prices-export-enabled', true);
    await expect(section.locator('#electricity-prices-export-spot-factor')).toBeVisible();
    await expect(section.locator('#electricity-prices-export-fixed')).toBeVisible();
    // The share hint states the VAT-inclusive basis and the raw-spot recipe.
    await expect(section).toContainText('Share of the hourly spot price (incl. VAT)');
    await expect(section).toContainText('If your contract pays the raw spot price, enter 80');
    await expect.poll(
      () => readHomeySetting<boolean | undefined>(page, 'export_price_enabled'),
      { timeout: 3000 },
    ).toBe(true);

    await setMdValue(page, '#electricity-prices-export-spot-factor', '90');
    await expect.poll(
      () => readHomeySetting<number | undefined>(page, 'export_spot_factor'),
      { timeout: 3000 },
    ).toBe(90);

    // Signed fixed component — the NL you-pay-to-export case.
    await setMdValue(page, '#electricity-prices-export-fixed', '-5');
    await expect.poll(
      () => readHomeySetting<number | undefined>(page, 'export_fixed'),
      { timeout: 3000 },
    ).toBe(-5);

    // Turning the toggle back off hides the fields again.
    await setMdSwitch(page, '#electricity-prices-export-enabled', false);
    await expect(section.locator('#electricity-prices-export-spot-factor')).toHaveCount(0);
    await expect.poll(
      () => readHomeySetting<boolean | undefined>(page, 'export_price_enabled'),
      { timeout: 3000 },
    ).toBe(false);
  });

  test('settled spot-price share (0) is disabled with the fixed-only note on the flow scheme', async ({ page }) => {
    await seedStubSettings(page, {
      price_scheme: 'flow',
      export_price_enabled: true,
      export_spot_factor: 0,
      export_fixed: 12,
    });
    await openElectricityPrices(page);

    const section = page.locator('#electricity-prices-export-section');
    await expect(section).toBeVisible();
    const factor = section.locator('#electricity-prices-export-spot-factor');
    await expect(factor).toBeVisible();
    expect(await readMdValue(page, '#electricity-prices-export-spot-factor')).toBe('0');
    expect(await factor.evaluate((el) => (el as HTMLElement & { disabled: boolean }).disabled)).toBe(true);
    await expect(section).toContainText('Needs a spot price');
    await expect(section).toContainText('Only the fixed amount applies');
    // The fixed amount keeps working and drops the Norwegian unit from its label.
    await expect(section).toContainText('Fixed amount');
    await expect(section).not.toContainText('øre/kWh, incl. VAT');
  });

  test('stale non-zero share on the flow scheme is shown editable and can be repaired to 0', async ({ page }) => {
    // A spot-linked share without a spot yields NO export price at all — the
    // UI must show the real stored value with the repair note, and setting it
    // to 0 is an explicit user write that settles the config.
    await seedStubSettings(page, {
      price_scheme: 'flow',
      export_price_enabled: true,
      export_spot_factor: 90,
      export_fixed: 12,
    });
    await openElectricityPrices(page);

    const section = page.locator('#electricity-prices-export-section');
    const factor = section.locator('#electricity-prices-export-spot-factor');
    await expect(factor).toBeVisible();
    expect(await readMdValue(page, '#electricity-prices-export-spot-factor')).toBe('90');
    expect(await factor.evaluate((el) => (el as HTMLElement & { disabled: boolean }).disabled)).toBe(false);
    await expect(section).toContainText('Set the share to 0 to use the fixed amount only');

    await setMdValue(page, '#electricity-prices-export-spot-factor', '0');
    await expect.poll(
      () => readHomeySetting<number | undefined>(page, 'export_spot_factor'),
      { timeout: 3000 },
    ).toBe(0);
    // Settled: the field flips to the disabled fixed-only state.
    await expect(section).toContainText('Only the fixed amount applies');
    await expect.poll(
      () => factor.evaluate((el) => (el as HTMLElement & { disabled: boolean }).disabled),
      { timeout: 3000 },
    ).toBe(true);
  });
});

test.describe('Budget tab export subline', () => {
  test('shows the current hour\'s export price, negative rendered through the cost display', async ({ page }) => {
    // Pure fixed tariff (factor 0) makes the stub's export price deterministic:
    // -5 øre for every hour → "-0.05 kr/kWh" after the {unit: kr, divisor: 100}
    // scaling. This pins the 100×-trap and the signed rendering in one value.
    await seedStubSettings(page, {
      export_price_enabled: true,
      export_spot_factor: 0,
      export_fixed: -5,
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Budget' }).click();
    await expect(page.locator('#budget-panel')).toBeVisible();

    const subline = page.locator('#budget-export-price-now');
    await expect(subline).toBeVisible();
    await expect(subline).toHaveText('Export price now: -0.05 kr/kWh');
  });

  test('renders nothing when export pricing is off (no empty placeholder)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Budget' }).click();
    await expect(page.locator('#budget-panel')).toBeVisible();
    await expect(page.locator('#budget-redesign-surface section.plan-hero')).toBeVisible();
    await expect(page.locator('#budget-export-price-now')).toHaveCount(0);
  });
});
