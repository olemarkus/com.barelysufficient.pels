import { expect, injectHomeyHostCss, test } from './fixtures/test';
import { setMdValue } from './fixtures/materialWeb';
import { installDeviceSupportReportStub, readDeviceSupportStub } from './fixtures/deviceSupportStub';

test('finds an unsupported Homey device and sends a device support request for it', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 1100 });
  await injectHomeyHostCss(page);
  await installDeviceSupportReportStub(page);
  await page.goto('/?page=settings/devices');
  await page.locator('#device-support-link').click();

  const picker = page.locator('#device-support-panel');
  await expect(picker.locator('[data-device-picker-id="dev_knx_relay"]')).toBeVisible();
  await expect(picker.locator('[data-device-picker-id="dev_heatpump"]')).toBeVisible();

  await picker.getByRole('button', { name: 'Not supported' }).click();
  await expect(picker.locator('[data-device-picker-id="dev_heatpump"]')).toHaveCount(0);
  await expect(picker.locator('[data-device-picker-id="dev_bath_fan"]')).toBeVisible();

  await setMdValue(page, '[data-device-picker-field="search"]', 'basement');
  await expect(picker.locator('[data-device-picker-id="dev_bath_fan"]')).toHaveCount(0);
  await expect(picker.locator('[data-device-picker-id="dev_knx_relay"]')).toBeVisible();
  await setMdValue(page, '[data-device-picker-field="search"]', 'no such device');
  await expect(picker).toContainText('No devices match.');
  await picker.locator('[data-device-picker-action="show-all"]').click();
  await expect(picker.locator('[data-device-picker-id="dev_heatpump"]')).toBeVisible();
  await picker.getByRole('button', { name: 'Not supported' }).click();
  await setMdValue(page, '[data-device-picker-field="search"]', 'relay');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await picker.locator('[data-device-picker-id="dev_knx_relay"]').click();
  const panel = page.locator('#report-problem-panel');
  await expect(panel).toContainText('Water heater relay');
  await expect(panel.getByRole('link', { name: /forum/i }).first()).toBeVisible();
  await panel.locator('[data-report-action="send"]').click();
  await expect(panel.getByRole('textbox', { name: 'Describe the device' })).toHaveAttribute('aria-invalid', 'true');
  expect((await readDeviceSupportStub(page)).requests).toHaveLength(0);

  await setMdValue(page, '[data-report-field="problem"]', 'KNX relay switching my water heater.');
  await panel.locator('[data-report-action="send"]').click();
  await expect(panel.getByRole('heading', { name: 'Request sent' })).toBeInViewport();
  const { requests, sends } = await readDeviceSupportStub(page);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    problem: 'KNX relay switching my water heater.',
    subject: { kind: 'device_support', deviceId: 'dev_knx_relay' },
  });
  expect(sends).toEqual([{ consent: true }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Done steps back to the picker, so Back leaves it instead of reopening the sent request.
  await panel.locator('[data-report-action="done"]').click();
  await expect(page).toHaveURL(/page=settings%2Fdevice-support|page=settings\/device-support/);
  await expect(picker.locator('[data-device-picker-id="dev_knx_relay"]')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/page=settings%2Fdevices|page=settings\/devices(&|$)/);
});

test('opens a supported device on Devices instead of a support request', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 1100 });
  await installDeviceSupportReportStub(page);
  await page.goto('/?page=settings/device-support');
  const picker = page.locator('#device-support-panel');
  await picker.locator('[data-device-picker-id="dev_heatpump"]').click();
  await expect(page.locator('#device-detail-overlay')).toBeVisible();
  await expect(page.locator('#report-problem-panel')).toBeHidden();
  expect((await readDeviceSupportStub(page)).requests).toHaveLength(0);
});

test('setup points to Find a device under its device list, and Back returns to setup', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 1100 });
  await page.goto('/?page=settings/devices&setup=devices');
  const prompt = page.locator('#devices-panel [data-setup-missing-device]');
  await expect(prompt).toContainText('Missing a device?');
  await prompt.getByRole('button', { name: 'Find a device' }).click();
  const picker = page.locator('#device-support-panel');
  await expect(picker.locator('[data-device-picker-id="dev_knx_relay"]')).toBeVisible();
  await picker.getByRole('button', { name: 'Back to Devices' }).click();
  await expect(page).toHaveURL(/setup=devices/);
  await expect(prompt).toBeVisible();
});
