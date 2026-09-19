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
          capacity_limit_kw: null,
          capacity_margin_kw: null,
          managed_devices: {},
          controllable_devices: {},
          plan_snapshot: null,
        },
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
        settings: { capacity_limit_kw: null, capacity_margin_kw: null },
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const card = page.locator('#overview-setup-path');
    await expect(card).toContainText('2 of 3 done');
    const hardCap = card.locator('[data-setup-step="hardCap"]');
    await expect(hardCap).toHaveAttribute('data-setup-status', 'next');
    await expect(hardCap).toContainText('10 kW hourly average until you set yours');

    await hardCap.click();
    await expect(page.locator('#limits-panel')).toBeVisible();
  });

  test('a configured home that is still simulating gets the banner, not the setup path', async ({ page }) => {
    // The default fixture: readings arriving, a saved hard cap, managed devices,
    // simulation on. Setup is finished; watching before going live is not a step.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#plan-cards .plan-card').first()).toBeVisible();
    await expect(page.locator('#overview-setup-path')).toHaveCount(0);
    await expect(page.locator('#dry-run-banner')).toBeVisible();
  });

  test('overview empty state links to the Devices settings page', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#plan-cards .plan-card').first()).toBeVisible();

    // Push a device-less plan over the realtime seam (the boot fixture always
    // ships plan devices, so the zero-managed state is only reachable live).
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

    // Two #plan-empty nodes exist (static first-paint placeholder + the Preact
    // render); assert against the visible one.
    await expect(page.locator('#plan-empty').filter({ visible: true })).toContainText('No managed devices');
    await page.locator('#plan-empty-manage-devices').click();
    await expect(page.locator('#devices-panel')).toBeVisible();
  });
});
