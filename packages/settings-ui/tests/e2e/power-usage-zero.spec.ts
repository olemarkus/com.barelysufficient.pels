import { expect, test, type Page } from './fixtures/test';
import { pickHomeScope, seedStubSetting } from './fixtures/homes';

const FIXED_NOW_MS = Date.UTC(2025, 0, 6, 12, 0, 0);

const buildTrackerState = (sampleCount: number, nowMs = FIXED_NOW_MS) => {
  const currentHourStartMs = nowMs - (nowMs % (60 * 60 * 1000));
  const currentHourIso = new Date(currentHourStartMs).toISOString();
  return {
    buckets: {
      [currentHourIso]: 0,
    },
    hourlySampleCounts: {
      [currentHourIso]: sampleCount,
    },
    unreliablePeriods: [{
      start: currentHourStartMs - 60 * 1000,
      end: currentHourStartMs + 60 * 1000,
    }],
  };
};

const installFixedNowWithSettings = async (page: Page, settings: Record<string, unknown>) => {
  await page.addInitScript(({ fixedNowMs, stubSettings }) => {
    const RealDate = Date;
    class FixedDate extends RealDate {
      constructor(value?: number | string | Date) {
        if (value === undefined) {
          super(fixedNowMs);
          return;
        }
        super(value);
      }

      static override now(): number {
        return fixedNowMs;
      }
    }

    Object.defineProperty(window, 'Date', {
      configurable: true,
      writable: true,
      value: FixedDate,
    });
    const stubWindow = window as unknown as {
      __PELS_HOMEY_STUB__?: { settings?: Record<string, unknown> };
    };
    stubWindow.__PELS_HOMEY_STUB__ = {
      ...(stubWindow.__PELS_HOMEY_STUB__ ?? {}),
      settings: { ...(stubWindow.__PELS_HOMEY_STUB__?.settings ?? {}), ...stubSettings },
    };
  }, { fixedNowMs: FIXED_NOW_MS, stubSettings: settings });
};

const installFixedNow = (page: Page, sampleCount: number) => (
  installFixedNowWithSettings(page, { power_tracker_state: buildTrackerState(sampleCount) })
);

const openUsageTab = async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Usage' }).click();
  await expect(page.locator('#usage-panel')).toBeVisible();
  await expect(page.locator('#usage-day-chart')).toBeVisible();
  await expect(page.locator('#usage-day-bars svg').first()).toBeVisible();
};

/* -------------------------------------------------------------------------- *
 * Per-home Usage (multi-home 7c): the Usage tab honours the shell's home
 * scope. Main selection keeps the whole-home history; picking a meter area
 * renders THAT AREA'S suffixed tracker (its own `power_tracker_state:<id>`
 * fixture), its suffixed settings.set stream repaints the open panel, and an
 * area the runtime cannot serve gets the honest unavailable notice instead of
 * fabricated zeros.
 * -------------------------------------------------------------------------- */

const AREA_ID = 'h_11111111';

// The rental area, pre-boot (the Usage scenario is a home whose area already
// exists — the reload inside `openUsageTab` would wipe a post-boot store
// seed). `activationVersion: 1` = live runtime; omitting it = the held
// posture whose scoped reads answer `homeScope: unavailable`.
const rentalAreaConfig = (activated: boolean) => ({
  ...(activated ? { activationVersion: 1 } : {}),
  subHomes: [{
    homeId: AREA_ID,
    name: 'Rental unit',
    rootZoneId: 'z_rental',
    meterDeviceId: 'dev_rental_meter',
  }],
});

const buildScopedTracker = (kWh: number) => {
  const currentHourStartMs = FIXED_NOW_MS - (FIXED_NOW_MS % (60 * 60 * 1000));
  const currentHourIso = new Date(currentHourStartMs).toISOString();
  return {
    // Latched: production `recordPowerSample` stamps `lastPowerW` and
    // `lastTimestamp` together, and the stub's status classification keys on
    // the latch — without it this scene would silently model a GATED home.
    lastPowerW: 1200,
    lastTimestamp: FIXED_NOW_MS - 12_000,
    buckets: { [currentHourIso]: kWh },
    hourlySampleCounts: { [currentHourIso]: 6 },
  };
};

const emitStubSettingSet = (page: Page, key: string) => page.evaluate((settingKey) => {
  (window as unknown as {
    Homey: { __stub: { emitSettingsSet: (k: string) => void } };
  }).Homey.__stub.emitSettingsSet(settingKey);
}, key);

test.describe('Usage follows the shown home', () => {
  test('a meter area shows its own history, live on its suffixed stream', async ({ page }) => {
    await installFixedNowWithSettings(page, {
      homes_config: rentalAreaConfig(true),
      power_tracker_state: buildScopedTracker(2),
      [`power_tracker_state:${AREA_ID}`]: buildScopedTracker(0.7),
    });
    await openUsageTab(page);

    // Main selection: the unchanged whole-home history, and the scope bar now
    // renders on Usage (the panel honours the scope as of this change).
    await expect(page.locator('#usage-hero-headline')).toHaveText('2.0 kWh today');
    await expect(page.locator('#home-scope-chip')).toBeVisible();

    // Pick the area: its OWN tracker renders — never Main's under a badge.
    await pickHomeScope(page, AREA_ID);
    await expect(page.locator('#usage-hero-headline')).toHaveText('0.7 kWh today');

    // The area's suffixed tracker write is its only realtime freshness
    // signal (`power_updated` stays Main's); it must repaint the open panel.
    await seedStubSetting(page, `power_tracker_state:${AREA_ID}`, buildScopedTracker(1.4));
    await emitStubSettingSet(page, `power_tracker_state:${AREA_ID}`);
    await expect(page.locator('#usage-hero-headline')).toHaveText('1.4 kWh today');

    // Back to Main: the whole-home history returns.
    await pickHomeScope(page, 'main');
    await expect(page.locator('#usage-hero-headline')).toHaveText('2.0 kWh today');
  });

  test('the Budget overage recourse lands Usage on the Main home', async ({ page }) => {
    await installFixedNowWithSettings(page, {
      homes_config: rentalAreaConfig(true),
      power_tracker_state: buildScopedTracker(2),
      [`power_tracker_state:${AREA_ID}`]: buildScopedTracker(0.7),
    });
    await openUsageTab(page);
    await pickHomeScope(page, AREA_ID);
    await expect(page.locator('#usage-hero-headline')).toHaveText('0.7 kWh today');

    // Put today over budget with the overage in BACKGROUND usage, so the
    // Budget hero offers the "Open Usage" recourse — the deep link under test.
    // Patch the payload the Budget activation refetches: a 1 kWh budget the
    // projection tops, and zeroed elapsed actuals so the dominant cause
    // resolves to background.
    await page.evaluate(async () => {
      const homey = (window as unknown as {
        Homey: {
          api: (method: string, uri: string, cb: (err: unknown, res?: unknown) => void) => void;
          __stub: { setDailyBudgetPayload: (payload: unknown) => void };
        };
      }).Homey;
      const read = await new Promise<{
        kind: string;
        payload: {
          days: Record<string, {
            budget: { dailyBudgetKWh: number };
            buckets: { actualKWh: number[] };
          }>;
          todayKey: string;
        };
      }>((resolve, reject) => {
        homey.api('GET', '/daily_budget', (err, res) => (
          err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(res as never)
        ));
      });
      const { payload } = read;
      const today = payload.days[payload.todayKey];
      today.budget.dailyBudgetKWh = 1;
      today.buckets.actualKWh = today.buckets.actualKWh.map(() => 0);
      homey.__stub.setDailyBudgetPayload(payload);
    });

    await page.getByRole('tab', { name: 'Budget' }).click();
    const recourse = page.locator('#budget-redesign-hero-recourse');
    await expect(recourse).toHaveText('Open Usage');
    await recourse.click();

    // The daily budget is a Main-home constraint: the destination must show
    // MAIN's history, not the previously selected area's — the area could
    // never explain the overage.
    await expect(page.locator('#usage-panel')).toBeVisible();
    await expect(page.locator('#home-scope-chip')).toHaveText('Main home');
    await expect(page.locator('#usage-hero-headline')).toHaveText('2.0 kWh today');
  });

  test('an area the runtime cannot serve shows the honest notice, not zeros', async ({ page }) => {
    // Held posture: rostered, but not activated — the scoped read answers
    // `homeScope: unavailable`.
    await installFixedNowWithSettings(page, {
      homes_config: rentalAreaConfig(false),
      power_tracker_state: buildScopedTracker(2),
    });
    await openUsageTab(page);
    await pickHomeScope(page, AREA_ID);

    const notice = page.locator('#usage-scope-unavailable');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Usage couldn’t be read');
    await expect(notice).toContainText('pick another part of the home above');
    // The data sections hide behind the claim — a `0.0 kWh today` here would
    // read as the area's measurement.
    await expect(page.locator('#usage-hero')).toBeHidden();
    await expect(page.locator('#usage-day-total')).toBeHidden();

    await pickHomeScope(page, 'main');
    await expect(notice).toBeHidden();
    await expect(page.locator('#usage-hero-headline')).toHaveText('2.0 kWh today');
  });
});

test.describe('Usage zero-value handling', () => {
  test('shows a warning for a cross-hour outage with only one zero sample', async ({ page }) => {
    await installFixedNow(page, 1);
    await openUsageTab(page);

    await expect(page.locator('#usage-day-empty')).toBeHidden();
    await expect(page.locator('#usage-day-total')).toHaveText('0.0 kWh');
    await expect(page.locator('#usage-day-status-pill')).toBeVisible();
    await expect(page.locator('#usage-day-status-pill')).toHaveText('Warnings (1h)');
  });

  test('treats repeated zero samples in the hour as valid data', async ({ page }) => {
    await installFixedNow(page, 6);
    await openUsageTab(page);

    await expect(page.locator('#usage-day-empty')).toBeHidden();
    await expect(page.locator('#usage-day-total')).toHaveText('0.0 kWh');
    await expect(page.locator('#usage-day-status-pill')).toBeHidden();
  });
});
