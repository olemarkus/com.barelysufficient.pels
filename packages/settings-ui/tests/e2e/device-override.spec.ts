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
  // The form starts from the active mode's target, not the device's shifted setpoint.
  await expect(card.locator('[data-override-field="temperature"]')).toHaveJSProperty('value', '21');
  await setMdValue(page, '#device-detail-override [data-override-field="temperature"]', '23');
  await card.getByRole('button', { name: 'In 2 hours' }).click();
  await expect(card.locator('[data-override-end-line]')).toHaveText(/^Ends (today|tomorrow) \d{2}:\d{2}$/u);
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

  // Change opens on the override's own end, so saving a new temperature keeps it.
  await card.getByRole('button', { name: 'Change' }).click();
  await setMdValue(page, '#device-detail-override [data-override-field="temperature"]', '24');
  await card.locator('[data-override-action="save"]').click();
  await expect(card.locator('[data-override-active]')).toContainText('24° until');
  const changed = await readSetting(page, 'device_override.dev_heatpump') as { untilMs: number };
  expect(Math.abs(changed.untilMs - stored.untilMs)).toBeLessThan(60_000);

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
  // The link is offered for a device the app lists for scheduled actions.
  await page.addInitScript(() => {
    (window as unknown as { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = { apiHandlers: {
      'GET /ui_smart_task_devices': () => ({ state: 'ready', devices: [{
        deviceId: 'dev_heatpump', deviceName: 'Living Room Heat Pump', kind: 'temperature', group: 'heating',
        unitSymbol: '°C', goalMin: 10, goalMax: 30, goalStep: 0.5, defaultGoal: 22, currentValue: 20,
        supportsLimitLowerPriority: false, offersQuickTargets: false, otherGoals: [], overridable: true,
      }] }),
    } };
  });
  await openDeviceDetail(page, 'dev_heatpump');
  const link = page.locator('#device-detail-override').getByText('Repeat on a schedule');

  await expect(link).toHaveAttribute('data-schedule-device', 'dev_heatpump');
  await expect(link).toHaveAttribute('data-schedule-action', 'override');
  // The schedule opens at the active mode's target for the device.
  await expect(link).toHaveAttribute('data-schedule-temperature', '21');
  await link.click();
  await expect(page.locator('#schedules-panel')).toBeVisible();
  await expect.poll(() => page.url()).toContain('scheduleAction=override');
  await expect.poll(() => page.url()).toContain('scheduleTemperature=21');
});

test('the Smart task box and the override form say an open task waits for the override', async ({ page }) => {
  await page.addInitScript(() => {
    const hour = 60 * 60_000;
    (window as unknown as { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = { settings: {
      'device_override.dev_heatpump': { untilMs: Date.now() + 5 * hour, setting: { type: 'temperature', targetC: 23 } },
      'deferred_objective.dev_heatpump': {
        enabled: true, kind: 'temperature', enforcement: 'soft', targetTemperatureC: 24, deadlineAtMs: Date.now() + 3 * hour,
      },
    } };
  });
  await openDeviceDetail(page, 'dev_heatpump');

  // The task must be ready in 3 hours and the override lasts 5.
  await expect(page.locator('#device-detail-smart-task'))
    .toContainText('· Ends without running: the override lasts past its ready-by time');
  const card = page.locator('#device-detail-override');
  await card.getByRole('button', { name: 'Change' }).click();
  await card.getByRole('button', { name: 'In 2 hours' }).click();
  await expect(card.locator('[data-override-smart-task-note]'))
    .toHaveText('The Smart task on this device waits until the override ends.');
  await card.getByRole('button', { name: 'Pick a time' }).click();
  await expect(card.locator('[data-override-smart-task-note]'))
    .toHaveText('The Smart task on this device ends without running: its ready-by time comes first.');
});
