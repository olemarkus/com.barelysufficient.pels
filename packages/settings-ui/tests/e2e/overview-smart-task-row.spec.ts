/**
 * Overview smart-task failure/readiness row (2026-07 coherence train, PR-4):
 * one slim tappable row between the hero and the device cards, exception-first
 * — live cannot-finish → recent-miss rollup → at-risk → paused → steady —
 * routing to the Smart tasks tab. Ladder + copy in
 * `shared-domain/overviewSmartTaskRow.ts`.
 */
import { expect } from '@playwright/test';
import { renderTest as test } from './fixtures/test';

const ROW = '#plan-smart-task-row';

test('steady variant: the default fixture (one healthy task) renders the muted aggregate', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const row = page.locator(ROW);
  await expect(row).toHaveText(/1 smart task · on track/);
  await expect(row).toHaveAttribute('data-variant', 'steady');
});

test('cannot-finish outranks steady and swaps Ready by → Due', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const homey = (window as unknown as {
      Homey: {
        __stub: {
          setSetting: (k: string, v: unknown) => void;
          emitSettingsSet: (k: string) => void;
        };
      };
    }).Homey;
    // Write the raw persisted active-plans setting (the Overview reloads it on
    // the settings.set realtime event) with the fixture task flipped to a
    // cannot-finish verdict.
    homey.__stub.setSetting('deferred_objective_active_plans', {
      version: 1,
      plansByDeviceId: {
        dev_connected300: {
          pending: false,
          deviceName: 'Connected 300',
          latest: {
            planStatus: 'cannot_meet',
            hours: [{ startsAtMs: Date.now() + 3_600_000 }],
          },
        },
      },
    });
    homey.__stub.emitSettingsSet('deferred_objective_active_plans');
  });
  const row = page.locator(ROW);
  await expect(row).toHaveAttribute('data-variant', 'cannot_finish');
  await expect(row).toContainText('Connected 300');
  await expect(row).toContainText('Cannot finish · Due ');
  await expect(row).not.toContainText('Ready by');
});

test('miss-streak rollup renders for the failing-recovering visitor and taps through to Smart tasks', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __PELS_HOMEY_STUB__?: { apiHandlers?: Record<string, () => unknown> };
    };
    const entry = (id: string, outcome: string, finalizedAtMs: number) => ({
      id,
      deviceId: 'dev_waterheater',
      deviceName: 'Water Heater',
      objectiveKind: 'temperature',
      outcome,
      finalizedAtMs,
      deadlineAtMs: finalizedAtMs,
      targetValue: 65,
    });
    w.__PELS_HOMEY_STUB__ = {
      ...(w.__PELS_HOMEY_STUB__ ?? {}),
      apiHandlers: {
        'GET /ui_deferred_objective_history': () => ({
          version: 1,
          entriesByDeviceId: {
            dev_waterheater: [
              entry('h4', 'missed', 4_000),
              entry('h3', 'missed', 3_000),
              entry('h2', 'missed', 2_000),
              entry('h1', 'met', 1_000),
            ],
          },
        }),
      },
    };
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const row = page.locator(ROW);
  await expect(row).toHaveAttribute('data-variant', 'miss_streak');
  await expect(row).toHaveText(/Water Heater — 3 of last 4 runs missed/);

  await row.click();
  await expect(page.locator('#deadlines-panel')).toBeVisible();
});

test('the miss rollup refreshes when new history finalizes (no stale cached read)', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __PELS_HOMEY_STUB__?: { apiHandlers?: Record<string, () => unknown> };
      __historyBroken?: boolean;
    };
    const entry = (id: string, outcome: string, finalizedAtMs: number) => ({
      id,
      deviceId: 'dev_waterheater',
      deviceName: 'Water Heater',
      objectiveKind: 'temperature',
      outcome,
      finalizedAtMs,
      deadlineAtMs: finalizedAtMs,
      targetValue: 65,
    });
    w.__PELS_HOMEY_STUB__ = {
      ...(w.__PELS_HOMEY_STUB__ ?? {}),
      apiHandlers: {
        // Starts healthy; the test flips `__historyBroken` mid-session to
        // simulate runs finalizing as misses while the Overview stays open.
        'GET /ui_deferred_objective_history': () => ({
          version: 1,
          entriesByDeviceId: w.__historyBroken
            ? {
              dev_waterheater: [
                entry('h4', 'missed', 4_000),
                entry('h3', 'missed', 3_000),
                entry('h2', 'missed', 2_000),
                entry('h1', 'met', 1_000),
              ],
            }
            : {},
        }),
      },
    };
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const row = page.locator('#plan-smart-task-row');
  await expect(row).toHaveAttribute('data-variant', 'steady');

  await page.evaluate(() => {
    (window as unknown as { __historyBroken?: boolean }).__historyBroken = true;
  });
  // A tab round-trip re-runs the Overview refresh (the same path a returning
  // user takes); the row must pick the fresh history up, not a cached read.
  await page.getByRole('tab', { name: 'Budget' }).click();
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(row).toHaveAttribute('data-variant', 'miss_streak');
  await expect(row).toHaveText(/Water Heater — 3 of last 4 runs missed/);
});
