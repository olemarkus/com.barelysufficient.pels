import { expect, renderTest as test, type Page } from './fixtures/test';

const seedHomeWithoutPrices = async (page: Page, country = 'KR') => {
  await page.addInitScript((country) => {
    const heater = {
      id: 'setup-heatpump', name: 'Heat pump', zone: 'Hall', available: true,
      deviceClass: 'heater', deviceType: 'temperature', isEvCharger: false,
      isBatteryOrSolar: false, binaryControllable: true, canSetControl: true,
      powerCapable: true, capabilities: ['onoff', 'target_temperature', 'measure_power'],
      targets: [{ name: 'target_temperature', value: 21 }],
      measuredPowerKw: 0, expectedPowerKw: 2, expectedPowerSource: 'measured-peak',
      managed: true,
    };
    (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
      settings: {
        target_devices_snapshot: [heater],
        managed_devices: { [heater.id]: true }, controllable_devices: { [heater.id]: true },
        price_optimization_settings: {
          [heater.id]: { enabled: true, priceConfigured: true, cheapDelta: 1, expensiveDelta: -1 },
        },
        capacity_enabled: false, capacity_dry_run: true, daily_budget_enabled: false,
        price_scheme: country === 'NO' ? 'norway' : 'homey', homey_prices_today: null, homey_prices_tomorrow: null,
        flow_prices_today: null, flow_prices_tomorrow: null,
        combined_prices: null, task_price_periods: [],
        ui_hub_market_country: country,
        ui_devices_has_managed_solar: false, ui_devices_has_exhibited_export: false,
        ui_devices_surplus_pool_reachable: false,
      },
      unsetSettings: country === 'NO'
        ? ['price_area', 'nettleie_fylke', 'nettleie_orgnr', 'norway_price_model', 'provider_surcharge'] : [],
      priceSetupSuggestion: {
        gridCompany: { kind: 'none' }, priceArea: { kind: 'none' }, powerhour: { kind: 'app_unavailable' },
      },
    };
  }, country);
};

const expectNoSideScroll = async (page: Page) => {
  const layout = await page.evaluate(() => ({
    width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width);
};

for (const [width, mobile] of [[320, false], [480, false], [320, true], [480, true]] as const) {
  test.describe(`Korean price setup at ${width}px ${mobile ? 'dark' : 'light'}`, () => {
    test.use({ viewport: { width, height: mobile ? 3200 : 900 }, timezoneId: 'Asia/Seoul',
      isMobile: mobile, hasTouch: mobile });

    test('offers custom prices without claiming an empty Flow completes setup', async ({ page }, testInfo) => {
      await seedHomeWithoutPrices(page);
      await page.goto('/?page=settings/electricity-prices&setup=prices');
      const panel = page.locator('#electricity-prices-panel');
      const journey = panel.locator('.setup-journey');
      await expect(journey).toContainText('Homey Energy has no prices for your Homey.');
      await expect(journey.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
      await expect(panel).toContainText('Power by the Hour offers European market prices');
      await expect(panel).toContainText('Check that it covers your tariff before adding it.');
      await expect(panel).toContainText('You need to supply the prices for your own contract.');
      await expect(panel).not.toContainText('Otherwise, use Power by the Hour with your tariff.');
      await expect(panel.getByRole('button', { name: 'Use Flow prices', exact: true })).toBeVisible();
      await expectNoSideScroll(page);
      await page.screenshot({ path: testInfo.outputPath('korean-price-guidance.png'), scale: 'css', fullPage: !mobile });

      await panel.getByRole('button', { name: 'Use Flow prices', exact: true }).click();
      await expect(journey).toContainText('Send today’s or tomorrow’s prices through a Flow.');
      await expect(journey.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
      await expect(journey.getByRole('button', { name: 'Review setup', exact: true })).toHaveCount(0);
      await expect(panel).toContainText('No data received');
      await expectNoSideScroll(page);
      await page.screenshot({ path: testInfo.outputPath('flow-prices-still-missing.png'), scale: 'css', fullPage: !mobile });

      await panel.getByRole('button', { name: 'Choose what PELS does', exact: true }).click();
      await expect(page).toHaveURL(/setup=goals/);
      await expect(page.locator('#devices-panel .setup-journey')).toContainText('Choose what PELS does');
      await expect(page.getByRole('switch', { name: 'Price-based control for Heat pump', exact: true })).toBeChecked();
    });
  });
}


type PriceOverlapWindow = Window & {
  Homey: {
    api: (method: string, path: string, callback: (error: Error | null, value: unknown) => void) => void;
    __stub: {
      setApiHandler: (key: string, handler: () => unknown) => void;
      emitHomeyEvent: (event: string) => void;
    };
  };
  __priceOverlap: {
    statusPending: boolean;
    suggestionCalls: number;
    releaseStatus: () => void;
    releaseSuggestion: (index: number) => void;
  };
};

for (const phase of ['status refresh', 'suggestion'] as const) {
  test(`keeps price setup pending when Refresh finishes before the open ${phase}`, async ({ page }) => {
    await seedHomeWithoutPrices(page, 'NO');
    await page.goto('/');
    await expect(page.locator('#overview-setup-path [data-setup-step="prices"]'))
      .toHaveAttribute('data-setup-status', 'next');
    await page.evaluate(async (phase) => {
      const w = window as unknown as PriceOverlapWindow;
      const prices = await new Promise<unknown>((resolve, reject) => {
        w.Homey.api('GET', '/ui_prices', (error, value) => error ? reject(error) : resolve(value));
      });
      const releases: Array<() => void> = [];
      const probe = {
        statusPending: false,
        suggestionCalls: 0,
        releaseStatus: (): void => undefined,
        releaseSuggestion: (index: number) => releases[index](),
      };
      w.__priceOverlap = probe;
      let statusHeld = false;
      const none = { gridCompany: { kind: 'none' }, priceArea: { kind: 'none' }, powerhour: { kind: 'none' } };
      w.Homey.__stub.setApiHandler('GET /ui_prices', () => {
        if (phase !== 'status refresh' || statusHeld) return prices;
        statusHeld = true;
        probe.statusPending = true;
        return new Promise<unknown>((resolve) => {
          probe.releaseStatus = () => { probe.statusPending = false; resolve(prices); };
        });
      });
      w.Homey.__stub.setApiHandler('POST /ui_refresh_prices', () => prices);
      w.Homey.__stub.setApiHandler('GET /ui_price_setup_suggestion', () => {
        probe.suggestionCalls += 1;
        if (phase === 'status refresh') return none;
        return new Promise<unknown>((resolve) => releases.push(() => resolve(none)));
      });
      // Invalidate the public price read before entering the setup page.
      w.Homey.__stub.emitHomeyEvent('prices_updated');
      document.querySelector<HTMLElement>('#overview-setup-path [data-setup-step="prices"]')!.click();
    }, phase);
    const panel = page.locator('#electricity-prices-panel');
    const pending = panel.getByText('Finding settings for your Homey’s location…', { exact: true });
    await expect(pending).toBeVisible();
    await expect.poll(() => page.evaluate((phase) => {
      const probe = (window as unknown as PriceOverlapWindow).__priceOverlap;
      return phase === 'status refresh' ? probe.statusPending : probe.suggestionCalls === 1;
    }, phase)).toBe(true);
    await panel.getByRole('button', { name: 'Refresh prices', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as PriceOverlapWindow).__priceOverlap.suggestionCalls))
      .toBe(phase === 'status refresh' ? 1 : 2);
    if (phase === 'suggestion') {
      await page.evaluate(async () => {
        (window as unknown as PriceOverlapWindow).__priceOverlap.releaseSuggestion(0);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
    } else {
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    }
    await expect(pending).toBeVisible();
    await expect(panel.locator('details.settings-collapse')).not.toHaveAttribute('open');
    await page.evaluate((phase) => {
      const probe = (window as unknown as PriceOverlapWindow).__priceOverlap;
      if (phase === 'status refresh') probe.releaseStatus();
      else probe.releaseSuggestion(1);
    }, phase);
    await expect(pending).toBeHidden();
    await expect(panel.locator('details.settings-collapse')).toHaveAttribute('open');
  });
}
