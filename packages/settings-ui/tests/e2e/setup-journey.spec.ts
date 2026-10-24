import { expect, renderTest as test, type Page } from './fixtures/test';

const seed = async (page: Page, market = 'NL', solarAvailable = false) => {
  await page.addInitScript(({ market, solarAvailable }) => {
    const saved = JSON.parse(sessionStorage.getItem('setup-saved-settings') ?? '{}') as Record<string, unknown>;
    const device = {
      id: 'setup-pump', name: 'Pool pump', zone: 'Garden', available: true,
      deviceClass: 'socket', deviceType: 'onoff', isEvCharger: false,
      isBatteryOrSolar: false, binaryControllable: true, canSetControl: true,
      powerCapable: true, capabilities: ['onoff', 'measure_power'], targets: [],
      measuredPowerKw: 0, expectedPowerKw: 1, expectedPowerSource: 'measured-peak',
      managed: false,
    };
    const w = window as unknown as {
      __PELS_HOMEY_STUB__: unknown;
      Homey: { __stub: { getSetting: (key: string) => unknown } };
    };
    const devices = () => ({
      devices: [{ ...device, managed: (w.Homey.__stub.getSetting('managed_devices') as Record<string, boolean>)?.[device.id] === true }],
      chargerPhasePresets: { state: 'resolved', presets: {} },
      hasManagedSolarDevice: false, hasExhibitedExport: false, surplusPoolReachable: solarAvailable,
    });
    w.__PELS_HOMEY_STUB__ = {
      settings: {
        target_devices_snapshot: [device], managed_devices: {}, controllable_devices: {},
        price_optimization_settings: {}, capacity_dry_run: true,
        daily_budget_enabled: false,
        ui_hub_market_country: market,
        ui_devices_has_managed_solar: false, ui_devices_has_exhibited_export: false,
        ui_devices_surplus_pool_reachable: solarAvailable,
        ...saved,
      },
      unsetSettings: ['capacity_limit_kw', 'capacity_margin_kw'].filter((key) => !(key in saved)),
      apiHandlers: { 'GET /ui_devices': devices },
    };
  }, { market, solarAvailable });
};

const stored = (page: Page, key: string) => page.evaluate((key) => (
  window as unknown as { Homey: { __stub: { getSetting: (key: string) => unknown } } }
).Homey.__stub.getSetting(key), key);

// Homey persists these writes across WebView reloads; the in-memory fixture does not.
const reloadSavedSetup = async (page: Page) => {
  await page.evaluate(() => {
    const stub = (window as unknown as { Homey: { __stub: { getSetting: (key: string) => unknown } } }).Homey.__stub;
    const keys = ['managed_devices', 'controllable_devices', 'price_optimization_settings',
      'setup_recommendation_dismissals', 'capacity_enabled', 'capacity_period_minutes', 'capacity_limit_kw', 'capacity_margin_kw'];
    sessionStorage.setItem('setup-saved-settings', JSON.stringify(Object.fromEntries(keys.map((key) => [key, stub.getSetting(key)]))));
  });
  await page.reload();
};

const choosePump = async (page: Page) => {
  await page.getByRole('switch', { name: 'Manage Pool pump', exact: true }).click();
  await expect.poll(() => stored(page, 'controllable_devices')).toEqual({ 'setup-pump': true });
  await expect(page.locator('#devices-panel .setup-journey').getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
};

test('solar discovery before export keeps eligibility and restores context after reload and Back', async ({ page }) => {
  await seed(page);
  await page.goto('/');
  await page.locator('#overview-setup-path').getByText('Use more of your own solar', { exact: true }).click();
  await expect(page).toHaveURL(/setup=solar/);
  await expect(page.locator('#devices-panel')).toContainText('Waiting for usable solar readings');
  await expect(page.locator('#device-control-legend')).toBeHidden();
  await choosePump(page);
  await page.locator('#device-card-list').getByText('Run on solar surplus', { exact: true }).click();
  await expect(page.locator('#device-detail-overlay')).toBeVisible();
  await expect(page.locator('#device-detail-dump-load-row')).toBeHidden();
  expect(await stored(page, 'price_optimization_settings')).toEqual({});
  await page.locator('#device-detail-close').click();
  await expect(page.locator('#device-detail-overlay')).toBeHidden();
  await reloadSavedSetup(page);
  await expect(page.locator('#devices-panel')).toContainText('Use more of your own solar');
  await page.locator('#devices-panel .setup-journey').getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL(/setup=hardCap/);
  await page.goBack();
  await expect(page).toHaveURL(/setup=solar/);
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(page).not.toHaveURL(/setup=/);
});

test('one solar device can be configured without prices and the action reaches its existing control', async ({ page }) => {
  await seed(page, 'NL', true);
  await page.goto('/?page=settings/devices&setup=solar&setupGoal=solar');
  await choosePump(page);
  await page.locator('#device-card-list').getByText('Run on solar surplus', { exact: true }).click();
  const row = page.locator('#device-detail-dump-load-row');
  await expect(row).toBeInViewport();
  await page.locator('#device-detail-dump-load-opt').click();
  await expect.poll(async () => {
    const map = await stored(page, 'price_optimization_settings') as Record<string, { surplusWilling?: boolean; enabled?: boolean }>;
    return map['setup-pump'];
  }).toMatchObject({ surplusWilling: true, enabled: false });
  await page.locator('#device-detail-close').click();
  await page.locator('#devices-panel .setup-journey').getByRole('button', { name: 'Continue', exact: true }).click();
  await page.locator('#settings-capacity-enabled').click();
  await expect.poll(() => stored(page, 'capacity_enabled')).toBe(false);
  await page.locator('#limits-panel .setup-journey').getByRole('button', { name: 'Review setup', exact: true }).click();
  await expect(page.locator('#setup-review-root')).toContainText('Run on solar surplus');
  await expect(page.locator('#setup-review-root')).not.toContainText('Prices');
  await page.getByText('Keep simulating', { exact: true }).click();
  expect(await stored(page, 'capacity_dry_run')).toBe(true);
  await page.locator('#simulation-disable-button').click();
  await expect(page.locator('#setup-review-root')).toBeVisible();
});

test('Flemish period advice changes only the period and respects dismissal', async ({ page }) => {
  await seed(page, 'BE');
  await page.goto('/?page=settings/devices&setup=devices');
  await choosePump(page);
  await page.locator('#devices-panel .setup-journey').getByRole('button', { name: 'Continue', exact: true }).click();
  const header = page.locator('#limits-panel .setup-journey');
  await expect(header.getByText('Use 15-minute average', { exact: true })).toBeVisible();
  expect(await stored(page, 'capacity_period_minutes')).not.toBe(15);
  await header.getByText('Dismiss', { exact: true }).click();
  await expect(header.getByText('Use 15-minute average', { exact: true })).toHaveCount(0);
  await reloadSavedSetup(page);
  await expect(header.getByText('Use 15-minute average', { exact: true })).toHaveCount(0);
  await page.locator('#settings-capacity-period').evaluate((element) => {
    (element as HTMLElement & { value: string }).value = '15';
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(() => stored(page, 'capacity_period_minutes')).toBe(15);
  expect(await stored(page, 'capacity_limit_kw')).toBeUndefined();
  await expect(header.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
});

test('the Flemish period action retries a failed save without confirming the hard cap', async ({ page }) => {
  await seed(page, 'BE');
  await page.goto('/?page=settings/devices&setup=devices');
  await choosePump(page);
  await page.locator('#devices-panel .setup-journey').getByRole('button', { name: 'Continue', exact: true }).click();
  const header = page.locator('#limits-panel .setup-journey');
  const action = header.getByRole('button', { name: 'Use 15-minute average', exact: true });
  await expect(action).toBeVisible();
  await page.evaluate(() => {
    const homey = (window as unknown as { Homey: { set: (key: string, value: unknown, cb: (error?: Error) => void) => void } }).Homey;
    const original = homey.set;
    let fail = true;
    homey.set = (key, value, cb) => {
      if (key === 'capacity_period_minutes' && fail) { fail = false; cb(new Error('Offline. Try again.')); return; }
      original(key, value, cb);
    };
  });
  await action.click();
  await expect(header.getByRole('alert')).toContainText('Offline');
  expect(await stored(page, 'capacity_period_minutes')).not.toBe(15);
  await action.click();
  await expect.poll(() => stored(page, 'capacity_period_minutes')).toBe(15);
  await expect(action).toHaveCount(0);
  expect(await stored(page, 'capacity_limit_kw')).toBeUndefined();
  await expect(header.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
});

test('activation waits for an explicit action, reports failure, and retries without duplicate writes', async ({ page }) => {
  await page.goto('/');
  await page.locator('#simulation-disable-button').click();
  await expect(page.locator('#setup-review-root')).toContainText('Simulation mode is on');
  expect(await stored(page, 'capacity_dry_run')).toBe(true);
  await page.evaluate(() => {
    const homey = (window as unknown as { Homey: { set: (key: string, value: unknown, cb: (error?: Error) => void) => void } }).Homey;
    const original = homey.set;
    let fail = true;
    homey.set = (key, value, cb) => {
      if (key === 'capacity_dry_run' && fail) { fail = false; cb(new Error('Offline. Try again.')); return; }
      original(key, value, cb);
    };
  });
  await page.getByText('Start managing', { exact: true }).click();
  await expect(page.locator('#setup-review-root [role="alert"]')).toContainText('Offline');
  expect(await stored(page, 'capacity_dry_run')).toBe(true);
  await page.getByText('Start managing', { exact: true }).click();
  await expect(page.locator('#overview-panel')).toBeVisible();
  expect(await stored(page, 'capacity_dry_run')).toBe(false);
});


test('missing readings offer Fluvius help without exposing unrelated limit settings', async ({ page }) => {
  await seed(page, 'BE');
  await page.addInitScript(() => {
    const w = window as unknown as { __PELS_HOMEY_STUB__: { settings: Record<string, unknown> } };
    w.__PELS_HOMEY_STUB__.settings.power_tracker_state = null;
    w.__PELS_HOMEY_STUB__.settings.pels_status = null;
  });
  await page.goto('/?page=settings/limits&setup=power');
  await expect(page.getByText('Activate the Fluvius P1 port', { exact: true })).toBeVisible();
  await expect(page.locator('#settings-power-source')).toBeVisible();
  await expect(page.locator('#settings-limits-form')).toBeHidden();
  await expect(page.locator('#limits-panel .setup-journey').getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-nav-card[data-settings-target="limits"]').click();
  await expect(page.locator('#settings-limits-form')).toBeVisible();
});

test('unavailable home membership offers a retry instead of claiming there are no suitable devices', async ({ page }) => {
  await seed(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __PELS_HOMEY_STUB__: { apiHandlers: Record<string, () => unknown> } };
    w.__PELS_HOMEY_STUB__.apiHandlers['GET /ui_homes'] = () => ({ configDegraded: true });
  });
  await page.goto('/?page=settings/devices&setup=solar');
  const picker = page.locator('#device-card-list');
  await expect(picker).toContainText('Device setup could not be read.');
  await expect(picker).not.toContainText('No suitable devices');
  await page.evaluate(() => {
    const stub = (window as unknown as { Homey: { __stub: { clearApiHandler: (key: string) => void } } }).Homey.__stub;
    stub.clearApiHandler('GET /ui_homes');
  });
  await picker.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Manage Pool pump', exact: true })).toBeVisible();
});

for (const [width, mobile] of [[320, true], [390, false], [480, true]] as const) {
  test.describe(`setup at ${width}px ${mobile ? 'mobile' : 'desktop'}`, () => {
    test.use({ viewport: { width, height: 900 }, isMobile: mobile, hasTouch: mobile });
    test('keeps setup actions and device controls usable', async ({ page }, testInfo) => {
      await seed(page);
      await page.goto('/?page=settings/devices&setup=solar');
      await expect(page.getByRole('switch', { name: 'Manage Pool pump', exact: true })).toBeEnabled();
      await expect(page.locator('#devices-panel .setup-journey')).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`setup-${width}.png`), scale: 'css' });
      await choosePump(page);
      await page.locator('#devices-panel .setup-journey').getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(page.locator('#settings-capacity-enabled')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`limits-${width}.png`), scale: 'css' });
      await page.locator('#settings-capacity-enabled').click();
      await expect.poll(() => stored(page, 'capacity_enabled')).toBe(false);
      await page.locator('#limits-panel .setup-journey').getByRole('button', { name: 'Review setup', exact: true }).click();
      await expect(page.locator('#setup-review-root')).toContainText('Solar control is not configured yet.');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`review-${width}.png`), scale: 'css' });
    });
  });
}
