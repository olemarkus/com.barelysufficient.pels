import { expect, test } from './fixtures/test';
import {
  gotoApp,
  seedRentalArea,
  seedStubSetting,
} from './fixtures/homes';
import { setMdValue } from './fixtures/materialWeb';

const AREA_ID = 'h_11111111';

test('Settings renders independent Main and meter-area mode selectors without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await gotoApp(page);
  // `gotoApp` establishes the Homey bridge, but the settings-event router can
  // still be finishing boot. Wait for the initial selector before emitting the
  // post-boot homes_config change so this test exercises the production refresh
  // path instead of racing listener registration.
  await expect(page.locator('#active-mode-select')).toHaveCount(1);
  await seedStubSetting(page, `operating_mode:${AREA_ID}`, 'Sleep');
  await seedStubSetting(page, `capacity_priorities:${AREA_ID}`, {
    Sleep: { dev_bedroom: 1 },
    Guests: { dev_bedroom: 1 },
  });
  await seedStubSetting(page, `mode_device_targets:${AREA_ID}`, {
    Sleep: { dev_bedroom: 17 },
    Guests: { dev_bedroom: 20 },
  });
  await seedStubSetting(page, `mode_catalog_initialized:${AREA_ID}`, true);
  await seedRentalArea(page, 'Basement apartment with a very long name');

  await page.getByRole('tab', { name: 'Settings' }).click();
  const rows = page.locator('.settings-current-mode__row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Main home');
  await expect(rows.nth(1)).toContainText('Basement apartment with a very long name');
  const areaSelect = rows.nth(1).locator('md-filled-select');
  await expect(areaSelect).toHaveJSProperty('value', 'Sleep');
  await expect.poll(() => areaSelect.locator('md-select-option')
    .evaluateAll((options) => (
      options.filter((option) => (
        option as HTMLElement & { value?: string }
      ).value === 'Guests').length
    ))).toBe(1);

  await setMdValue(page, '.settings-current-mode__row:nth-child(2) md-filled-select', 'Guests');
  await expect(areaSelect).toHaveJSProperty('value', 'Guests');
  await expect(page.locator('#active-mode-select')).toHaveJSProperty('value', 'Home');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
