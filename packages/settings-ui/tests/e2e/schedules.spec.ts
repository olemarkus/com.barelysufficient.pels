import type { Schedule } from '../../../contracts/src/schedules';
import { expect, renderTest as test, type Page } from './fixtures/test';

const installSchedules = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    type Stub = { getSetting(key: string): unknown };
    const windowWithHomey = window as unknown as {
      Homey: { __stub: Stub };
      __PELS_HOMEY_STUB__: unknown;
    };
    const ids = ['night', 'morning', 'water'];
    const base: Record<string, unknown> = {
      'schedule.night': {
        id: 'night', name: 'Night mode', enabled: true, at: '22:00',
        repeat: { type: 'weekly', days: [1, 2, 3, 4, 5] }, condition: { type: 'include', modes: ['Home'] },
        action: { type: 'mode', mode: 'Night' },
      },
      'schedule.morning': {
        id: 'morning', name: 'Morning mode', enabled: false, at: '06:00',
        repeat: { type: 'weekly', days: [1, 2, 3, 4, 5] }, condition: { type: 'any' },
        action: { type: 'mode', mode: 'Home' },
      },
      'schedule.water': {
        id: 'water', name: 'Overnight hot water', enabled: true, at: '21:00',
        repeat: { type: 'weekly', days: [1, 2, 3, 4, 5, 6, 7] }, condition: { type: 'any' },
        action: { type: 'task', task: {
          deviceId: 'heater', kind: 'temperature', target: 65, readyByLocalTime: '06:00',
          exemptFromBudget: false, limitLowerPriorityDevices: false, pauseLowerPriorityDevices: false,
        } },
      },
    };
    // Emulate the Homey's durable settings across browser reload; production
    // schedules still read and write the Homey bridge, never browser storage.
    let retained: Record<string, unknown> = {};
    try { retained = JSON.parse(localStorage.getItem('e2e.schedule-homey-settings') ?? '{}') as Record<string, unknown>; } catch { /* Fresh fixture. */ }
    const settings = { ...base, ...retained };
    const read = () => {
      const stub = windowWithHomey.Homey.__stub;
      const controls = {
        modeChangesEnabled: stub.getSetting('schedule_modes_enabled') !== false,
        disabledTaskDeviceIds: stub.getSetting('schedule_task_enabled.heater') === false ? ['heater'] : [],
      };
      const entries = ids.flatMap((id) => {
        const raw = stub.getSetting(`schedule.${id}`);
        if (!raw || (raw as { deleted?: boolean }).deleted) return [];
        const schedule = raw as Schedule;
        const paused = schedule.action.type === 'mode'
          ? !controls.modeChangesEnabled
          : controls.disabledTaskDeviceIds.includes(schedule.action.task.deviceId);
        const state = !schedule.enabled ? 'off' : paused ? 'paused' : 'on';
        return [{ schedule, modeReferences: [], state,
          reason: !schedule.enabled ? 'No future actions.' : paused ? schedule.action.type === 'mode'
            ? 'Scheduled mode changes are off.' : 'Scheduled tasks for Water heater are off.' : '',
          nextAtMs: state === 'on' ? Date.now() + 3_600_000 : null,
          nextLabel: state === 'on' ? `Tomorrow ${schedule.at}` : '', lastResult: '',
        }];
      });
      return { ok: true, data: { timeZone: 'Europe/Oslo', modes: ['Home', 'Away', 'Night'], controls, entries } };
    };
    windowWithHomey.__PELS_HOMEY_STUB__ = {
      settings,
      apiHandlers: {
        'GET /ui_devices': () => ({
          devices: [], inverterDevices: [], continuousBatteryPlans: {},
          chargerPhasePresets: { state: 'resolved', presets: {} }, schedules: read(),
        }),
        'GET /ui_smart_task_devices': () => ({ state: 'ready', devices: [{
          deviceId: 'heater', deviceName: 'Water heater', kind: 'temperature', group: 'heating',
          unitSymbol: '°C', goalMin: 30, goalMax: 75, goalStep: 0.5, defaultGoal: 65, currentValue: 40,
          supportsLimitLowerPriority: false, offersQuickTargets: false,
        }] }),
      },
    };
    window.addEventListener('beforeunload', () => {
      const stub = windowWithHomey.Homey.__stub;
      const keys = [...ids.map((id) => `schedule.${id}`), 'schedule_modes_enabled', 'schedule_task_enabled.heater'];
      const values = Object.fromEntries(keys.map((key) => [key, stub.getSetting(key)]));
      localStorage.setItem('e2e.schedule-homey-settings', JSON.stringify(values));
    });
  });
};

const readStored = (page: Page, key: string): Promise<unknown> => page.evaluate((settingKey) => (
  (window as unknown as { Homey: { __stub: { getSetting(key: string): unknown } } }).Homey.__stub.getSetting(settingKey)
), key);

for (const width of [320, 480]) {
  for (const mobile of [false, true]) {
    test.describe(`${width}px ${mobile ? 'dark' : 'light'} schedule controls`, () => {
      test.use({ viewport: { width, height: mobile ? 3600 : 1800 }, isMobile: mobile, hasTouch: mobile });
      test.skip(({ browserName }) => mobile && browserName === 'firefox', 'Touch theme capture uses Chromium');

      test('keeps row and group switches clear and saves an overnight task with a mode condition', async ({ page }, testInfo) => {
        await installSchedules(page);
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.getByRole('tab', { name: 'Settings', exact: true }).click();
        await page.locator('.settings-nav-card[data-settings-target="schedules"]').click();
        const panel = page.locator('#schedules-panel');
        await expect(panel.getByRole('heading', { name: 'Schedules', exact: true })).toBeVisible();
        const historyLength = await page.evaluate(() => window.history.length);
        await panel.getByRole('button', { name: 'Back to Settings', exact: true }).click();
        await expect(page.locator('#settings-panel')).toBeVisible();
        expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
        await page.goForward();
        await expect(panel.getByRole('heading', { name: 'Schedules', exact: true })).toBeVisible();
        const night = panel.locator('[data-schedule-id="night"]');
        const morning = panel.locator('[data-schedule-id="morning"]');
        await expect(night.locator('.schedule-row__state')).toHaveText('On');
        await expect(night).toContainText('Only in Home');
        const order = await panel.locator('[data-schedule-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-schedule-id')));

        await night.getByRole('switch', { name: 'Night mode schedule', exact: true }).click();
        await expect(night.locator('.schedule-row__state')).toHaveText('Off');
        await expect.poll(() => readStored(page, 'schedule.night')).toMatchObject({ enabled: false });
        expect(await panel.locator('[data-schedule-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-schedule-id')))).toEqual(order);
        await night.getByRole('switch', { name: 'Night mode schedule', exact: true }).click();
        await expect(night.locator('.schedule-row__state')).toHaveText('On');

        const modes = panel.getByRole('switch', { name: 'Scheduled mode changes', exact: true });
        await modes.click();
        await expect(night.locator('.schedule-row__state')).toHaveText('Paused');
        await expect(night).toContainText('Scheduled mode changes are off.');
        await expect(morning.locator('.schedule-row__state')).toHaveText('Off');
        await page.screenshot({ path: testInfo.outputPath(`schedules-list-${width}-${mobile ? 'dark' : 'light'}.png`), fullPage: !mobile });
        const layout = await panel.evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
        expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width);

        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(night.locator('.schedule-row__state')).toHaveText('Paused');
        await modes.click();
        await expect(night.locator('.schedule-row__state')).toHaveText('On');
        await expect(morning.locator('.schedule-row__state')).toHaveText('Off');

        await panel.locator('[data-schedule-id="water"]').getByRole('button', { name: 'Edit', exact: true }).click();
        await expect(panel.getByRole('heading', { name: 'Edit schedule', exact: true })).toBeVisible();
        await expect(panel).toContainText('ready by 06:00 the following day');
        await panel.getByRole('combobox', { name: 'Repeat', exact: true }).click();
        await page.getByRole('option', { name: 'Choose days', exact: true }).click();
        const dayTarget = await panel.getByRole('button', { name: 'Mon', exact: true }).boundingBox();
        expect(dayTarget).not.toBeNull();
        expect(dayTarget?.height).toBeGreaterThanOrEqual(48);
        await panel.getByRole('combobox', { name: 'Mode condition', exact: true }).click();
        await page.getByRole('option', { name: 'Only these modes', exact: true }).click();
        await panel.getByRole('checkbox', { name: 'Home', exact: true }).click();
        await panel.getByRole('textbox', { name: 'Schedule name', exact: true }).fill('Morning hot water');
        await panel.locator('summary').filter({ hasText: 'Extra permissions' }).click();
        await panel.getByRole('switch', { name: 'May go over daily budget', exact: true }).click();
        const targetField = panel.getByRole('spinbutton', { name: 'Target (°C)', exact: true });
        await targetField.fill('70');
        await panel.getByRole('button', { name: 'Create Smart task', exact: true }).click();
        await expect(targetField).toHaveValue('70');
        await expect(panel.getByRole('switch', { name: 'May go over daily budget', exact: true })).toBeChecked();
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: testInfo.outputPath(`schedules-editor-${width}-${mobile ? 'dark' : 'light'}.png`), fullPage: !mobile });
        const editorLayout = await panel.evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
        expect(editorLayout.scrollWidth, JSON.stringify(editorLayout)).toBeLessThanOrEqual(editorLayout.width);
        await panel.getByRole('button', { name: 'Save schedule', exact: true }).click();
        await expect(panel.getByRole('heading', { name: 'Schedules', exact: true })).toBeVisible();
        await expect.poll(() => readStored(page, 'schedule.water')).toMatchObject({
          id: 'water', name: 'Morning hot water', condition: { type: 'include', modes: ['Home'] },
          action: { type: 'task', task: { target: 70, exemptFromBudget: true, readyByLocalTime: '06:00' } },
        });
      });
    });
  }
}
