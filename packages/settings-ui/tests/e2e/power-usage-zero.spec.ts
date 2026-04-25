import { expect, test, type Page } from './fixtures/test';

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

const installFixedNow = async (page: Page, sampleCount: number) => {
  await page.addInitScript(({ fixedNowMs, tracker }) => {
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
    (window as unknown as { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
      settings: {
        power_tracker_state: tracker,
      },
    };
  }, { fixedNowMs: FIXED_NOW_MS, tracker: buildTrackerState(sampleCount) });
};

const openUsageTab = async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Usage' }).click();
  await expect(page.locator('#usage-panel')).toBeVisible();
  await expect(page.locator('#usage-day-chart')).toBeVisible();
  await expect(page.locator('#usage-day-bars svg').first()).toBeVisible();
};

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
