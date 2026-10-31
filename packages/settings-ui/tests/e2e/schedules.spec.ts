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
          nextLabel: state === 'on' ? `Tomorrow ${schedule.at}` : '', lastResult: '', lastLabel: '',
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
          supportsLimitLowerPriority: false, offersQuickTargets: false, otherGoals: [],
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

test('changing an unavailable battery target stays in the editor until explicitly saved', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await installSchedules(page);
  await page.goto('/?page=settings/schedules', { waitUntil: 'domcontentloaded' });
  const panel = page.locator('#schedules-panel');
  await expect(panel.getByRole('heading', { name: 'Schedules', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const stub = (window as unknown as { Homey: { __stub: {
      setSetting(key: string, value: unknown): void;
      setApiHandler(key: string, handler: () => unknown): void;
      emitSettingsSet(key: string): void;
    } } }).Homey.__stub;
    stub.setSetting('schedule.water', {
      id: 'water', name: 'Charge overnight', enabled: true, at: '21:00',
      repeat: { type: 'weekly', days: [1, 2, 3, 4, 5, 6, 7] }, condition: { type: 'any' },
      action: { type: 'task', task: {
        deviceId: 'charger', kind: 'ev_soc', target: 80, readyByLocalTime: '07:00',
        exemptFromBudget: true, limitLowerPriorityDevices: false, pauseLowerPriorityDevices: false,
      } },
    });
    stub.setApiHandler('GET /ui_smart_task_devices', () => ({ state: 'ready', devices: [{
      deviceId: 'charger', deviceName: 'Charger', kind: 'ev_soc', group: 'ev_charger',
      unitSymbol: '%', goalMin: 1, goalMax: 100, goalStep: 1, defaultGoal: 80, currentValue: 40,
      supportsLimitLowerPriority: false, offersQuickTargets: false, otherGoals: [],
    }] }));
    stub.emitSettingsSet('schedule.water');
  });
  const row = panel.locator('[data-schedule-id="water"]');
  await expect(row).toContainText('Charge overnight');
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  const batteryTarget = panel.getByRole('spinbutton', { name: 'Target (%)', exact: true });
  await expect(batteryTarget).toHaveValue('80');
  await expect(batteryTarget).toBeEnabled();
  await page.evaluate(() => {
    const testWindow = window as unknown as { Homey: { __stub: {
      setApiHandler(key: string, handler: () => unknown): void;
      emitSettingsSet(key: string): void;
    } }; __scheduleSubmitCount: number };
    testWindow.Homey.__stub.setApiHandler('GET /ui_smart_task_devices', () => ({ state: 'ready', devices: [{
      deviceId: 'charger', deviceName: 'Charger', kind: 'energy', group: 'ev_charger',
      unitSymbol: 'kWh', goalMin: 0.1, goalMax: 100, goalStep: 0.1, defaultGoal: 20, currentValue: null,
      supportsLimitLowerPriority: false, offersQuickTargets: false, otherGoals: [],
    }] }));
    testWindow.__scheduleSubmitCount = 0;
    document.querySelector('#schedules-panel form')!.addEventListener('submit', () => {
      testWindow.__scheduleSubmitCount += 1;
    });
    testWindow.Homey.__stub.emitSettingsSet('schedule.water');
  });
  await expect(batteryTarget).toBeDisabled();
  await expect(batteryTarget).toHaveValue('80');
  const before = await readStored(page, 'schedule.water');
  await panel.getByRole('button', { name: 'Use energy target', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Edit schedule', exact: true })).toBeVisible();
  const energyTarget = panel.getByRole('spinbutton', { name: 'Target (kWh)', exact: true });
  await expect(energyTarget).toHaveValue('20');
  await expect(energyTarget).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { __scheduleSubmitCount: number })
    .__scheduleSubmitCount)).toBe(0);
  expect(await readStored(page, 'schedule.water')).toEqual(before);
  await energyTarget.fill('25');
  await panel.getByRole('button', { name: 'Save schedule', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Schedules', exact: true })).toBeVisible();
  await expect.poll(() => readStored(page, 'schedule.water')).toMatchObject({
    action: { type: 'task', task: { kind: 'energy', target: 25 } },
  });
  expect(errors).toEqual([]);
});

test('keeps a supported energy target editable when the picker defaults to battery', async ({ page }) => {
  await installSchedules(page);
  await page.goto('/?page=settings/schedules');
  const panel = page.locator('#schedules-panel');
  await expect(panel.getByRole('heading', { name: 'Schedules', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const stub = (window as unknown as { Homey: { __stub: {
      setSetting(key: string, value: unknown): void;
      setApiHandler(key: string, handler: () => unknown): void;
      emitSettingsSet(key: string): void;
    } } }).Homey.__stub;
    stub.setSetting('schedule.water', {
      id: 'water', name: 'Charge overnight', enabled: true, at: '21:00',
      repeat: { type: 'weekly', days: [1, 2, 3, 4, 5, 6, 7] }, condition: { type: 'any' },
      action: { type: 'task', task: {
        deviceId: 'charger', kind: 'energy', target: 150, readyByLocalTime: '07:00',
        exemptFromBudget: true, limitLowerPriorityDevices: false, pauseLowerPriorityDevices: false,
      } },
    });
    stub.setApiHandler('GET /ui_smart_task_devices', () => ({ state: 'ready', devices: [{
      deviceId: 'charger', deviceName: 'Charger', kind: 'ev_soc', group: 'ev_charger',
      unitSymbol: '%', goalMin: 1, goalMax: 100, goalStep: 1, defaultGoal: 80, currentValue: 40,
      supportsLimitLowerPriority: false, offersQuickTargets: false,
      otherGoals: [{ kind: 'energy', unitSymbol: 'kWh', goalMin: 0.1, goalMax: 200, goalStep: 0.1 }],
    }] }));
    stub.emitSettingsSet('schedule.water');
  });
  const row = panel.locator('[data-schedule-id="water"]');
  await expect(row).toContainText('Charge overnight');
  await expect(row).toContainText('Extra permissions: May go over daily budget');
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  const target = panel.getByRole('spinbutton', { name: 'Target (kWh)', exact: true });
  await expect(target).toBeEnabled();
  await expect(target).toHaveValue('150');
  await expect(panel.getByRole('region', { name: 'Saved schedule status', exact: true })).toContainText('Saved schedule: On');
  const permissions = panel.locator('details.smart-task-edit__permissions');
  await expect(permissions).toHaveAttribute('open', '');
  await permissions.locator('summary').click();
  await panel.getByRole('textbox', { name: 'Schedule name', exact: true }).fill('Retained energy');
  await expect(permissions).not.toHaveAttribute('open');
  await expect(panel.locator('.smart-task-edit__permissions-granted')).toContainText('May go over daily budget');
  await target.fill('180');
  await panel.getByRole('button', { name: 'Save schedule', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Schedules', exact: true })).toBeVisible();
  await expect.poll(() => readStored(page, 'schedule.water')).toMatchObject({
    name: 'Retained energy', action: { type: 'task', task: { kind: 'energy', target: 180 } },
  });
});

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

        await night.getByRole('button', { name: 'Edit', exact: true }).click();
        await panel.getByRole('combobox', { name: 'Set mode to', exact: true }).click();
        await page.getByRole('option', { name: 'Home', exact: true }).click();
        await expect(panel.getByRole('combobox', { name: 'Set mode to', exact: true })).toContainText('Home');
        await panel.getByRole('button', { name: 'Cancel', exact: true }).click();

        await panel.locator('[data-schedule-id="water"]').getByRole('button', { name: 'Edit', exact: true }).click();
        await expect(panel.getByRole('heading', { name: 'Edit schedule', exact: true })).toBeVisible();
        await expect(panel).toContainText('ready by 06:00 the following day');
        await panel.getByRole('combobox', { name: 'Task device', exact: true }).click();
        await page.getByRole('option', { name: 'Water heater', exact: true }).click();
        await panel.getByRole('combobox', { name: 'Repeat', exact: true }).click();
        await page.getByRole('option', { name: 'Choose days', exact: true }).click();
        const dayTarget = await panel.getByRole('button', { name: 'Mon', exact: true }).boundingBox();
        expect(dayTarget).not.toBeNull();
        expect(dayTarget?.height).toBeGreaterThanOrEqual(48);
        await panel.getByRole('button', { name: 'Sun', exact: true }).click();
        const selectedDay = panel.locator('.schedule-days md-outlined-button').nth(0);
        const unselectedDay = panel.locator('.schedule-days md-outlined-button').nth(6);
        expect(await selectedDay.evaluate((element) => getComputedStyle(element).backgroundColor))
          .not.toBe(await unselectedDay.evaluate((element) => getComputedStyle(element).backgroundColor));
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
          repeat: { type: 'weekly', days: [1, 2, 3, 4, 5, 6] },
          action: { type: 'task', task: { target: 70, exemptFromBudget: true, readyByLocalTime: '06:00' } },
        });
      });
    });
  }
}
