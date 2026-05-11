/**
 * Captures full-height device detail panel screenshots across device kinds.
 * Run locally:
 *   npx playwright test device-detail-full-screenshot.spec.ts --project=chromium-mobile-width
 */
import { expect, test, type Page } from './fixtures/test';

const OUT = '../../docs/public/screenshots/device-detail';

test.beforeEach(async ({ page }) => {
  test.skip(Boolean(process.env.CI), 'Full-panel screenshot is local only');
  // Disable CSS animations and transitions so screenshots are deterministic
  // without waitForTimeout settle hacks.
  await page.addInitScript(() => {
    const css = '*,*::before,*::after{transition:none!important;animation:none!important;}';
    const apply = () => {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    };
    if (document.head) apply();
    else document.addEventListener('DOMContentLoaded', apply);
  });
});

test.use({ viewport: { width: 480, height: 900 } });

const openDeviceDetail = async (page: Page, deviceId: string) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('[data-settings-target="devices"]').click();
  const row = page.locator(`#device-list .device-row[data-device-id="${deviceId}"]`);
  await expect(row).toBeVisible();
  await row.locator('.device-row__name').click();
  await expect(page.locator('#device-detail-overlay')).toBeVisible();

  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#dry-run-banner')?.style.setProperty('display', 'none');
  });
};

const enableEvSupportViaUi = async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('[data-settings-target="advanced"]').click();
  const toggle = page.locator('#advanced-ev-support-enabled');
  await expect(toggle).toBeVisible();
  if (!(await toggle.isChecked())) {
    await toggle.check();
    await expect(page.locator('#toast')).toContainText('EV charger support enabled.');
  }
};

const expandAllSections = async (page: Page) => {
  await page.evaluate(() => {
    document
      .querySelectorAll<HTMLDetailsElement>('#device-detail-panel details')
      .forEach((d) => { d.open = true; });
  });
};

const fullPanelScreenshot = async (page: Page, name: string) => {
  const panel = page.locator('#device-detail-panel');
  await panel.waitFor();
  const scrollHeight = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#device-detail-panel');
    if (!el) return 900;
    const content = el.querySelector<HTMLElement>('.slide-panel__content') ?? el;
    return Math.max(el.scrollHeight, content.scrollHeight) + 40;
  });
  await page.setViewportSize({ width: 480, height: Math.min(8000, Math.max(900, scrollHeight)) });
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.slide-panel__content');
    if (el) el.scrollTop = 0;
  });
  // One animation frame after the layout change settles, no arbitrary sleep.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await panel.screenshot({ path: `${OUT}/${name}.png` });
};

test('thermostat — heatpump', async ({ page }) => {
  await openDeviceDetail(page, 'dev_heatpump');
  await expandAllSections(page);
  await fullPanelScreenshot(page, 'thermostat-heatpump-full');
});

test('thermostat — bedroom', async ({ page }) => {
  await openDeviceDetail(page, 'dev_bedroom');
  await expandAllSections(page);
  await fullPanelScreenshot(page, 'thermostat-bedroom-full');
});

test('on/off — water heater', async ({ page }) => {
  await openDeviceDetail(page, 'dev_waterheater');
  await expandAllSections(page);
  await fullPanelScreenshot(page, 'onoff-waterheater-full');
});

test('stepped — Zaptec EV charger', async ({ page }) => {
  await openDeviceDetail(page, 'dev_zaptec');
  await expandAllSections(page);
  await fullPanelScreenshot(page, 'stepped-zaptec-full');
});

test('stepped — Connected 300 water heater', async ({ page }) => {
  await openDeviceDetail(page, 'dev_connected300');
  await expandAllSections(page);
  await fullPanelScreenshot(page, 'stepped-connected300-full');
});

test('generic EV charger (with EV support enabled)', async ({ page }) => {
  await enableEvSupportViaUi(page);
  // Stay on the same SPA session so the EV toggle persists; navigate to
  // Devices via the in-app tab rather than goto('/').
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('[data-settings-target="devices"]').click();
  const row = page.locator('#device-list .device-row[data-device-id="dev_evcharger"]');
  await expect(row).toBeVisible();
  await row.locator('.device-row__name').click();
  await expect(page.locator('#device-detail-overlay')).toBeVisible();
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#dry-run-banner')?.style.setProperty('display', 'none');
  });
  await expandAllSections(page);
  await fullPanelScreenshot(page, 'ev-generic-full');
});
