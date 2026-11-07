import { expect, renderTest as test } from './fixtures/test';

// Local review harness: exercise setup surfaces with Homey's injected CSS.
for (const width of [320, 480]) {
  for (const dark of [false, true]) {
    test.describe(`onboarding ${width}px ${dark ? 'dark' : 'light'}`, () => {
      test.use({ viewport: { width, height: dark ? 2400 : 1000 }, isMobile: dark, hasTouch: dark });
      test('captures device, price, priority and review states', async ({ page }, testInfo) => {
        test.setTimeout(60_000);
        await page.addInitScript(() => {
          const chosen = new URLSearchParams(location.search).has('chosen');
          const manual = new URLSearchParams(location.search).has('manual');
          const devices = [{
            id: 'mill', name: 'Living room heater', zone: 'Living room', available: true,
            deviceClass: 'heater', deviceType: 'temperature', binaryControllable: true,
            powerCapable: true, capabilities: ['onoff', 'target_temperature', 'measure_power'],
            targets: [{ name: 'target_temperature', value: 21 }], measuredPowerKw: 0.85,
            expectedPowerKw: 1.2, expectedPowerSource: 'measured-peak', managed: true,
          }, {
            id: 'tank', name: 'Water heater', zone: 'Utility room', available: true,
            deviceClass: 'waterheater', deviceType: 'onoff', binaryControllable: true,
            powerCapable: true, capabilities: ['onoff', 'measure_power'], targets: [],
            measuredPowerKw: 2, expectedPowerKw: 2, expectedPowerSource: 'measured-peak', managed: true,
          }];
          (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
            settings: {
              target_devices_snapshot: devices, managed_devices: { mill: true, tank: true },
              controllable_devices: { mill: true, tank: true }, capacity_priorities: {}, mode_device_targets: {},
              price_optimization_settings: { mill: { enabled: true, priceConfigured: true, cheapDelta: 1, expensiveDelta: -1 } },
              capacity_dry_run: true, capacity_limit_kw: 10, capacity_margin_kw: 0.2,
              daily_budget_enabled: false, ui_hub_market_country: 'NO',
              plan_snapshot_meta_patch: { softLimitKw: 52.1, softLimitSource: 'capacity',
                hardCapLimitKw: 10, capacityPeriodMinutes: 60 },
              ui_devices_has_managed_solar: false, ui_devices_has_exhibited_export: false,
              ui_devices_surplus_pool_reachable: false,
              ...(chosen ? { price_scheme: 'norway', price_area: 'NO3', nettleie_fylke: '50',
                nettleie_orgnr: '978631029', norway_price_model: 'stromstotte' } : {}),
            },
            unsetSettings: chosen ? [] : ['price_scheme', 'price_area', 'nettleie_fylke', 'nettleie_orgnr', 'norway_price_model', 'provider_surcharge'],
            priceSetupSuggestion: manual ? { gridCompany: { kind: 'none' }, priceArea: { kind: 'none' }, powerhour: { kind: 'none' } } : {
              gridCompany: { kind: 'found', organizationNumber: '978631029', name: 'TENSIO TS AS', countyCode: '50' },
              priceArea: { kind: 'from_homey_energy', area: 'NO3' }, powerhour: { kind: 'none' },
            },
          };
        });
        const captures = [
          ['devices', '/?page=settings/devices&setup=devices', '#device-card-list'],
          ['prices', '/?page=settings/electricity-prices&setup=prices', '#electricity-prices-location-suggestion'],
          ['priorities', '/?page=settings/modes&setup=priorities&chosen=1', '#priority-list .device-row'],
          ['review', '/?page=settings/setup-review&setup=review&chosen=1', '#setup-review-root .setup-journey'],
          ['overview', '/?page=overview&chosen=1', '#overview-panel .plan-hero'],
          ...(width === 320 && !dark ? [
            ['prices-manual', '/?page=settings/electricity-prices&setup=prices&manual=1', '#electricity-prices-panel details[open]'],
            ['prices-settings', '/?page=settings/electricity-prices&chosen=1', '#electricity-prices-panel .pels-appbar'],
          ] as const : []),
        ] as const;
        for (const [name, url, ready] of captures) {
          await page.goto(url);
          await expect(page.locator(ready).first()).toBeVisible();
          await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          if (name === 'overview') await expect(page.locator('#overview-panel .plan-hero')).toContainText('Unused energy this hour allows a higher pace now.');
          await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: !dark, scale: 'css' });
          if (name === 'prices') {
            await page.getByRole('button', { name: 'Use these', exact: true }).click();
            const model = page.locator('md-filled-select[aria-labelledby="electricity-prices-norway-model-label"]').getByRole('combobox');
            await model.click();
            await page.getByRole('option', { name: 'Electricity Subsidy Scheme (Strømstøtte)', exact: true }).click();
            await expect(page.getByRole('option', { name: 'Electricity Subsidy Scheme (Strømstøtte)', exact: true })).toBeHidden();
            await expect(page.locator('#toast')).not.toHaveClass(/show/);
            await expect(page.locator('#electricity-prices-panel .setup-journey').getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
            await page.screenshot({ path: testInfo.outputPath('prices-confirmed.png'), fullPage: !dark, scale: 'css' });
          }
        }
      });
    });
  }
}
