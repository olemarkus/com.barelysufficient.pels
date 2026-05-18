import { expect, test, type Page } from './fixtures/test';
import {
  readMdSwitchSelected,
  readMdValue,
  setMdSwitch,
  setMdValue,
} from './fixtures/materialWeb';

const openDevices = async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('.settings-nav-card[data-settings-target="devices"]').click();
  await expect(page.locator('#devices-panel')).toBeVisible();
};

const clickDeviceDetailButton = async (page: Page, deviceId: string) => {
  const row = page.locator(`#devices-panel [data-device-id="${deviceId}"]`).first();
  await expect(row).toBeVisible();
  const detailButton = row.locator('.pels-device-card__detail-button');
  await expect(detailButton).toBeVisible();
  await detailButton.scrollIntoViewIfNeeded();
  await detailButton.click();
  await expect(page.locator('#device-detail-overlay')).toBeVisible({ timeout: 10000 });
};

const openDeviceDetail = async (page: Page, deviceId: string) => {
  await openDevices(page);
  await clickDeviceDetailButton(page, deviceId);
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
  test('opens only from the explicit device settings button', async ({ page }) => {
    await openDevices(page);
    const overlay = page.locator('#device-detail-overlay');
    const row = page.locator('#devices-panel [data-device-id="dev_heatpump"]').first();
    await expect(row).toBeVisible();

    await row.locator('.device-row__name').click();
    await expect(overlay).toBeHidden();

    await row.locator('.pels-icon-toggle').first().click();
    await expect(overlay).toBeHidden();

    await row.locator('.pels-device-card__detail-button').click();
    await expect(overlay).toBeVisible();
    await expect(page.locator('#device-detail-title')).toHaveText('Living Room Heat Pump');
  });

  test('shows plain disabled-control reasons in the device list', async ({ page }) => {
    await openDevices(page);
    const waterHeaterRow = page.locator('#devices-panel [data-device-id="dev_waterheater"]').first();
    await expect(waterHeaterRow.locator('.pels-device-card__reasons')).toContainText(
      'Price works with temperature devices only.',
    );
  });

  test('opens and closes via back button, overlay backdrop, and Escape', async ({ page }) => {
    await openDeviceDetail(page, 'dev_heatpump');
    await expect(page.locator('#device-detail-title')).toHaveText('Living Room Heat Pump');

    // Close via back button.
    await page.locator('#device-detail-close').click();
    await expect(page.locator('#device-detail-overlay')).toBeHidden();

    // Close via Escape.
    await clickDeviceDetailButton(page, 'dev_heatpump');
    await page.keyboard.press('Escape');
    await expect(page.locator('#device-detail-overlay')).toBeHidden();

    // Close via overlay backdrop. At 480px the slide-panel fills the
    // viewport so there's no visible backdrop region to click — dispatch
    // a synthetic click whose event.target is the overlay itself, which
    // is the exact contract the handler at index.ts:299 enforces
    // (`event.target === deviceDetailOverlay`).
    await clickDeviceDetailButton(page, 'dev_heatpump');
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
    const tempRow = page.locator('#device-detail-overshoot-temp-row');
    const stepRow = page.locator('#device-detail-overshoot-step-row');

    await expect(segmented).toBeVisible();
    const options = segmented.locator('.segmented__option:not([hidden])');
    await expect(options.first()).toBeVisible();
    expect(await options.count()).toBeGreaterThanOrEqual(2);

    await options.filter({ hasText: 'Turn off' }).click();
    await expect.poll(() => readMdValue(page, '#device-detail-overshoot')).toBe('turn_off');
    await expect(tempRow).toBeHidden();
    await expect(stepRow).toBeHidden();

    await options.filter({ hasText: 'Set to temperature' }).click();
    await expect.poll(() => readMdValue(page, '#device-detail-overshoot')).toBe('set_temperature');
    await expect(tempRow).toBeVisible();
    await setMdValue(page, '#device-detail-overshoot-temp', '12');

    // Selected option must look distinct from unselected ones (regression
    // guard for the pre-unification "all green text, no selected fill" bug).
    const selectedSwatch = await segmented
      .locator('.segmented__option[aria-checked="true"]')
      .evaluate((el) => {
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, color: cs.color };
      });
    const unselectedSwatch = await segmented
      .locator('.segmented__option[aria-checked="false"]:not([hidden])')
      .first()
      .evaluate((el) => {
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, color: cs.color };
      });
    expect(selectedSwatch.bg).not.toEqual(unselectedSwatch.bg);
    expect(selectedSwatch.bg).not.toBe('rgba(0, 0, 0, 0)');

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

    // Power-limit control: toggle off then on.
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

  test('Switch row label is clickable to toggle the switch', async ({ page }) => {
    await openDeviceDetail(page, 'dev_heatpump');
    await page.locator('#device-detail-setup-section summary').click();

    // Click the text content area of the Budget exempt row — NOT the
    // md-switch thumb. This proves the whole-row tap behavior is wired
    // up so users don't have to hit the small switch hitbox.
    const initially = await readMdSwitchSelected(page, '#device-detail-budget-exempt');
    await page.locator('#device-detail-budget-exempt')
      .locator('xpath=ancestor::*[contains(@class, "md-switch-row")][1]')
      .locator('.md-switch-row__label')
      .click();

    await expect.poll(
      () => readMdSwitchSelected(page, '#device-detail-budget-exempt'),
      { timeout: 3000 },
    ).toBe(!initially);
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
