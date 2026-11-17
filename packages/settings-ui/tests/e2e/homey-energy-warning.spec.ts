import { expect, injectHomeyHostCss, test } from './fixtures/test';
import { HOMEY_ENERGY_SETUP_DOCS_URL, HOMEY_ENERGY_SETUP_REASON } from '../../../shared-domain/src/homeyEnergySetup';

for (const touch of [false, true]) {
  test(`Homey Energy warning opens its guide on ${touch ? 'tap' : 'hover'}`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({
      baseURL, viewport: { width: 320, height: 900 }, isMobile: touch, hasTouch: touch,
    });
    try {
      const page = await context.newPage();
      await injectHomeyHostCss(page);
      await page.addInitScript(() => {
        Object.assign(window, { __PELS_HOMEY_STUB__: { settings: {
          target_devices_snapshot: [{
            id: 'energy-setup', name: 'Utility plug', deviceClass: 'socket', deviceType: 'onoff',
            capabilities: ['onoff'], binaryControl: { on: true }, binaryControllable: true,
            isEvCharger: false, isBatteryOrSolar: false, managed: true, controllable: false,
            powerCapable: false, available: true, targets: [], expectedPowerKw: 1,
            expectedPowerSource: 'default', zoneName: 'Utility room',
          }], managed_devices: { 'energy-setup': true }, controllable_devices: {},
        } } });
      });
      await page.goto('/?page=settings/devices');
      const warning = page.getByRole('button', { name: 'Power use needs setup for Utility plug' });
      await expect(warning).toBeVisible();
      await page.evaluate(() => {
        const host = window as unknown as { Homey: { openURL: (url: string) => void }; openedGuide?: string };
        host.Homey.openURL = (url) => { host.openedGuide = url; };
      });
      if (touch) await warning.tap();
      else await warning.hover();
      const guide = page.getByRole('link', { name: 'Set up power use in Homey' });
      await expect(guide).toBeVisible();
      await expect(page.getByText(HOMEY_ENERGY_SETUP_REASON, { exact: true })).toBeInViewport();
      await expect(warning).toHaveAccessibleName(
        `Power use needs setup for Utility plug. ${HOMEY_ENERGY_SETUP_REASON}.`,
      );
      await expect(guide).toHaveAttribute('href', HOMEY_ENERGY_SETUP_DOCS_URL);
      await expect(page.locator('#device-detail-overlay')).not.toBeVisible();
      if (!touch) {
        await warning.focus();
        await page.keyboard.press('Tab');
        await expect(guide).toBeFocused();
      }
      await page.screenshot({ path: test.info().outputPath('energy-warning.png') });
      if (touch) await guide.tap();
      else await guide.click();
      await expect.poll(() => page.evaluate(() => (
        window as unknown as { openedGuide?: string }
      ).openedGuide)).toBe(HOMEY_ENERGY_SETUP_DOCS_URL);
    } finally {
      await context.close();
    }
  });
}
