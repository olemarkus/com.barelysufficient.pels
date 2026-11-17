import { expect, renderTest as test, type Page } from './fixtures/test';

const contested = {
  id: 'dev_mill',
  name: 'Gang nede ovn',
  available: true,
  deviceClass: 'heater',
  deviceType: 'temperature',
  capabilities: ['target_temperature', 'measure_temperature'],
  targets: [{ id: 'target_temperature', value: 15, unit: '°C' }],
  controlContest: { setting: 'temperature', commanded: 4.5, observed: 5, count: 6, sinceMs: 1000 },
};

const stubContestedDevice = async (page: Page, snapshot = contested) => {
  await page.addInitScript((device) => {
    const saved = sessionStorage.getItem('control-contest-dismissals');
    const sinceMs = Number(sessionStorage.getItem('control-contest-since')) || device.controlContest.sinceMs;
    (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
      settings: {
        target_devices_snapshot: [{ ...device, controlContest: { ...device.controlContest, sinceMs } }],
        managed_devices: { [device.id]: true },
        controllable_devices: { [device.id]: true },
        ...(saved ? { setup_recommendation_dismissals: JSON.parse(saved) } : {}),
      },
    };
  }, snapshot);
};

test.describe('A device that does not keep what PELS sets', () => {
  test('keeps the warning keyboard actions separate from a planned device card', async ({ page }, testInfo) => {
    await stubContestedDevice(page, { ...contested, id: 'dev_heatpump' });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const card = page.locator('#plan-cards [data-device-id="dev_heatpump"]');
    const icon = card.locator('.plan-card__control-warning-icon');
    await expect(icon).toBeVisible();
    await card.screenshot({ path: testInfo.outputPath('planned-overview-control-warning.png') });
    await icon.focus();
    await icon.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('#device-detail-overlay')).not.toBeVisible();
    const dialog = page.locator('.plan-card__control-warning-dialog');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.locator('#device-detail-overlay')).not.toBeVisible();
    await icon.focus();
    await icon.press('Space');
    await expect(page.getByRole('dialog')).toBeVisible();
    await dialog.getByRole('button', { name: 'Open device', exact: true }).click();
    await expect(page.locator('#device-detail-overlay')).toBeVisible();
    await expect(page.locator('#device-detail-control-contest-notice')).toBeInViewport();
  });

  test('offers two actions and a close icon, with the dialog outside the card', async ({ page }) => {
    await stubContestedDevice(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const card = page.locator('#plan-cards .plan-card').filter({ hasText: contested.name });
    await card.locator('.plan-card__control-warning-icon').click();
    const dialog = page.locator('.plan-card__control-warning-dialog');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(dialog.locator('[slot="actions"] md-text-button')).toHaveText(['Hide warning', 'Open device']);
    await expect(dialog.locator('[slot="headline"]').getByRole('button', { name: 'Close', exact: true }))
      .toBeVisible();
    await expect(dialog).toContainText('Hide warning removes this icon until it happens again.');
    // Under the body, so the scrim dims the cards after this one too.
    expect(await dialog.evaluate((element) => element.parentElement === document.body)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.locator('#device-detail-overlay')).not.toBeVisible();
  });

  test.describe('at 320 px', () => {
    test.use({ viewport: { width: 320, height: 800 } });

    test('keeps the two actions on one row', async ({ page }, testInfo) => {
      await stubContestedDevice(page);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      const card = page.locator('#plan-cards .plan-card').filter({ hasText: contested.name });
      await card.locator('.plan-card__control-warning-icon').click();
      const dialog = page.locator('.plan-card__control-warning-dialog');
      const modal = page.getByRole('dialog');
      await expect(modal).toBeVisible();
      // Both boxes in one read: the dialog is still moving while it opens.
      const readActions = () => dialog.evaluate((element) => {
        const box = (label: string) => Array.from(element.querySelectorAll('md-text-button'))
          .find((button) => button.textContent?.trim() === label)?.getBoundingClientRect();
        const hide = box('Hide warning');
        const open = box('Open device');
        return hide && open ? { rowOffset: Math.abs(hide.top - open.top), gap: open.left - hide.right } : null;
      });
      await expect.poll(async () => (await readActions())?.rowOffset).toBeLessThan(1);
      expect((await readActions())?.gap).toBeGreaterThanOrEqual(0);
      expect(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await modal.screenshot({ path: testInfo.outputPath('overview-control-warning-dialog-320.png') });
    });
  });

  test('shows an amber Overview icon and hides only the current conflict', async ({ page }, testInfo) => {
    await stubContestedDevice(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const card = page.locator('#plan-cards .plan-card').filter({ hasText: contested.name });
    const icon = card.locator('.plan-card__control-warning-icon');
    await expect(icon).toBeVisible();
    await expect(card.locator('.plan-chip')).toHaveCount(0);
    await card.screenshot({ path: testInfo.outputPath('overview-control-warning.png') });
    await icon.click();
    const dialog = page.locator('.plan-card__control-warning-dialog');
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await expect(dialog).toContainText('4.5 °C');
    await expect(page.locator('#device-detail-overlay')).not.toBeVisible();
    expect(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await modal.screenshot({ path: testInfo.outputPath('overview-control-warning-dialog.png') });
    await dialog.getByRole('button', { name: 'Hide warning', exact: true }).click();
    await expect(icon).not.toBeVisible();
    await expect(page.locator('#device-detail-overlay')).not.toBeVisible();
    const saved = await page.evaluate(() => {
      const homey = (window as unknown as { Homey: {
        __stub: { getSetting: (key: string) => Record<string, number> };
      } }).Homey;
      return homey.__stub.getSetting('setup_recommendation_dismissals');
    });
    expect(saved['control-contest:dev_mill']).toBe(1000);

    // The fixture SDK starts afresh on reload; preserve what the UI saved.
    await page.evaluate((dismissals) => {
      sessionStorage.setItem('control-contest-dismissals', JSON.stringify(dismissals));
    }, saved);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(card).toBeVisible();
    await expect(icon).not.toBeVisible();

    await page.evaluate(() => { sessionStorage.setItem('control-contest-since', '2000'); });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(icon).toBeVisible();
  });

  test('says so on the device page, next to Managed by PELS', async ({ page }, testInfo) => {
    await stubContestedDevice(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.locator('.settings-nav-card[data-settings-target="devices"]').click();
    await expect(page.locator('#devices-panel')).not.toContainText('Not keeping changes');
    await page.locator('#devices-panel [data-device-id="dev_mill"] .pels-device-card__detail-button').first().click();

    const notice = page.locator('#device-detail-control-contest-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Gang nede ovn doesn't keep PELS's changes");
    await expect(notice).toContainText('PELS set Gang nede ovn to 4.5 °C and Gang nede ovn then reported 5 °C');
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
    await expect(card.locator('.plan-chip')).toHaveText('Warning');
    await expect(card.locator('.plan-chip')).toHaveClass(/plan-chip--warn/);
    await expect(page.locator('#setup-recommendations-root .setup-recommendation-card').first())
      .toContainText("Gang nede ovn doesn't keep PELS's changes");
    await card.screenshot({ path: testInfo.outputPath('control-contest-recommendation.png') });
    await card.getByRole('button', { name: 'Open device' }).click();
    await expect(page.locator('#device-detail-overlay')).toBeVisible();
    await expect(page.locator('#device-detail-control-contest-notice')).toBeInViewport();
  });
});
