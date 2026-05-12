import { expect, test, type Page } from './fixtures/test';

const openDevices = async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('[data-settings-target="devices"]').click();
  await expect(page.locator('#devices-panel')).toBeVisible();
};

const openDeviceDetail = async (page: Page, deviceId: string) => {
  await openDevices(page);
  const row = page.locator(`#device-list .device-row[data-device-id="${deviceId}"]`);
  await expect(row).toBeVisible();
  await row.locator('.device-row__name').click();
  await expect(page.locator('#device-detail-overlay')).toBeVisible();
};

const readHomeySetting = async <T,>(page: Page, key: string): Promise<T> => page.evaluate(
  (settingKey) => new Promise<unknown>((resolve, reject) => {
    const homey = (window as unknown as {
      Homey: {
        get: (key: string, callback: (error: Error | null, value?: unknown) => void) => void;
      };
    }).Homey;
    homey.get(settingKey, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  }),
  key,
) as Promise<T>;

// md-filled-text-field / md-filled-select are custom elements; Playwright's
// .fill() / .selectOption() don't reach the inner native control. Set the
// host property and dispatch a `change` event the same way our application
// listeners do.
const setMdValue = async (page: Page, selector: string, value: string) => {
  await page.locator(selector).evaluate((el, v) => {
    (el as HTMLElement & { value: string }).value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
};

// md-switch exposes `selected` instead of `checked`; flip it the same way.
const setMdSwitch = async (page: Page, selector: string, selected: boolean) => {
  await page.locator(selector).evaluate((el, v) => {
    (el as HTMLElement & { selected: boolean }).selected = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, selected);
};

const readMdSwitchSelected = (page: Page, selector: string) => page.locator(selector)
  .evaluate((el) => (el as HTMLElement & { selected: boolean }).selected);

const collectConsoleErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  return errors;
};

test.describe('Device detail panel', () => {
  test('opens and closes via back button, overlay backdrop, and Escape', async ({ page }) => {
    await openDeviceDetail(page, 'dev_heatpump');
    await expect(page.locator('#device-detail-title')).toHaveText('Living Room Heat Pump');

    // Close via back button.
    await page.locator('#device-detail-close').click();
    await expect(page.locator('#device-detail-overlay')).toBeHidden();

    // Close via Escape.
    await openDeviceDetail(page, 'dev_heatpump');
    await page.keyboard.press('Escape');
    await expect(page.locator('#device-detail-overlay')).toBeHidden();

    // Close via overlay backdrop. At 480px the slide-panel fills the
    // viewport so there's no visible backdrop region to click — dispatch
    // a synthetic click whose event.target is the overlay itself, which
    // is the exact contract the handler at index.ts:299 enforces
    // (`event.target === deviceDetailOverlay`).
    await openDeviceDetail(page, 'dev_heatpump');
    const overlay = page.locator('#device-detail-overlay');
    await overlay.evaluate((el) => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect(overlay).toBeHidden();
  });

  test('Temperature per mode inputs persist for each mode', async ({ page }) => {
    await openDeviceDetail(page, 'dev_heatpump');
    const modeSection = page.locator('#device-detail-modes-section');
    await expect(modeSection).toBeVisible();

    const rows = modeSection.locator('.detail-mode-row');
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const row = rows.nth(i);
      const mode = await row.getAttribute('data-mode');
      expect(mode).toBeTruthy();
      await setMdValue(page, `[data-mode="${mode}"] md-filled-text-field.detail-mode-temp`, '19');
      // modes.ts persists mode_device_targets through debouncedSetSetting
      // (300ms delay); poll until the write lands.
      await expect.poll(async () => {
        const stored = await readHomeySetting<Record<string, Record<string, number>>>(
          page,
          'mode_device_targets',
        );
        return stored?.[mode ?? '']?.dev_heatpump;
      }, { timeout: 3000 }).toBe(19);
    }
  });

  test('Cheap/expensive delta inputs persist', async ({ page }) => {
    await openDeviceDetail(page, 'dev_heatpump');

    await setMdValue(page, '#device-detail-cheap-delta', '3');
    await setMdValue(page, '#device-detail-expensive-delta', '-2.5');

    await expect.poll(async () => {
      const settings = await readHomeySetting<Record<string, { cheapDelta?: number; expensiveDelta?: number }>>(
        page,
        'price_optimization_settings',
      );
      return settings?.dev_heatpump;
    }, { timeout: 3000 }).toMatchObject({ cheapDelta: 3, expensiveDelta: -2.5 });
  });

  test('Shedding segmented control mirrors hidden select and toggles conditional rows', async ({ page }) => {
    await openDeviceDetail(page, 'dev_heatpump');

    const segmented = page.locator('#device-detail-overshoot-segmented');
    const hiddenSelect = page.locator('#device-detail-overshoot');
    const tempRow = page.locator('#device-detail-overshoot-temp-row');
    const stepRow = page.locator('#device-detail-overshoot-step-row');

    await expect(segmented).toBeVisible();
    const options = segmented.locator('button.segmented__option:not([hidden])');
    await expect(options.first()).toBeVisible();
    expect(await options.count()).toBeGreaterThanOrEqual(2);

    await options.filter({ hasText: 'Turn off' }).click();
    await expect(hiddenSelect).toHaveValue('turn_off');
    await expect(tempRow).toBeHidden();
    await expect(stepRow).toBeHidden();

    await options.filter({ hasText: 'Set to temperature' }).click();
    await expect(hiddenSelect).toHaveValue('set_temperature');
    await expect(tempRow).toBeVisible();
    await setMdValue(page, '#device-detail-overshoot-temp', '12');

    await expect.poll(async () => {
      const behaviors = await readHomeySetting<Record<string, { action?: string; temperature?: number }>>(
        page,
        'overshoot_behaviors',
      );
      return behaviors?.dev_heatpump;
    }, { timeout: 3000 }).toMatchObject({ action: 'set_temperature', temperature: 12 });
  });

  test('Stepped load section renders step list and add/reset draft controls work', async ({ page }) => {
    await openDeviceDetail(page, 'dev_zaptec');

    const section = page.locator('#device-detail-stepped-section');
    await expect(section).toBeVisible();

    // dev_zaptec is a stepped_load device — the step rows from the saved profile must be visible.
    const steps = page.locator('#device-detail-stepped-steps > *');
    await expect(steps.first()).toBeVisible();
    const initialStepCount = await steps.count();
    expect(initialStepCount).toBeGreaterThan(0);

    await page.locator('#device-detail-stepped-add-step').click();
    await expect(page.locator('#device-detail-stepped-steps > *')).toHaveCount(initialStepCount + 1);

    await page.locator('#device-detail-stepped-reset').click();
    await expect(page.locator('#device-detail-stepped-steps > *')).toHaveCount(initialStepCount);

    // The Save profile button is reachable and enabled for the draft.
    await expect(page.locator('#device-detail-stepped-save')).toBeEnabled();
  });

  test('Setup section toggles persist managed / controllable / price / budget exempt + control model', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page);
    await openDeviceDetail(page, 'dev_heatpump');

    await page.locator('#device-detail-setup-section summary').click();

    const initiallyExempt = await readMdSwitchSelected(page, '#device-detail-budget-exempt');
    await setMdSwitch(page, '#device-detail-budget-exempt', !initiallyExempt);
    await expect.poll(async () => {
      const map = await readHomeySetting<Record<string, boolean>>(page, 'budget_exempt_devices');
      return Boolean(map?.dev_heatpump);
    }, { timeout: 3000 }).toBe(!initiallyExempt);

    // Capacity-based control: toggle off then on.
    await setMdSwitch(page, '#device-detail-controllable', false);
    await expect.poll(async () => {
      const map = await readHomeySetting<Record<string, boolean>>(page, 'controllable_devices');
      return map?.dev_heatpump;
    }, { timeout: 3000 }).toBe(false);
    await setMdSwitch(page, '#device-detail-controllable', true);
    await expect.poll(async () => {
      const map = await readHomeySetting<Record<string, boolean>>(page, 'controllable_devices');
      return map?.dev_heatpump;
    }, { timeout: 3000 }).toBe(true);

    // Price-based control: enabling persists into price_optimization_settings.
    if (!(await readMdSwitchSelected(page, '#device-detail-price-opt'))) {
      await setMdSwitch(page, '#device-detail-price-opt', true);
      await expect.poll(async () => {
        const settings = await readHomeySetting<Record<string, { enabled?: boolean }>>(
          page,
          'price_optimization_settings',
        );
        return settings?.dev_heatpump?.enabled;
      }, { timeout: 3000 }).toBe(true);
    }

    // Managed toggle: disabling persists into managed_devices.
    await setMdSwitch(page, '#device-detail-managed', false);
    await expect.poll(async () => {
      const map = await readHomeySetting<Record<string, boolean>>(page, 'managed_devices');
      return map?.dev_heatpump;
    }, { timeout: 3000 }).toBe(false);
    await setMdSwitch(page, '#device-detail-managed', true);

    // Control model select responds to changes. Selecting "continuous"
    // writes a device_target_power_configs entry (see controlMode.ts +
    // targetPowerConfig.ts); it does NOT write to device_control_profiles,
    // so we assert the select reflects the new value and that the target
    // power config was created.
    const controlModel = page.locator('#device-detail-control-model');
    await expect(controlModel).toBeVisible();
    await setMdValue(page, '#device-detail-control-model', 'continuous');
    await expect.poll(async () => {
      const value = await controlModel.evaluate((el) => (el as HTMLElement & { value: string }).value);
      return value;
    }, { timeout: 3000 }).toBe('continuous');
    await expect.poll(async () => {
      const configs = await readHomeySetting<Record<string, { enabled?: boolean; preset?: string }>>(
        page,
        'device_target_power_configs',
      );
      return configs?.dev_heatpump;
    }, { timeout: 3000 }).toMatchObject({ enabled: true });

    expect(consoleErrors).toEqual([]);
  });

  test('Diagnostics disclosure opens and renders status content', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page);
    await openDeviceDetail(page, 'dev_heatpump');

    const disclosure = page.locator('#device-detail-diagnostics-disclosure');
    const status = page.locator('#device-detail-diagnostics-status');

    // Before opening, the disclosure body is not rendered visibly.
    await expect(disclosure).not.toHaveAttribute('open', '');

    await disclosure.locator('summary').click();
    await expect(disclosure).toHaveAttribute('open', '');
    // Status container becomes visible inside the open disclosure and the
    // diagnostics handler populates it with a loading or empty-state message.
    await expect(status).toBeVisible();
    await expect(status).not.toHaveText('');

    expect(consoleErrors).toEqual([]);
  });
});
