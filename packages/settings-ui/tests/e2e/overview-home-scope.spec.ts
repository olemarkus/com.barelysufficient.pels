import { expect, test, type Page } from './fixtures/test';
import { pickHomeScope, seedStubSetting } from './fixtures/homes';

/* -------------------------------------------------------------------------- *
 * Per-home Overview (multi-home 6b): the Overview honours the shell's home
 * scope. Main selection keeps the whole-home hero and cards; picking a meter
 * area renders THAT AREA'S own plan (its `plan_snapshot:<id>` fixture) with
 * the Main-only smart-task row omitted; the area's suffixed `pels_status:<id>`
 * stream repaints the open panel; a Main `plan_updated` push (which re-seeds
 * the BARE cache entry) must never paint Main's plan under the area's name;
 * and an area the runtime cannot serve gets the honest notice instead of
 * fabricated numbers.
 * -------------------------------------------------------------------------- */

const AREA_ID = 'h_11111111';

// The rental area, pre-boot (a reload would wipe a post-boot store seed).
// `activationVersion: 1` = live runtime; omitting it = the held posture whose
// scoped reads answer `homeScope: unavailable`.
const rentalAreaConfig = (activated: boolean) => ({
  ...(activated ? { activationVersion: 1 } : {}),
  subHomes: [{
    homeId: AREA_ID,
    name: 'Rental unit',
    rootZoneId: 'z_rental',
    meterDeviceId: 'dev_rental_meter',
  }],
});

const buildPlanFixture = (totalKw: number, device: { id: string; name: string }) => ({
  meta: {
    totalKw,
    lastPowerUpdateMs: Date.now() - 5 * 1000,
    softLimitKw: 3,
    capacitySoftLimitKw: 3,
    budgetPaceKw: null,
    projectedExemptKw: null,
    softLimitSource: 'capacity',
    powerIsMeasured: true,
    hardCapLimitKw: 10,
    controlledKw: 0.5,
    uncontrolledKw: Math.max(0, totalKw - 0.5),
    usedKWh: 0.2,
    hourBudgetKWh: 3,
    minutesRemaining: 30,
  },
  devices: [{
    id: device.id,
    name: device.name,
    currentState: 'on',
    plannedState: 'keep',
    priority: 1,
    controllable: true,
    available: true,
    currentDrawKw: 0.5,
    reason: { code: 'keep', detail: null },
  }],
});

const installStubSettings = async (page: Page, settings: Record<string, unknown>) => {
  await page.addInitScript((stubSettings) => {
    const stubWindow = window as unknown as {
      __PELS_HOMEY_STUB__?: { settings?: Record<string, unknown> };
    };
    stubWindow.__PELS_HOMEY_STUB__ = {
      ...(stubWindow.__PELS_HOMEY_STUB__ ?? {}),
      settings: { ...(stubWindow.__PELS_HOMEY_STUB__?.settings ?? {}), ...stubSettings },
    };
  }, settings);
};

const emitStubSettingSet = (page: Page, key: string) => page.evaluate((settingKey) => {
  (window as unknown as {
    Homey: { __stub: { emitSettingsSet: (k: string) => void } };
  }).Homey.__stub.emitSettingsSet(settingKey);
}, key);

const emitHomeyEvent = (page: Page, event: string, payload: unknown) => page.evaluate(([e, p]) => {
  (window as unknown as {
    Homey: { __stub: { emitHomeyEvent: (event: string, payload: unknown) => void } };
  }).Homey.__stub.emitHomeyEvent(e as string, p);
}, [event, payload] as const);

const heroPowerValue = (page: Page) => page.locator('.plan-hero__metric-value').first();

const openOverview = async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#overview-panel')).toBeVisible();
  await expect(heroPowerValue(page)).toBeVisible();
};

test.describe('Overview follows the shown home', () => {
  test('a meter area shows its own hero and cards, live on its suffixed stream', async ({ page }) => {
    await installStubSettings(page, {
      homes_config: rentalAreaConfig(true),
      // Pin a real device into the area. The Overview renders the area's DEVICE
      // list joined to its plan, so the plan must be about a device that is
      // actually a member — a plan device with no device row is a shape the
      // producer cannot build.
      device_home_assignments: { dev_bedroom: AREA_ID },
      // ...and Main's plan must stop naming it, which is what the runtime does
      // when a device moves to a meter area. The default fixture plan is static
      // and would otherwise keep deciding for a device Main no longer owns.
      plan_snapshot: buildPlanFixture(1.5, { id: 'dev_heatpump', name: 'Living Room Heat Pump' }),
      [`plan_snapshot:${AREA_ID}`]: buildPlanFixture(0.7, { id: 'dev_bedroom', name: 'Bedroom Thermostat' }),
      [`pels_status:${AREA_ID}`]: { powerNowKw: 0.7 },
    });
    await openOverview(page);

    // Main selection: the unchanged whole-home hero and cards, and the scope
    // bar now renders on the Overview (the panel honours the scope as of this
    // change). The smart-task row is the Main home's.
    await expect(heroPowerValue(page)).toHaveText('1.5');
    await expect(page.locator('#home-scope-chip')).toBeVisible();
    await expect(page.locator('#plan-smart-task-row')).toBeVisible();

    // Pick the area: its OWN plan renders — hero, cards — never Main's under
    // a badge, and the Main-only smart-task row is omitted as not-applicable.
    await pickHomeScope(page, AREA_ID);
    await expect(heroPowerValue(page)).toHaveText('0.7');
    await expect(page.locator('#plan-cards [data-device-id="dev_bedroom"]')).toBeVisible();
    await expect(page.locator('#plan-cards [data-device-id="dev_heatpump"]')).toHaveCount(0);
    await expect(page.locator('#plan-smart-task-row')).toHaveCount(0);

    // The area's suffixed `pels_status:<id>` write is its only realtime
    // freshness signal (`plan_updated` stays Main's); it must repaint the
    // open panel from the area's scoped read.
    await seedStubSetting(
      page,
      `plan_snapshot:${AREA_ID}`,
      buildPlanFixture(1.2, { id: 'dev_bedroom', name: 'Bedroom Thermostat' }),
    );
    await emitStubSettingSet(page, `pels_status:${AREA_ID}`);
    await expect(heroPowerValue(page)).toHaveText('1.2');

    // THE TRAP: a Main `plan_updated` push re-seeds the BARE cache entry with
    // Main's payload. It must not repaint the selected area's Overview.
    await emitHomeyEvent(
      page,
      'plan_updated',
      buildPlanFixture(6.4, { id: 'dev_heatpump', name: 'Living Room Heat Pump' }),
    );
    await expect(heroPowerValue(page)).toHaveText('1.2');
    await expect(page.locator('#plan-cards [data-device-id="dev_heatpump"]')).toHaveCount(0);

    // Back to Main: the whole-home Overview returns, smart-task row included.
    await pickHomeScope(page, 'main');
    await expect(heroPowerValue(page)).toHaveText('1.5');
    await expect(page.locator('#plan-cards [data-device-id="dev_heatpump"]')).toBeVisible();
    await expect(page.locator('#plan-cards [data-device-id="dev_bedroom"]')).toHaveCount(0);
    await expect(page.locator('#plan-smart-task-row')).toBeVisible();
  });

  test('an area the runtime cannot serve shows the honest notice, not fabricated numbers', async ({ page }) => {
    // Held posture: rostered, but not activated — the scoped read answers
    // `homeScope: unavailable`.
    await installStubSettings(page, {
      homes_config: rentalAreaConfig(false),
    });
    await openOverview(page);
    await pickHomeScope(page, AREA_ID);

    const notice = page.locator('#plan-scope-unavailable');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Status couldn’t be read');
    await expect(notice).toContainText('pick another part of the home above');
    // The hero and cards hide behind the claim — a `0.0 kW` here would read
    // as the area's measurement. (Scoped to the Overview panel: other hidden
    // panels keep their own static hero skeletons.)
    await expect(page.locator('#overview-panel .plan-hero')).toHaveCount(0);
    await expect(page.locator('#overview-panel [data-device-id]')).toHaveCount(0);

    await pickHomeScope(page, 'main');
    await expect(notice).toHaveCount(0);
    await expect(heroPowerValue(page)).toHaveText('1.5');
  });
});
