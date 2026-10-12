import fs from 'node:fs';
import path from 'node:path';
import { expect, injectHomeyHostCss, test, type Page } from './fixtures/test';

const installCreateStub = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const stubWindow = window as typeof window & {
      __PELS_HOMEY_STUB__?: unknown;
      __LAST_SMART_TASK_CREATE__?: unknown;
    };
    stubWindow.__PELS_HOMEY_STUB__ = {
      settings: { deferred_objectives: { version: 1, objectivesByDeviceId: {} } },
      apiHandlers: {
        'GET /ui_smart_task_devices': () => ({
          state: 'ready', devices: [{
            deviceId: 'dev_connected300', deviceName: 'Connected 300', kind: 'temperature',
            group: 'heating', unitSymbol: '°C', goalMin: 30, goalMax: 75, goalStep: 0.5,
            defaultGoal: 60, currentValue: 51.1, supportsLimitLowerPriority: false,
          }, {
            deviceId: 'dev_poolpump', deviceName: 'Pool Pump', kind: 'energy',
            group: 'heating', unitSymbol: 'kWh', goalMin: 0.1, goalMax: 200, goalStep: 0.1,
            defaultGoal: 10, currentValue: null, supportsLimitLowerPriority: false,
          }],
        }),
        'POST /ui_smart_task_create_preview': () => ({
          ok: true, deadlineAtMs: 1_900_000_000_000,
          deadlineLabel: 'Tomorrow 07:00', scheduledWindowLabel: '02:00–04:00',
          estimate: {
            status: 'on_track', budgetRole: 'none',
            scheduledHours: [{ startsAtMs: 1, plannedKWh: 1.5 }],
            projectedFinishAtMs: 2, energyEstimateKWh: 1.5,
            energyExpectedKWh: 1.4, costEstimate: 6.1, costUnit: 'kr',
          },
        }),
        'POST /ui_smart_task_create': (body: unknown) => {
          stubWindow.__LAST_SMART_TASK_CREATE__ = body;
          return { ok: true };
        },
      },
    };
  });
};

const openDevice = async (page: Page): Promise<void> => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('.settings-nav-card[data-settings-target="devices"]').click();
  const row = page.locator('#devices-panel [data-device-id="dev_connected300"]').first();
  await row.locator('.pels-device-card__detail-button').click();
  await expect(page.locator('#device-detail-overlay')).toBeVisible();
};

test.describe('Create smart task from settings', () => {
  test.beforeEach(async ({ page }) => {
    await installCreateStub(page);
    await page.setViewportSize({ width: 320, height: 900 });
  });

  test('offers creation on the Smart tasks page and creates the previewed goal', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Smart tasks' }).click();
    await page.getByRole('button', { name: 'New smart task' }).click();
    const composer = page.locator('#smart-task-create-root');
    await expect(composer).toBeVisible();
    await composer.getByRole('button', { name: /Connected 300/ }).click();
    await composer.getByRole('button', { name: 'Preview task' }).click();
    await expect(composer).toContainText('Scheduled 02:00–04:00 · Ready by Tomorrow 07:00');
    await composer.getByRole('button', { name: 'Create task' }).click();
    await expect.poll(() => page.url()).toContain('page=deadline-plan');
    const body = await page.evaluate(() => (window as typeof window & {
      __LAST_SMART_TASK_CREATE__?: { deadlineAtMs?: number; deviceId?: string };
    }).__LAST_SMART_TASK_CREATE__);
    expect(body).toMatchObject({ deviceId: 'dev_connected300', deadlineAtMs: 1_900_000_000_000 });
  });

  test('says who starts the device once the task is done, and opens its settings over the flow', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Smart tasks' }).click();
    await page.getByRole('button', { name: 'New smart task' }).click();
    const composer = page.locator('#smart-task-create-root');
    await composer.getByRole('button', { name: /Pool Pump/ }).click();
    await composer.getByRole('button', { name: 'Preview task' }).click();
    const afterTask = composer.locator('.smart-task-create__after-task');
    await expect(afterTask).toContainText('When the task is done');
    await expect(afterTask).toContainText(
      'PELS turns Pool Pump on whenever power allows, even after it was turned off elsewhere.',
    );
    await afterTask.getByRole('button', { name: 'Change' }).click();
    const overlay = page.locator('#device-detail-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('#device-detail-setup-disclosure')).toHaveAttribute('open', '');
    await expect(overlay.locator('#device-detail-start-rule')).toHaveText(
      'PELS turns it on whenever power allows, even after it was turned off elsewhere.',
    );
    await overlay.locator('#device-detail-close').click();
    await expect(overlay).toBeHidden();
    await expect(afterTask).toBeVisible();
  });

  test('offers Add at the end of the device page and returns there on Back', async ({ page }) => {
    await openDevice(page);
    const overlay = page.locator('#device-detail-overlay');
    const box = overlay.locator('#device-detail-smart-task');
    await expect(box.getByRole('button', { name: 'Add smart task' })).toBeVisible();
    await expect(overlay.locator('#device-detail-live-smart-task')).toHaveCount(0);
    await box.getByRole('button', { name: 'Add smart task' }).click();
    const composer = page.locator('#smart-task-create-root');
    await expect(composer).toContainText('Connected 300');
    await composer.getByRole('button', { name: 'Back' }).click();
    await expect(overlay).toBeVisible();
    await expect(page.locator('#devices-panel')).toBeVisible();
    await expect(box.getByRole('button', { name: 'Add smart task' })).toBeVisible();
  });
});

test('View task on the device page opens the task page and closes the device page', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await openDevice(page);
  const overlay = page.locator('#device-detail-overlay');
  await overlay.locator('#device-detail-smart-task').getByRole('button', { name: 'View task' }).click();
  await expect.poll(() => page.url()).toContain('page=deadline-plan');
  await expect(overlay).toBeHidden();
  await expect(page.locator('#deadline-plan-panel .smart-task-actions')).toBeVisible();
});

test('capture smart task actions and composer in both host themes', async ({ browser, browserName, baseURL }) => {
  test.skip(process.env.PELS_CAPTURE_SMART_TASK_UX !== '1' || browserName !== 'chromium');
  const outDir = process.env.PELS_SMART_TASK_UX_OUT_DIR ?? '/tmp/pels-smart-task-ux';
  fs.mkdirSync(outDir, { recursive: true });
  for (const width of [320, 480]) {
    for (const mobile of [false, true]) {
      const suffix = `${width}-${mobile ? 'dark' : 'light'}`;
      const context = await browser.newContext({
        baseURL, viewport: { width, height: 900 },
        ...(mobile ? { isMobile: true, hasTouch: true } : {}),
      });
      try {
        const page = await context.newPage();
        await injectHomeyHostCss(page);
        await installCreateStub(page);
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.getByRole('tab', { name: 'Smart tasks' }).click();
        await page.getByRole('button', { name: 'New smart task' }).click();
        const composer = page.locator('#smart-task-create-root');
        await composer.getByRole('button', { name: /Connected 300/ }).click();
        await composer.locator('.smart-task-create__form').screenshot({ path: path.join(outDir, `create-${suffix}.png`) });
        await composer.getByRole('button', { name: 'Preview task' }).click();
        await composer.locator('.smart-task-create__form').screenshot({ path: path.join(outDir, `preview-${suffix}.png`) });
        await composer.getByRole('button', { name: 'Edit goal' }).click();
        await composer.getByRole('button', { name: 'Choose another device' }).click();
        await composer.getByRole('button', { name: /Pool Pump/ }).click();
        await composer.getByRole('button', { name: 'Preview task' }).click();
        await composer.locator('.smart-task-create__form').screenshot({
          path: path.join(outDir, `preview-binary-${suffix}.png`),
        });

        const devicePage = await context.newPage();
        await injectHomeyHostCss(devicePage);
        await installCreateStub(devicePage);
        await openDevice(devicePage);
        const addBox = devicePage.locator('#device-detail-smart-task');
        await expect(addBox.getByRole('button', { name: 'Add smart task' })).toBeVisible();
        await addBox.scrollIntoViewIfNeeded();
        expect(await addBox.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(100);
        await addBox.screenshot({ path: path.join(outDir, `device-add-${suffix}.png`) });
        await devicePage.screenshot({ path: path.join(outDir, `device-add-page-${suffix}.png`) });

        const detail = await context.newPage();
        await injectHomeyHostCss(detail);
        await detail.goto('/?page=deadline-plan&deviceId=dev_connected300', { waitUntil: 'domcontentloaded' });
        await expect(detail.locator('.smart-task-actions')).toBeVisible();
        await detail.screenshot({ path: path.join(outDir, `detail-${suffix}.png`) });
        const afterTaskCard = detail.locator('.smart-task-after-task');
        await afterTaskCard.scrollIntoViewIfNeeded();
        await afterTaskCard.screenshot({ path: path.join(outDir, `detail-after-task-${suffix}.png`) });

        const activeDevice = await context.newPage();
        await injectHomeyHostCss(activeDevice);
        await openDevice(activeDevice);
        const activeBox = activeDevice.locator('#device-detail-smart-task');
        await expect(activeBox.getByRole('button', { name: 'View task' })).toBeVisible();
        await activeBox.scrollIntoViewIfNeeded();
        await activeBox.screenshot({ path: path.join(outDir, `device-active-${suffix}.png`) });
        await activeDevice.screenshot({ path: path.join(outDir, `device-active-page-${suffix}.png`) });
        const setup = activeDevice.locator('#device-detail-setup-disclosure');
        await setup.locator('summary').click();
        const powerLimitRows = activeDevice.locator('#device-detail-controllable-row');
        await powerLimitRows.scrollIntoViewIfNeeded();
        await activeDevice.screenshot({ path: path.join(outDir, `device-setup-${suffix}.png`) });
      } finally {
        await context.close();
      }
    }
  }
});
