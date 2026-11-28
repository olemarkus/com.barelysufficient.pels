import type { ModePreparationPlan, SchedulesSnapshot } from '../../../contracts/src/schedules';
import { expect, renderTest as test } from './fixtures/test';

test('shows mode preparation beside Smart tasks without delaying the task list', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.addInitScript(() => {
    const stubWindow = window as unknown as {
      __PELS_HOMEY_STUB__: unknown;
      finishModePreparationRead?: () => void;
    };
    const plan: ModePreparationPlan = {
      state: 'ready', scheduleId: 'morning', scheduleName: 'Morning heat', currentMode: 'Night',
      destinationMode: 'Home', atMs: Date.UTC(2026, 10, 23, 5), devices: [
        { deviceId: 'den', name: 'Den heater', fromC: 17, targetC: 21, state: 'estimated',
          startAtMs: Date.UTC(2026, 10, 23, 3, 30) },
        { deviceId: 'dev_heatpump', name: 'Heat pump', fromC: 17, targetC: 21, state: 'smart_task' },
        { deviceId: 'bedroom', name: 'Bedroom heater', fromC: 17, targetC: 20, state: 'override' },
        { deviceId: 'hall', name: 'Hall heater', fromC: 18, targetC: 22, state: 'preparing' },
      ],
    };
    const schedules: SchedulesSnapshot = {
      timeZone: 'Europe/Oslo', modes: ['Home', 'Night'],
      controls: { modeChangesEnabled: true, disabledTaskDeviceIds: [] },
      entries: [{
        schedule: {
          id: 'morning', name: 'Morning heat', enabled: true, at: '06:00',
          repeat: { type: 'weekly', days: [1] }, condition: { type: 'any' },
          action: { type: 'mode', mode: 'Home', prepare: true },
        },
        state: 'on', reason: '', modeReferences: [], nextAtMs: Date.UTC(2026, 10, 23, 5),
        nextLabel: 'Mon 23 Nov 06:00', lastResult: '', lastLabel: '',
      }],
    };
    let settled = false;
    stubWindow.__PELS_HOMEY_STUB__ = {
      apiHandlers: {
        'GET /ui_devices': (_: unknown, query: Record<string, unknown>) => {
          const devices = { devices: [], inverterDevices: [], continuousBatteryPlans: {} };
          if (query.modePreparation !== 'next') return { ...devices, schedules: { ok: true, data: schedules } };
          const preview = { schedules: { ok: true, data: { ...schedules, preparationPlan: plan } } };
          if (settled) return preview;
          return new Promise((resolve) => {
            stubWindow.finishModePreparationRead = () => {
              settled = true;
              resolve(preview);
            };
          });
        },
      },
    };
  });

  await page.goto('/?page=deadlines', { waitUntil: 'domcontentloaded' });
  const pageHeading = page.locator('#deadlines-list-root h2');
  const plan = page.getByRole('region', { name: 'Getting ready for Home' });
  await expect(pageHeading).toBeVisible();
  await expect(page.locator('#deadlines-list-root [data-state="loading"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Past tasks' })).toBeVisible();
  await expect(plan).toHaveCount(0);
  await page.waitForFunction(() => 'finishModePreparationRead' in window);
  await page.evaluate(() => (window as unknown as { finishModePreparationRead(): void }).finishModePreparationRead());

  await expect(plan).toContainText(/Morning heat changes the mode from Night to Home at Mon,? 23 Nov 06:00\./);
  await expect(plan).toContainText('Starts heating around 04:30');
  await expect(plan).toContainText('Night 17.0 °C → Home 21.0 °C');
  await expect(plan).toContainText('Its Smart task comes first');
  await expect(plan).toContainText('Its temperature override comes first');
  await expect(plan).toContainText('Using the Home temperature now');
  await expect(plan.getByRole('button', { name: 'Open Bedroom heater' })).toBeVisible();
  expect(await plan.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await plan.screenshot({ path: testInfo.outputPath('mode-preparation-320.png') });
  await page.setViewportSize({ width: 480, height: 900 });
  await plan.screenshot({ path: testInfo.outputPath('mode-preparation-480.png') });

  await plan.getByRole('link', { name: 'View Smart task for Heat pump' }).click();
  await expect(page).toHaveURL(/page=deadline-plan&deviceId=dev_heatpump/);
  await page.goBack();
  await expect(plan).toBeVisible();
  await plan.getByRole('button', { name: 'View mode schedule' }).click();
  await expect(page).toHaveURL((url) => (
    url.searchParams.get('page') === 'settings/schedules' && url.searchParams.get('schedule') === 'morning'
  ));
  await expect(page.locator('#schedules-panel').getByRole('textbox', { name: 'Schedule name' })).toHaveValue('Morning heat');
});

test('a prepared mode schedule row opens its plan', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.addInitScript(() => {
    const schedules: SchedulesSnapshot = {
      timeZone: 'Europe/Oslo', modes: ['Home', 'Night'],
      controls: { modeChangesEnabled: true, disabledTaskDeviceIds: [] },
      entries: [{
        schedule: {
          id: 'morning', name: 'Morning heat', enabled: true, at: '06:00',
          repeat: { type: 'weekly', days: [1] }, condition: { type: 'any' },
          action: { type: 'mode', mode: 'Home', prepare: true },
        },
        state: 'on', reason: '', modeReferences: [], nextAtMs: Date.UTC(2026, 10, 23, 5),
        nextLabel: 'Mon 23 Nov 06:00', lastResult: '', lastLabel: '',
      }],
    };
    const plan: ModePreparationPlan = {
      state: 'ready', scheduleId: 'morning', scheduleName: 'Morning heat', currentMode: 'Night',
      destinationMode: 'Home', atMs: Date.UTC(2026, 10, 23, 5), devices: [],
    };
    (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
      apiHandlers: {
        'GET /ui_devices': (_: unknown, query: Record<string, unknown>) => ({
          devices: [], inverterDevices: [], continuousBatteryPlans: {},
          schedules: { ok: true, data: query.modePreparation === 'next' ? { ...schedules, preparationPlan: plan } : schedules },
        }),
      },
    };
  });

  await page.goto('/?page=settings/schedules', { waitUntil: 'domcontentloaded' });
  const row = page.locator('#schedules-panel [data-schedule-id="morning"]');
  await expect(row).toContainText('Set mode to Home · Prepare devices');
  await row.getByRole('button', { name: 'View plan' }).click();
  const panel = page.getByRole('region', { name: 'Getting ready for Home' });
  await expect(panel).toContainText('No heater needs to start early.');
  await expect(panel).toContainText('its Home temperature is higher than its Night temperature');
});
