// The "Run on solar surplus" (binary dump-load) toggle in the device detail
// panel: gate matrix on the rendered surface (binary candidate shows it,
// temperature device does not), the persisted blob round-trip (a fresh opt-in
// writes the full valid entry with zero deltas), the reconcile-contract helper
// copy, and the Overview held-card line ("Waiting for solar surplus"). Runs
// across the mobile-width (480 px) and narrow-width (320 px) projects.
import { expect, test, type Page } from './fixtures/test';
import { readMdSwitchSelected, setMdSwitch } from './fixtures/materialWeb';

const openDevices = async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('.settings-nav-card[data-settings-target="devices"]').click();
  await expect(page.locator('#devices-panel')).toBeVisible();
};

const openDeviceDetail = async (page: Page, deviceId: string) => {
  await openDevices(page);
  const row = page.locator(`#devices-panel [data-device-id="${deviceId}"]`).first();
  await expect(row).toBeVisible();
  const detailButton = row.locator('.pels-device-card__detail-button');
  await detailButton.scrollIntoViewIfNeeded();
  await detailButton.click();
  await expect(page.locator('#device-detail-overlay')).toBeVisible({ timeout: 10000 });
  // The Control cluster (managed / price / surplus switch rows) lives inside
  // the setup disclosure. Ensure it is OPEN rather than blindly clicking the
  // summary: for binary devices the page auto-expands Setup on open, and a
  // blind click would toggle it closed again.
  await page.locator('#device-detail-setup-section details').evaluate((el) => {
    (el as HTMLDetailsElement).open = true;
  });
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

test.describe('Run on solar surplus (dump-load toggle)', () => {
  test('offers the toggle on a managed binary device, with the reconcile-contract copy', async ({ page }) => {
    await openDeviceDetail(page, 'dev_poolpump');
    const row = page.locator('#device-detail-dump-load-row');
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeVisible();
    await expect(row).toContainText('Run on solar surplus');
    // The helper copy MUST state the reconcile contract — the user learns from
    // the toggle itself that a manual ON gets corrected.
    await expect(row).toContainText(
      'If you switch it on yourself while there is no surplus, PELS will switch it off again.',
    );
    // And the v1 scope guidance with the sole-water-heater warning.
    await expect(row).toContainText('Not for your only water heater');
  });

  test('hides the toggle on a temperature device (that modality gets the setpoint lift)', async ({ page }) => {
    await openDeviceDetail(page, 'dev_heatpump');
    await expect(page.locator('#device-detail-dump-load-row')).toBeHidden();
    // The temperature surplus control is the one offered instead.
    await expect(page.locator('#device-detail-surplus-opt-row')).toBeVisible();
  });

  test('opting in persists the full valid blob entry and survives reopening the panel', async ({ page }) => {
    await openDeviceDetail(page, 'dev_poolpump');
    const switchSelector = '#device-detail-dump-load-opt';
    expect(await readMdSwitchSelected(page, switchSelector)).toBe(false);

    await setMdSwitch(page, switchSelector, true);
    await expect.poll(async () => {
      const settings = await readHomeySetting<Record<string, {
        enabled?: boolean; cheapDelta?: number; expensiveDelta?: number; surplusWilling?: boolean;
      }> | null>(page, 'price_optimization_settings');
      return settings?.dev_poolpump;
    }).toEqual({ enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusWilling: true });

    // Close and reopen (same session): the switch reads the opt-in back.
    await page.locator('#device-detail-close').click();
    await expect(page.locator('#device-detail-overlay')).toBeHidden();
    const row = page.locator('#devices-panel [data-device-id="dev_poolpump"]').first();
    await row.locator('.pels-device-card__detail-button').click();
    await expect(page.locator('#device-detail-overlay')).toBeVisible();
    expect(await readMdSwitchSelected(page, switchSelector)).toBe(true);

    // Opting out flips only surplusWilling.
    await setMdSwitch(page, switchSelector, false);
    await expect.poll(async () => {
      const settings = await readHomeySetting<Record<string, { surplusWilling?: boolean }> | null>(
        page,
        'price_optimization_settings',
      );
      return settings?.dev_poolpump?.surplusWilling;
    }).toBe(false);
  });

  test('the Overview card of a surplus-held device reads "Waiting for solar surplus"', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
    const card = page.locator('.plan-card[data-device-id="dev_poolpump"]').first();
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();
    await expect(card.locator('.plan-card__reason')).toHaveText('Waiting for solar surplus');
    // Jargon guard: the internal reason code never leaks.
    await expect(card).not.toContainText('awaiting_solar_surplus');
  });
});
