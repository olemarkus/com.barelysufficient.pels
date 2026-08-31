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

    const banner = page.locator('#stale-data-banner');
    await expect(banner).toBeVisible();
    // The never-received flow arm names BOTH remedies — the one honest arm
    // for an install where detection found nothing.
    await expect(banner).toContainText('No power readings yet');
    await expect(banner).toContainText('Set up a Flow with the Report power usage action');
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

    const banner = page.locator('#stale-data-banner');
    await expect(banner).toContainText('No power readings yet');

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
          softLimitKw: 5,
          capacitySoftLimitKw: 5,
          budgetPaceKw: null,
          projectedExemptKw: null,
          softLimitSource: 'capacity',
          headroomKw: 5,
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
