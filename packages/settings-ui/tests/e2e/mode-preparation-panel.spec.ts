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
  const plan = page.getByRole('region', { name: 'Mode preparation' });
  await expect(pageHeading).toBeVisible();
  await expect(page.locator('#deadlines-list-root [data-state="loading"]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Past tasks' })).toBeVisible();
  await expect(plan).toHaveCount(0);
  await page.waitForFunction(() => 'finishModePreparationRead' in window);
  await page.evaluate(() => (window as unknown as { finishModePreparationRead(): void }).finishModePreparationRead());

  await expect(plan).toContainText(/Night to Home · Mon,? 23 Nov 06:00/);
  await expect(plan).toContainText(/Estimated early target from Mon,? 23 Nov 04:30/);
  await expect(plan).toContainText('Mode target from 17.0 °C to 21.0 °C');
  await expect(plan).toContainText('Smart task currently takes precedence');
  await expect(plan).toContainText('Temperature override currently takes precedence');
  await expect(plan).toContainText('Early target planned');
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
