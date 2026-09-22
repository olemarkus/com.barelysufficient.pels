import { expect, test } from './fixtures/test';

// Fresh-install recovery paths: both zero-state surfaces must link the user to
// the page that fixes them instead of dead-ending on a description.
test.describe('Onboarding links', () => {
  test('no-readings banner names both remedies and opens Limits & safety', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
        // No sample ever received; an unset source runs as Flow (the boot-time
        // migration writes one on every real install, so this is at most the
        // first-boot window).
        settings: { pels_status: null, power_tracker_state: null },
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // On the Overview the setup path's Power meter step says the banner's own
    // sentence, so the banner stands down there rather than say it twice.
    const banner = page.locator('#stale-data-banner');
    const powerStep = page.locator('#overview-setup-path [data-setup-step="power"]');
    await expect(powerStep).toContainText('No power readings yet');
    await expect(powerStep).toContainText('set up a Flow with the Report power usage action');
    await expect(banner).toBeHidden();

    // A panel without the card still needs it: nothing else there says why the
    // page is empty.
    await page.getByRole('tab', { name: 'Budget' }).click();
    await expect(banner).toBeVisible();
    // The never-received flow arm names BOTH remedies — the one honest arm
    // for an install where detection found nothing.
    await expect(banner).toContainText('No power readings yet');
    await expect(banner).toContainText('set up a Flow with the Report power usage action');
    await expect(banner.locator('#stale-data-action')).toHaveText('Check power source');

    await banner.locator('#stale-data-action').click();
    await expect(page.locator('#limits-panel')).toBeVisible();
    // The link promises the power-source choice, so the field itself must land
    // in view — not the top of Limits & safety (hard cap / safety margin).
    await expect(page.locator('#settings-power-source')).toBeInViewport();
  });

  test('an unrelated limits save keeps the fresh-install state intact', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
        settings: { pels_status: null, power_tracker_state: null },
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // The Overview says it on the setup path; Limits & safety, reached below,
    // has no card and says it on the banner.
    const banner = page.locator('#stale-data-banner');
    await expect(page.locator('#overview-setup-path [data-setup-step="power"]'))
      .toContainText('No power readings yet');

    // Change only the hard cap — the first field on the page the banner links to.
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.locator('.settings-nav-card[data-settings-target="limits"]').click();
    await page.locator('#settings-capacity-limit').evaluate((el) => {
      const field = el as HTMLElement & { value: string };
      field.value = '12';
      field.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#toast')).toContainText('Limits & safety saved');

    // The save must not materialize power_source (the UI half of the rule the
    // boot migration deliberately superseded for itself alone).
    const stored = await page.evaluate(() => new Promise<unknown>((resolve, reject) => {
      (window as unknown as {
        Homey: { get: (key: string, cb: (error: Error | null, value?: unknown) => void) => void };
      }).Homey.get('power_source', (error, value) => {
        if (error) reject(error);
        else resolve(value ?? null);
      });
    }));
    expect(stored).toBeNull();
    await expect(banner).toContainText('No power readings yet');
  });

  test('a fresh install leads with the setup path, not a loading state', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
        settings: {
          // The boot defaults of a home nobody has configured: no reading ever
          // received, no hard cap saved (the app runs on its built-in 10 kW
          // and never writes it back), nothing managed, no plan committed —
          // none is built for a meter that never reported.
          pels_status: null,
          power_tracker_state: null,
          managed_devices: {},
          controllable_devices: {},
          plan_snapshot: null,
        },
        unsetSettings: ['capacity_limit_kw', 'capacity_margin_kw'],
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const card = page.locator('#overview-setup-path');
    await expect(card).toBeVisible();
    await expect(card).toContainText('0 of 2 done');
    await expect(card.locator('[data-setup-step="power"]')).toHaveAttribute('data-setup-status', 'next');
    await expect(card.locator('[data-setup-step="devices"]')).toHaveAttribute('data-setup-status', 'later');
    // No Hard cap row: nothing may be limited yet, so no cap is in force, and
    // the path asks only for what applies to every home.
    await expect(card.locator('[data-setup-step="hardCap"]')).toHaveCount(0);

    // A home with no plan has nothing on its way: the hero skeleton would be a
    // loading state that never resolves.
    await expect(page.locator('#overview-panel .pels-skeleton').filter({ visible: true })).toHaveCount(0);
    // The card says simulation is on; the banner's "Turn off simulation" is the
    // one action an owner with nothing configured should not be offered first.
    await expect(card).toContainText('Simulation is on');
    await expect(page.locator('#dry-run-banner')).toBeHidden();
    // Both global banners stand down where the card speaks for them, so the
    // whole path fits the first viewport instead of starting below two alerts.
    await expect(page.locator('#stale-data-banner')).toBeHidden();
    await expect(card.locator('[data-setup-step="power"]')).toContainText('Pick a whole-home meter under Limits & safety');
    // The Devices step covers the zero-managed state; the two never stack.
    await expect(page.locator('#plan-empty').filter({ visible: true })).toHaveCount(0);

    // The Settings hub carries the same progress, and the Setup page the same path.
    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.locator('#settings-nav-chip-recommendations')).toHaveText('0 of 2');
    await page.locator('.settings-nav-card[data-settings-target="recommendations"]').click();
    await expect(page.locator('#setup-setup-path')).toBeVisible();
    await expect(page.locator('#setup-recommendations-root')).not.toContainText('No setup suggestions');

    // A step row lands on the field it names.
    await page.locator('#setup-setup-path [data-setup-step="power"]').click();
    await expect(page.locator('#limits-panel')).toBeVisible();
    await expect(page.locator('#settings-power-source')).toBeInViewport();
  });

  test('the Hard cap step appears once a device may be limited, and never before', async ({ page }) => {
    // Readings arriving, devices managed and limitable (the default fixture),
    // but no hard cap ever saved: the built-in 10 kW is now being enforced on
    // those devices, so this is the moment the owner needs to see it.
    await page.addInitScript(() => {
      (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
        unsetSettings: ['capacity_limit_kw', 'capacity_margin_kw'],
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const card = page.locator('#overview-setup-path');
    // Meter and devices are ready; only the hard cap remains.
    await expect(card).toContainText('2 of 3 done');
    const hardCap = card.locator('[data-setup-step="hardCap"]');
    await expect(hardCap).toHaveAttribute('data-setup-status', 'next');
    await expect(hardCap).toContainText('10 kW hourly average until you set yours');

    await hardCap.click();
    await expect(page.locator('#limits-panel')).toBeVisible();
  });

  test('automatic priorities complete setup without asking the owner to confirm an order', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
        settings: { capacity_priorities: {} },
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#plan-cards .plan-card').first()).toBeVisible();
    await expect(page.locator('#overview-setup-path')).toHaveCount(0);

    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.locator('.settings-nav-card[data-settings-target="modes"]').click();
    await expect(page.locator('#priority-list li').first()).toBeVisible();
    await expect(page.locator('#modes-panel')).toContainText('PELS orders devices automatically');
    await expect(page.locator('#priority-unplaced')).toHaveCount(0);
    const ranks = await page.locator('#priority-list .priority-badge').allTextContents();
    expect(ranks.length).toBeGreaterThan(1);
    expect(ranks).toEqual(ranks.map((_rank, index) => `#${index + 1}`));

    // Merely viewing the automatic order requires neither a confirmation nor a save.
    const stored = await page.evaluate(() => new Promise<unknown>((resolve) => {
      (window as unknown as {
        Homey: { get: (key: string, cb: (error: Error | null, value?: unknown) => void) => void };
      }).Homey.get('capacity_priorities', (_error, value) => resolve(value));
    }));
    expect(stored).toEqual({});
  });

  test('a configured home that is still simulating gets the banner, not the setup path', async ({ page }) => {
    // The default fixture: readings arriving, a saved hard cap, managed devices,
    // simulation on. Setup is finished; watching before going live is not a step.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#plan-cards .plan-card').first()).toBeVisible();
    await expect(page.locator('#overview-setup-path')).toHaveCount(0);
    await expect(page.locator('#dry-run-banner')).toBeVisible();
  });

  test('turning Managed on turns Limit on with it, even over a stored off', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
        settings: {
          managed_devices: {},
          // The heat pump has no entry. The water heater carries a stored `false`,
          // which is what the runtime leaves behind when a device loses its
          // power reading: it is not reliably an owner's opt-out.
          controllable_devices: { dev_waterheater: false },
        },
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.locator('.settings-nav-card[data-settings-target="devices"]').click();

    const readControllable = () => page.evaluate(() => new Promise<Record<string, boolean>>((resolve) => {
      (window as unknown as {
        Homey: { get: (key: string, cb: (error: Error | null, value?: unknown) => void) => void };
      }).Homey.get('controllable_devices', (_error, value) => resolve((value ?? {}) as Record<string, boolean>));
    }));
    const managedToggle = (deviceId: string) => page.locator(
      `.pels-device-card__row[data-device-id="${deviceId}"] md-icon-button[data-aria-label="Managed by PELS"]`,
    );

    await managedToggle('dev_heatpump').click();
    await expect.poll(async () => (await readControllable()).dev_heatpump).toBe(true);

    await managedToggle('dev_waterheater').click();
    await expect.poll(async () => (await readControllable()).dev_waterheater).toBe(true);

    // The Limit toggle in the same row is the opt-out, and it sticks.
    await page.locator(
      '.pels-device-card__row[data-device-id="dev_heatpump"] md-icon-button[data-aria-label^="Power-limit control"]',
    ).click();
    await expect.poll(async () => (await readControllable()).dev_heatpump).toBe(false);
  });

  test('once setup is done, PELS suggests what applies to this home and is not in use', async ({ page }) => {
    // Setup complete (the default fixture), a home that exports solar, managed
    // thermostats and a charger, and none of the three features in use.
    await page.addInitScript(() => {
      (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
        settings: {
          price_optimization_settings: {},
          deferred_objectives: { version: 1, objectivesByDeviceId: {} },
        },
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // The Overview announces them at the moment the setup card is gone.
    const banner = page.locator('#setup-recommendations-banner-root');
    await expect(page.locator('#overview-setup-path')).toHaveCount(0);
    // Not "3 recommendations": nothing about this home's setup needs changing.
    await expect(banner).toContainText('PELS can do more for this home');
    await banner.getByText('See what').click();

    const list = page.locator('#setup-recommendations-root');
    await expect(list).toContainText('Heat more while power is cheap');
    await expect(list).toContainText('Use more of your own solar');
    await expect(list).toContainText('Have something ready by a set time');
    // Optional, never "Recommended": nothing is wrong with a home that skips them.
    await expect(list.locator('.plan-chip', { hasText: 'Optional' })).toHaveCount(3);
    await expect(list.locator('.plan-chip', { hasText: 'Recommended' })).toHaveCount(0);

    // Dismiss is the owner saying "not for me", and it is remembered.
    const solar = list.locator('.setup-recommendation-card', { hasText: 'Use more of your own solar' });
    await solar.getByText('Dismiss').click();
    await expect(page.locator('#settings-nav-chip-recommendations')).toHaveText('2');

    // Each action opens the page that sets the feature up.
    await list.locator('.setup-recommendation-card', { hasText: 'Heat more while power is cheap' })
      .getByText('Set up prices').click();
    await expect(page.locator('#electricity-prices-panel')).toBeVisible();
  });

  test('a home with no solar surplus PELS can use is never told to use its solar', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
        settings: {
          price_optimization_settings: {},
          deferred_objectives: { version: 1, objectivesByDeviceId: {} },
          ui_devices_has_managed_solar: false,
          ui_devices_has_exhibited_export: false,
          ui_devices_surplus_pool_reachable: false,
        },
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('#setup-recommendations-banner-root').getByText('See what').click();
    await expect(page.locator('#setup-recommendations-root .setup-recommendation-card')).toHaveCount(2);
    await expect(page.locator('#setup-recommendations-root')).not.toContainText('solar');
  });

  test('nothing is suggested while setup is still open, or to a home already using it all', async ({ page }) => {
    // The default fixture follows prices, uses its solar and has a Smart task.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#plan-cards .plan-card').first()).toBeVisible();
    await expect(page.locator('#setup-recommendations-banner-root .banner')).toHaveCount(0);
  });

  test('a Belgian hub on the hourly average is asked to check its capacity period', async ({ page }) => {
    // Geography only: the runtime resolves the country from the hub's location.
    // The default fixture holds an hourly cap and limits devices.
    await page.addInitScript(() => {
      (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
        settings: { ui_hub_market_country: 'BE' },
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // A real recommendation, so the banner counts it rather than offering extras.
    const banner = page.locator('#setup-recommendations-banner-root');
    await expect(banner).toContainText('1 recommendation');
    await banner.getByText('Review').click();

    const card = page.locator('.setup-recommendation-card', { hasText: 'Check your capacity period' });
    await expect(card).toContainText('If you live in Flanders');
    // Wallonia and Brussels have no such tariff, and a country code cannot tell.
    await expect(card).toContainText('Elsewhere in Belgium this does not apply');
    await expect(card.locator('.plan-chip')).toHaveText('Recommended');

    await card.getByText('Open Limits & safety').click();
    await expect(page.locator('#limits-panel')).toBeVisible();
  });

  test('a Belgian hub already on the 15-minute average is asked nothing', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
        settings: { ui_hub_market_country: 'BE', capacity_period_minutes: 15 },
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#plan-cards .plan-card').first()).toBeVisible();
    await expect(page.locator('#setup-recommendations-banner-root .banner')).toHaveCount(0);
  });

  test('a Dutch hub is offered its own solar first; a Norwegian hub keeps the neutral order', async ({ page }) => {
    const titlesFor = async (country: string) => {
      await page.addInitScript((seeded) => {
        (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
          settings: {
            ui_hub_market_country: seeded,
            price_optimization_settings: {},
            deferred_objectives: { version: 1, objectivesByDeviceId: {} },
          },
        };
      }, country);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.locator('#setup-recommendations-banner-root').getByText('See what').click();
      const cards = page.locator('#setup-recommendations-root .setup-recommendation-card .plan-card__title');
      await expect(cards).toHaveCount(3);
      return cards.allTextContents();
    };

    expect(await titlesFor('NL')).toEqual([
      'Use more of your own solar', 'Heat more while power is cheap', 'Have something ready by a set time',
    ]);
    expect(await titlesFor('NO')).toEqual([
      'Heat more while power is cheap', 'Use more of your own solar', 'Have something ready by a set time',
    ]);
  });

  test('overview keeps managed devices when an empty plan arrives', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#plan-cards .plan-card').first()).toBeVisible();
    const deviceNames = await page.locator('#plan-cards .plan-card__title').allTextContents();

    // The plan has no decisions, but the independently loaded roster is still managed.
    await page.evaluate(() => {
      const homey = (window as unknown as {
        Homey: { __stub: { emitHomeyEvent: (event: string, payload: unknown) => void } };
      }).Homey;
      homey.__stub.emitHomeyEvent('plan_updated', {
        // A complete meta: the plan-snapshot seam validates it and drops the
        // whole push if anything required is missing, so a three-field meta
        // would never reach the empty state this test is about.
        meta: {
          totalKw: 0,
          lastPowerUpdateMs: Date.now() - 5 * 1000,
          softLimitKw: 5,
          capacitySoftLimitKw: 5,
          budgetPaceKw: null,
          projectedExemptKw: null,
          softLimitSource: 'capacity',
          capacityPeriodMinutes: 60,
          capacityPeriodCoverageComplete: true,
          powerIsMeasured: true,
          hardCapLimitKw: 10,
          usedKWh: 0,
          hourBudgetKWh: 5,
          minutesRemaining: 30,
          controlledKw: 0,
          uncontrolledKw: 0,
        },
        devices: [],
      });
    });

    await expect(page.locator('#plan-cards .plan-card--undecided')).toHaveCount(deviceNames.length);
    await expect(page.locator('#plan-cards .plan-card__title')).toHaveText(deviceNames);
    await expect(page.locator('#plan-empty').filter({ visible: true })).toHaveCount(0);
  });

  test('overview empty device roster links to the Devices settings page', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
        settings: { managed_devices: {}, controllable_devices: {} },
        // Override the actual adapters: the baseline stub adds its EV device
        // even when target_devices_snapshot is seeded empty.
        apiHandlers: {
          'GET /ui_devices': () => ({ devices: [] }),
          'GET /ui_homes': () => ({
            homes: [], membershipByDeviceId: {}, runtimeActive: false, configDegraded: false,
          }),
        },
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // The open Devices setup step owns the empty-roster action, suppressing
    // the duplicate standalone empty message on a fresh/unmanaged home.
    const devicesStep = page.locator('#overview-setup-path [data-setup-step="devices"]');
    await expect(devicesStep).toBeVisible();
    await expect(page.locator('#plan-cards .plan-card')).toHaveCount(0);
    await devicesStep.click();
    await expect(page.locator('#devices-panel')).toBeVisible();
  });
});
