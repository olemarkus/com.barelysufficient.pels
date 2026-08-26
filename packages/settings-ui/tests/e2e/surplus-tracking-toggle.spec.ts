// The "Charge on solar surplus" tracking toggle in the device detail panel:
// the gate matrix on the rendered surface (a stepped charger offers it, a plain
// binary device gets the dump-load toggle instead), the kind-specific label, the
// floor selector's honesty requirement (the real kW in visible text), and the
// persisted blob round-trip. Runs across the mobile-width (480 px) and
// narrow-width (320 px) projects.
import { expect, test, type Page } from './fixtures/test';
import {
  readMdSwitchSelected,
  readMdValue,
  setMdSwitch,
  setMdValue,
} from './fixtures/materialWeb';

const CHARGER = 'dev_zaptec';

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

test.describe('Charge on solar surplus (tracking toggle)', () => {
  test('offers the toggle on a stepped charger, labelled by what happens to it', async ({ page }) => {
    await openDeviceDetail(page, CHARGER);
    const row = page.locator('#device-detail-surplus-track-row');
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeVisible();
    // A charger's level is a charging current, so the label says "Charge",
    // not the generic "Match" a non-charger stepped load gets.
    await expect(row).toContainText('Charge on solar surplus');
    // A deadline the owner set must not be silently missed by "use only your
    // own sun", and the toggle says so where they decide.
    await expect(row).toContainText('A smart task with a deadline on this device decides instead');
  });

  test('offers the dump-load toggle instead on a plain binary device', async ({ page }) => {
    await openDeviceDetail(page, 'dev_poolpump');
    await expect(page.locator('#device-detail-surplus-track-row')).toBeHidden();
    await expect(page.locator('#device-detail-dump-load-row')).toBeVisible();
  });

  test('offers the setpoint lift instead on a temperature device', async ({ page }) => {
    await openDeviceDetail(page, 'dev_heatpump');
    await expect(page.locator('#device-detail-surplus-track-row')).toBeHidden();
    await expect(page.locator('#device-detail-surplus-opt-row')).toBeVisible();
  });

  test('opting in reveals the floor choice and names the real kW in visible text', async ({ page }) => {
    await openDeviceDetail(page, CHARGER);
    // Hidden until opted in — an owner who has not turned the feature on has no
    // decision to make here.
    await expect(page.locator('#device-detail-surplus-track-section')).toBeHidden();

    await setMdSwitch(page, '#device-detail-surplus-track-opt', true);
    const section = page.locator('#device-detail-surplus-track-section');
    await section.scrollIntoViewIfNeeded();
    await expect(section).toBeVisible();
    await expect(section).toContainText('When surplus runs out');

    // The honesty requirement: "keep going at the lowest level" means grid
    // import, and how much must be stated on the surface rather than in a
    // tooltip — a hover tooltip is unreachable in the touch WebView. This
    // charger's ladder floor is 1380 W.
    await expect(page.locator('#device-detail-surplus-floor-hint')).toContainText('1.4 kW');

    // Jargon guard: the internal vocabulary never leaks to the owner.
    await expect(section).not.toContainText('ceiling');
    await expect(section).not.toContainText('surplusTracking');
  });

  test('the floor choice persists and survives reopening the panel', async ({ page }) => {
    await openDeviceDetail(page, CHARGER);
    expect(await readMdSwitchSelected(page, '#device-detail-surplus-track-opt')).toBe(false);
    await setMdSwitch(page, '#device-detail-surplus-track-opt', true);

    await expect.poll(async () => {
      const settings = await readHomeySetting<Record<string, {
        surplusWilling?: boolean; surplusFloor?: string;
      }> | null>(page, 'price_optimization_settings');
      return settings?.[CHARGER]?.surplusWilling;
    }).toBe(true);

    // `md-filled-select` is a web component, not a native <select>.
    await setMdValue(page, '#device-detail-surplus-floor', 'minimum');
    await expect.poll(async () => {
      const settings = await readHomeySetting<Record<string, { surplusFloor?: string }> | null>(
        page,
        'price_optimization_settings',
      );
      return settings?.[CHARGER]?.surplusFloor;
    }).toBe('minimum');

    await page.locator('#device-detail-close').click();
    await expect(page.locator('#device-detail-overlay')).toBeHidden();
    const row = page.locator(`#devices-panel [data-device-id="${CHARGER}"]`).first();
    await row.locator('.pels-device-card__detail-button').click();
    await expect(page.locator('#device-detail-overlay')).toBeVisible();
    expect(await readMdSwitchSelected(page, '#device-detail-surplus-track-opt')).toBe(true);
    expect(await readMdValue(page, '#device-detail-surplus-floor')).toBe('minimum');
  });
});
