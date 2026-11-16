import { expect, test, type Page } from './fixtures/test';
import { setMdValue } from './fixtures/materialWeb';

const SHOTS = process.env.PELS_OVERRIDE_SHOTS;

const openDeviceDetail = async (page: Page, deviceId: string) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('.settings-nav-card[data-settings-target="devices"]').click();
  const row = page.locator(`#devices-panel [data-device-id="${deviceId}"]`).first();
  await row.locator('.pels-device-card__detail-button').click();
  await expect(page.locator('#device-detail-overlay')).toBeVisible({ timeout: 10000 });
};

const readSetting = (page: Page, key: string) => page.evaluate(
  (settingKey) => new Promise<unknown>((resolve, reject) => {
    const homey = (window as unknown as {
      Homey: { get: (key: string, callback: (error: Error | null, value?: unknown) => void) => void };
    }).Homey;
    homey.get(settingKey, (error, value) => (error ? reject(error) : resolve(value)));
  }),
  key,
);

const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.locator('#device-detail-override').screenshot({ path: `${SHOTS}/${name}.png` });
};

test('a managed thermostat starts and ends a temperature override from its page', async ({ page }) => {
  await openDeviceDetail(page, 'dev_heatpump');
  const card = page.locator('#device-detail-override');
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Override' })).toBeVisible();
  await shot(page, 'override-idle');

  await card.locator('[data-override-action="start"]').click();
  await setMdValue(page, '#device-detail-override [data-override-field="temperature"]', '23');
  await shot(page, 'override-form');
  const before = Date.now();
  await card.locator('[data-override-action="save"]').click();

  await expect(card.locator('[data-override-active]')).toContainText('23° until');
  await shot(page, 'override-active');
  const stored = await readSetting(page, 'device_override.dev_heatpump') as {
    untilMs: number; setting: { type: string; targetC: number };
  };
  expect(stored.setting).toEqual({ type: 'temperature', targetC: 23 });
  expect(stored.untilMs - before).toBeGreaterThanOrEqual(2 * 60 * 60_000 - 5_000);
  expect(stored.untilMs - before).toBeLessThanOrEqual(2 * 60 * 60_000 + 60_000);

  await card.locator('[data-override-action="end"]').click();
  await expect(card.locator('[data-override-action="start"]')).toHaveText('Set an override');
  const ended = await readSetting(page, 'device_override.dev_heatpump') as { untilMs: number };
  expect(ended.untilMs).toBeLessThanOrEqual(Date.now());
});

test('the override form asks for a date and time when the owner picks one', async ({ page }) => {
  await openDeviceDetail(page, 'dev_heatpump');
  const card = page.locator('#device-detail-override');
  await card.locator('[data-override-action="start"]').click();
  await card.getByRole('button', { name: 'Pick a time' }).click();

  await expect(card.locator('[data-override-field="date"]')).toBeVisible();
  await expect(card.locator('[data-override-field="time"]')).toBeVisible();
  await shot(page, 'override-form-custom');
  await card.locator('[data-override-field="date"]').fill('2020-01-01');
  await card.locator('[data-override-action="save"]').click();
  await expect(card.getByRole('alert')).toHaveText('Choose an end time in the future.');
});

test('the Override card links to a new schedule that repeats an override for the device', async ({ page }) => {
  await openDeviceDetail(page, 'dev_heatpump');
  const link = page.locator('#device-detail-override').getByText('Repeat on a schedule');

  await expect(link).toHaveAttribute('data-schedule-device', 'dev_heatpump');
  await expect(link).toHaveAttribute('data-schedule-action', 'override');
  await link.click();
  await expect(page.locator('#schedules-panel')).toBeVisible();
  await expect.poll(() => page.url()).toContain('scheduleAction=override');
});
