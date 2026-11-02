import { expect, test, type Page } from './fixtures/test';

const contested = {
  id: 'dev_mill',
  name: 'Gang nede ovn',
  available: true,
  deviceClass: 'heater',
  deviceType: 'temperature',
  capabilities: ['target_temperature', 'measure_temperature'],
  targets: [{ id: 'target_temperature', value: 15, unit: '°C' }],
  controlContest: { capabilityId: 'target_temperature', kind: 'reverted', count: 6, sinceMs: 0 },
};

const stubContestedDevice = async (page: Page) => {
  await page.addInitScript((device) => {
    (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
      settings: {
        target_devices_snapshot: [device],
        managed_devices: { [device.id]: true },
        controllable_devices: { [device.id]: true },
      },
    };
  }, contested);
};

test.describe('A device that does not keep what PELS sets', () => {
  test('says so on the device page, next to Managed by PELS', async ({ page }, testInfo) => {
    await stubContestedDevice(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.locator('.settings-nav-card[data-settings-target="devices"]').click();
    await page.locator('#devices-panel [data-device-id="dev_mill"] .pels-device-card__detail-button').first().click();

    const notice = page.locator('#device-detail-control-contest-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Gang nede ovn doesn't keep PELS's changes");
    await expect(notice).toContainText('went back to its earlier temperature');
    expect(await page.locator('#device-detail-panel').evaluate((panel) => (
      panel.scrollWidth <= panel.clientWidth
    ))).toBe(true);
    await notice.scrollIntoViewIfNeeded();
    await page.locator('#device-detail-setup-section, #device-detail-panel').first()
      .screenshot({ path: testInfo.outputPath('control-contest-device.png') });
  });

  test('lists it under recommendations, opening the device', async ({ page }, testInfo) => {
    await stubContestedDevice(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.locator('.settings-nav-card[data-settings-target="recommendations"]').click();

    const card = page.locator('#setup-recommendations-root .setup-recommendation-card', {
      hasText: "Gang nede ovn doesn't keep PELS's changes",
    });
    await expect(card).toBeVisible();
    await card.screenshot({ path: testInfo.outputPath('control-contest-recommendation.png') });
    await card.getByRole('button', { name: 'Open device' }).click();
    await expect(page.locator('#device-detail-overlay')).toBeVisible();
    await expect(page.locator('#device-detail-control-contest-notice')).toBeVisible();
  });
});
