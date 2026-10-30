import { expect, renderTest as test, type Page } from './fixtures/test';

const seed = async (
  page: Page, market = 'NL', solarAvailable = false, solarDevice = true, powerSource: string | null = null,
) => {
  await page.addInitScript(({ market, solarAvailable, solarDevice, powerSource }) => {
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
      hasManagedSolarDevice: solarDevice, hasExhibitedExport: false, surplusPoolReachable: solarAvailable,
    });
    w.__PELS_HOMEY_STUB__ = {
      settings: {
        target_devices_snapshot: [device], managed_devices: {}, controllable_devices: {},
        price_optimization_settings: {}, capacity_dry_run: true,
        daily_budget_enabled: false,
        ui_hub_market_country: market,
        ui_devices_has_managed_solar: solarDevice, ui_devices_has_exhibited_export: false,
        ui_devices_surplus_pool_reachable: solarAvailable,
        ...(powerSource === null ? {} : { power_source: powerSource }),
        ...saved,
      },
      unsetSettings: ['capacity_limit_kw', 'capacity_margin_kw'].filter((key) => !(key in saved)),
      apiHandlers: { 'GET /ui_devices': devices },
    };
  }, { market, solarAvailable, solarDevice, powerSource });
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

test('a solar home waiting for its first surplus keeps its setup context after reload and Back', async ({ page }) => {
  await seed(page);
  await page.goto('/');
  // Solar has no entry of its own: `Choose what PELS does` offers it once it can act.
  await expect(page.locator('#overview-setup-path')).toBeVisible();
  await expect(page.locator('#overview-setup-path').getByText('Use more of your own solar', { exact: true })).toHaveCount(0);
  await page.goto('/?page=settings/devices&setup=devices');
  await expect(page.locator('#devices-panel .setup-journey').getByText('Check meter', { exact: true })).toHaveCount(0);
  await expect(page.locator('#device-control-legend')).toBeHidden();
  await choosePump(page);
  // The card names no control the device page does not have yet.
  await expect(page.locator('#device-card-list')).not.toContainText('Solar control appears');
  await expect(page.locator('#device-card-list').getByText('Run on solar surplus', { exact: true })).toHaveCount(0);
  await page.locator('#device-card-list').getByText('Device settings', { exact: true }).click();
  await expect(page.locator('#device-detail-overlay')).toBeVisible();
  await expect(page.locator('#device-detail-dump-load-row')).toBeHidden();
  expect(await stored(page, 'price_optimization_settings')).toEqual({});
  await page.locator('#device-detail-close').click();
  await expect(page.locator('#device-detail-overlay')).toBeHidden();
  await reloadSavedSetup(page);
  await expect(page.locator('#devices-panel')).toContainText('Choose one device to start');
  await page.locator('#devices-panel .setup-journey').getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL(/setup=hardCap/);
  await page.goBack();
  await expect(page).toHaveURL(/setup=devices/);
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(page).not.toHaveURL(/setup=/);
});

test('a Flow meter home waiting for solar is told how the Flow must report it', async ({ page }) => {
  await seed(page, 'NL', false, true, 'flow');
  const note = 'Solar control appears once PELS sees your solar produce more than the home is using. '
    + 'Your Flow must send net import, negative when exporting.';
  // The review tells every such home, with or without a device to choose for.
  await page.goto('/?page=settings/devices&setup=devices');
  await choosePump(page);
  await page.locator('#devices-panel .setup-journey').getByRole('button', { name: 'Continue', exact: true }).click();
  await page.locator('#settings-capacity-enabled').click();
  await expect.poll(() => stored(page, 'capacity_enabled')).toBe(false);
  await page.locator('#limits-panel .setup-journey').getByRole('button', { name: 'Review setup', exact: true }).click();
  await expect(page.locator('#setup-review-root')).toContainText(note);
  // `Choose what PELS does` says it once in its header, next to the meter check.
  await page.goto('/?page=settings/devices&setup=goals');
  const header = page.locator('#devices-panel .setup-journey');
  await expect(header).toContainText(note);
  await expect(header.getByText('Check meter', { exact: true })).toBeVisible();
});

test('one solar device can be configured without prices and the action reaches its existing control', async ({ page }) => {
  await seed(page, 'NL', true);
  await page.goto('/?page=settings/devices&setup=devices');
  await choosePump(page);
  await page.locator('#devices-panel .setup-journey').getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('#limits-panel .setup-journey')).toContainText('Dutch household grid charges depend on connection size');
  await expect(page.locator('#limits-panel .setup-journey')).toContainText('turn off Capacity limit and still use prices and solar');
  await page.locator('#settings-capacity-enabled').click();
  await expect.poll(() => stored(page, 'capacity_enabled')).toBe(false);
  await page.locator('#limits-panel .setup-journey').getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL(/setup=goals/);
  await expect(page.locator('#devices-panel .setup-journey')).not.toContainText('Solar control appears');
  await page.locator('#device-card-list').getByText('Run on solar surplus', { exact: true }).click();
  const row = page.locator('#device-detail-dump-load-row');
  await expect(row).toBeInViewport();
  await page.locator('#device-detail-dump-load-opt').click();
  await expect.poll(async () => {
    const map = await stored(page, 'price_optimization_settings') as Record<string, { surplusWilling?: boolean; enabled?: boolean }>;
    return map['setup-pump'];
  }).toMatchObject({ surplusWilling: true, enabled: false });
  await page.locator('#device-detail-close').click();
  await page.locator('#devices-panel .setup-journey').getByRole('button', { name: 'Review setup', exact: true }).click();
  await expect(page.locator('#setup-review-root')).toContainText('Run on solar surplus');
  await expect(page.locator('#setup-review-root')).not.toContainText('Prices');
  await page.getByText('Keep simulating', { exact: true }).click();
  expect(await stored(page, 'capacity_dry_run')).toBe(true);
  await page.locator('#simulation-disable-button').click();
  await expect(page.locator('#setup-review-root')).toBeVisible();
});

// A Dutch home with a heat pump and an EV charger and no limit to hold: after
// the required steps, setup offers what PELS can do with them.
const seedHeatPumpAndCharger = async (page: Page, managedAtStart = false) => {
  await page.addInitScript(({ managedAtStart }) => {
    const devices = [{
      id: 'setup-heatpump', name: 'Heat pump', zone: 'Hall', available: true,
      deviceClass: 'heater', deviceType: 'temperature', isEvCharger: false,
      isBatteryOrSolar: false, binaryControllable: true, canSetControl: true,
      powerCapable: true, capabilities: ['onoff', 'target_temperature', 'measure_power'],
      targets: [{ name: 'target_temperature', value: 21 }],
      measuredPowerKw: 0, expectedPowerKw: 2, expectedPowerSource: 'measured-peak',
    }, {
      id: 'setup-charger', name: 'Car charger', zone: 'Garage', available: true,
      deviceClass: 'evcharger', deviceType: 'onoff', isEvCharger: true,
      isBatteryOrSolar: false, binaryControllable: true, canSetControl: true, controlModel: 'binary_power',
      powerCapable: true, capabilities: ['onoff', 'evcharger_charging', 'measure_power'], targets: [],
      measuredPowerKw: 0, expectedPowerKw: 7, expectedPowerSource: 'load-setting',
    }];
    const w = window as unknown as {
      __PELS_HOMEY_STUB__: unknown;
      Homey: { __stub: { getSetting: (key: string) => unknown } };
    };
    const managed = () => (w.Homey.__stub.getSetting('managed_devices') ?? {}) as Record<string, boolean>;
    const all = managedAtStart ? Object.fromEntries(devices.map((device) => [device.id, true])) : {};
    w.__PELS_HOMEY_STUB__ = {
      settings: {
        target_devices_snapshot: devices, managed_devices: all, controllable_devices: all,
        price_optimization_settings: {}, capacity_dry_run: true, capacity_enabled: false,
        daily_budget_enabled: false,
        // Homey Energy, chosen and with prices: the Prices step has nothing to ask.
        price_scheme: 'homey', homey_prices_today: { dateKey: '2026-10-29', pricesByHour: { 0: 0.21, 1: 0.2 } },
        ui_hub_market_country: 'NL',
        ui_devices_has_managed_solar: false, ui_devices_has_exhibited_export: false,
        ui_devices_surplus_pool_reachable: false,
      },
      unsetSettings: ['capacity_limit_kw', 'capacity_margin_kw'],
      apiHandlers: {
        'GET /ui_devices': () => ({
          devices: devices.map((device) => ({ ...device, managed: managed()[device.id] === true })),
          chargerPhasePresets: { state: 'resolved', presets: {} },
          hasManagedSolarDevice: false, hasExhibitedExport: false, surplusPoolReachable: false,
        }),
      },
    };
  }, { managedAtStart });
};

test('setup offers what PELS can do before the review, and the review names it', async ({ page }, testInfo) => {
  await seedHeatPumpAndCharger(page);
  await page.goto('/?page=settings/devices&setup=devices');
  await page.getByRole('switch', { name: 'Manage Heat pump', exact: true }).click();
  await page.getByRole('switch', { name: 'Manage Car charger', exact: true }).click();
  await expect.poll(() => stored(page, 'managed_devices')).toEqual({ 'setup-heatpump': true, 'setup-charger': true });
  const devicesHeader = page.locator('#devices-panel .setup-journey');
  await devicesHeader.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(page).toHaveURL(/setup=goals/);
  const header = page.locator('#devices-panel .setup-journey');
  await expect(header).toContainText('Choose what PELS does');
  await expect(header.getByRole('button', { name: 'Review setup', exact: true })).toBeEnabled();
  const picker = page.locator('#device-card-list');
  await expect(picker.locator('[data-device-id="setup-charger"]').getByText('New smart task', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('goals.png'), scale: 'css', fullPage: true });
  await page.getByRole('switch', { name: 'Price-based control for Heat pump', exact: true }).click();
  await expect.poll(async () => {
    const map = await stored(page, 'price_optimization_settings') as Record<string, { enabled?: boolean }>;
    return map['setup-heatpump']?.enabled;
  }).toBe(true);

  await header.getByRole('button', { name: 'Review setup', exact: true }).click();
  const review = page.locator('#setup-review-root');
  await expect(review).toContainText('Power limits off');
  await expect(review).toContainText('Price-based control on');
  await expect(review).toContainText('Nothing for PELS to do yet');
  await expect(review).not.toContainText('Power-limit control on');
  await page.screenshot({ path: testInfo.outputPath('review.png'), scale: 'css', fullPage: true });
});

test('New smart task in setup opens the flow on the Smart tasks page', async ({ page }) => {
  await seedHeatPumpAndCharger(page, true);
  await page.goto('/?page=settings/devices&setup=goals');
  await page.locator('#device-card-list [data-device-id="setup-charger"]').getByText('New smart task', { exact: true }).click();
  await expect(page.locator('#smart-task-create-root')).toBeVisible();
});

test('Flemish period advice changes only the period and respects dismissal', async ({ page }) => {
  await seed(page, 'BE');
  await page.goto('/?page=settings/devices&setup=devices');
  await choosePump(page);
  await page.locator('#devices-panel .setup-journey').getByRole('button', { name: 'Continue', exact: true }).click();
  const header = page.locator('#limits-panel .setup-journey');
  await expect(header.getByText('Use 15-minute average', { exact: true })).toBeVisible();
  await expect(header.getByText('Turn off Capacity limit', { exact: true })).toHaveCount(0);
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

test('the Dutch Limits step turns off Capacity limit in one tap without confirming the hard cap', async ({ page }) => {
  await seed(page, 'NL');
  await page.goto('/?page=settings/devices&setup=devices');
  await choosePump(page);
  await page.locator('#devices-panel .setup-journey').getByRole('button', { name: 'Continue', exact: true }).click();
  const header = page.locator('#limits-panel .setup-journey');
  await expect(header).toContainText('Dutch household grid charges depend on connection size');
  await expect(header.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await header.getByRole('button', { name: 'Turn off Capacity limit', exact: true }).click();
  await expect.poll(() => stored(page, 'capacity_enabled')).toBe(false);
  expect(await stored(page, 'capacity_limit_kw')).toBeUndefined();
  await expect.poll(() => page.locator('#settings-capacity-enabled').evaluate(
    (element) => (element as HTMLElement & { selected: boolean }).selected,
  )).toBe(false);
  await expect(header.getByText('Turn off Capacity limit', { exact: true })).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'Review setup', exact: true })).toBeEnabled();
});

test('the Dutch Capacity limit action retries a failed save', async ({ page }) => {
  await seed(page, 'NL');
  await page.goto('/?page=settings/devices&setup=devices');
  await choosePump(page);
  await page.locator('#devices-panel .setup-journey').getByRole('button', { name: 'Continue', exact: true }).click();
  const header = page.locator('#limits-panel .setup-journey');
  const action = header.getByRole('button', { name: 'Turn off Capacity limit', exact: true });
  await expect(action).toBeVisible();
  await page.evaluate(() => {
    const homey = (window as unknown as { Homey: { set: (key: string, value: unknown, cb: (error?: Error) => void) => void } }).Homey;
    const original = homey.set;
    let fail = true;
    homey.set = (key, value, cb) => {
      if (key === 'capacity_enabled' && fail) { fail = false; cb(new Error('Offline. Try again.')); return; }
      original(key, value, cb);
    };
  });
  await action.click();
  await expect(header.getByRole('alert')).toContainText('Offline');
  expect(await stored(page, 'capacity_enabled')).not.toBe(false);
  await expect.poll(() => page.locator('#settings-capacity-enabled').evaluate(
    (element) => (element as HTMLElement & { selected: boolean }).selected,
  )).toBe(true);
  await action.click();
  await expect.poll(() => stored(page, 'capacity_enabled')).toBe(false);
  await expect(action).toHaveCount(0);
  expect(await stored(page, 'capacity_limit_kw')).toBeUndefined();
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
  await page.goto('/?page=settings/devices&setup=devices');
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
      await page.goto('/?page=settings/devices&setup=devices');
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
      await expect(page.locator('#setup-review-root')).toContainText(
        'Solar control appears once PELS sees your solar produce more than the home is using.',
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`review-${width}.png`), scale: 'css' });
    });
  });
}
