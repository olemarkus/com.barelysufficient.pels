/**
 * Captures "Missing a device?" in every theme context: the Devices link, the
 * device picker (all and filtered), a device support request, and its result.
 * Local only:
 *   PELS_CAPTURE_DEVICE_SUPPORT=1 PELS_DEVICE_SUPPORT_OUT_DIR=/tmp \
 *     npx playwright test device-support-screenshots.spec.ts --project=chromium-mobile-width
 */
import { captureThemes, expect, test, type Page } from './fixtures/test';
import { setMdValue } from './fixtures/materialWeb';
import { installDeviceSupportReportStub } from './fixtures/deviceSupportStub';

const openPicker = async (page: Page) => {
  await page.goto('/?page=settings/device-support');
  const picker = page.locator('#device-support-panel');
  await expect(picker.locator('[data-device-picker-id="dev_knx_relay"]')).toBeVisible();
  return picker;
};

const openRequest = async (page: Page) => {
  const picker = await openPicker(page);
  await picker.locator('[data-device-picker-id="dev_knx_relay"]').click();
  const panel = page.locator('#report-problem-panel');
  await expect(panel.locator('[data-report-field="problem"]')).toBeVisible();
  return panel;
};

test('captures device support surfaces', async ({ browser, browserName, baseURL }) => {
  test.skip(Boolean(process.env.CI), 'Device support screenshots are local only');
  test.skip(!process.env.PELS_CAPTURE_DEVICE_SUPPORT, 'Set PELS_CAPTURE_DEVICE_SUPPORT=1 to capture.');
  test.skip(browserName !== 'chromium', 'Mobile capture needs chromium isMobile emulation.');
  test.setTimeout(180_000);
  const outDir = process.env.PELS_DEVICE_SUPPORT_OUT_DIR ?? '/tmp';
  const prepare = installDeviceSupportReportStub;

  await captureThemes({ browser, baseURL, outDir, prepare, name: 'link', open: async (page) => {
    await page.goto('/?page=settings/devices');
    const link = page.locator('#device-support-link');
    await link.scrollIntoViewIfNeeded();
    return page.locator('#devices-panel .list__footer');
  } });
  await captureThemes({ browser, baseURL, outDir, prepare, name: 'setup', open: async (page) => {
    await page.goto('/?page=settings/devices&setup=devices');
    const prompt = page.locator('#devices-panel [data-setup-missing-device]');
    await prompt.scrollIntoViewIfNeeded();
    return prompt;
  } });
  await captureThemes({ browser, baseURL, outDir, prepare, name: 'picker', open: async (page) => {
    await openPicker(page);
  } });
  await captureThemes({ browser, baseURL, outDir, prepare, name: 'picker-unsupported', open: async (page) => {
    const picker = await openPicker(page);
    await picker.getByRole('button', { name: 'Not supported' }).click();
  } });
  await captureThemes({ browser, baseURL, outDir, prepare, name: 'picker-no-match', open: async (page) => {
    await openPicker(page);
    await setMdValue(page, '[data-device-picker-field="search"]', 'no such device');
  } });
  await captureThemes({ browser, baseURL, outDir, prepare, name: 'request', open: async (page) => {
    await openRequest(page);
    await setMdValue(page, '[data-report-field="problem"]', 'KNX relay switching my water heater.');
  } });
  await captureThemes({ browser, baseURL, outDir, prepare, name: 'request-empty-send', open: async (page) => {
    const panel = await openRequest(page);
    await panel.locator('[data-report-action="send"]').click();
    await expect(panel.getByRole('textbox', { name: 'Describe the device' })).toHaveAttribute('aria-invalid', 'true');
  } });
  await captureThemes({ browser, baseURL, outDir, prepare, name: 'sent', open: async (page) => {
    const panel = await openRequest(page);
    await setMdValue(page, '[data-report-field="problem"]', 'KNX relay switching my water heater.');
    await panel.locator('[data-report-action="send"]').click();
    await expect(panel.getByRole('heading', { name: 'Request sent' })).toBeVisible();
  } });
});
