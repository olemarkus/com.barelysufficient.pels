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

test('a scheduled task explains its waiting period and the checks that have not run', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const section = page.locator('#plan-smart-task-status');
  await expect(section).toContainText('Next scheduled period starts at');
  await section.getByRole('button', { name: 'What is this task waiting for? (Connected 300)' }).click();
  const dialog = page.locator('md-dialog[open]');
  await expect(dialog).toContainText('Run time scheduled');
  await expect(dialog).toContainText('Not checked yet');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(ROW)).toHaveCount(0);
});

test('cannot-finish replaces the scheduled status with an actionable status', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#plan-smart-task-status')).toContainText('Next scheduled period starts at');
  await page.evaluate(() => {
    const homey = (window as unknown as {
      Homey: {
        __stub: {
          emitHomeyEvent: (event: string, ...args: unknown[]) => void;
        };
      };
    }).Homey;
    // Push the active plans as the runtime does on a save (the Overview
    // applies the `deferred_objective_active_plans_updated` payload directly)
    // with the fixture task flipped to a cannot-finish verdict.
    homey.__stub.emitHomeyEvent('deferred_objective_active_plans_updated', {
      version: 2,
      plansByDeviceId: {
        dev_connected300: {
          pending: false,
          deviceName: 'Connected 300',
          // The producer always writes the deadline (the row's Due time).
          deadlineAtMs: Date.now() + 6 * 3_600_000,
          latest: {
            planStatus: 'cannot_meet',
            hours: [{ startsAtMs: Date.now() + 3_600_000, endsAtMs: (Date.now() + 3_600_000) + 3_600_000, plannedKWh: 2 }],
          },
        },
      },
    });
  });
  const row = page.locator('#plan-smart-task-status [data-task-device-id="dev_connected300"]');
  await expect(row).toHaveAttribute('data-tone', 'alert');
  await expect(row).toContainText('Connected 300');
  await expect(row).toContainText('Cannot finish');
  await expect(row.getByRole('button', { name: 'View task', exact: true })).toBeVisible();
  await expect(row).not.toContainText('Ready by');
  await expect(page.locator(ROW)).toHaveCount(0);
});

// Keep the rollup fixture inside the seven-day window and outside the first
// day, when the recent-miss notice takes the place of this device's rollup.
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
      startedAtMs: finalizedAtMs - 3_600_000,
      targetValue: 65,
    });
    w.__PELS_HOMEY_STUB__ = {
      ...(w.__PELS_HOMEY_STUB__ ?? {}),
      apiHandlers: {
        'GET /ui_deferred_objective_history': () => ({
          version: 1,
          entriesByDeviceId: {
            dev_waterheater: [
              entry('h4', 'missed', Date.now() - 25 * 3_600_000),
              entry('h3', 'missed', Date.now() - 26 * 3_600_000),
              entry('h2', 'missed', Date.now() - 27 * 3_600_000),
              entry('h1', 'met', Date.now() - 28 * 3_600_000),
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

  // Current failures and recent misses convey different facts; keep both.
  await page.evaluate(() => {
    const homey = (window as unknown as {
      Homey: { __stub: { emitHomeyEvent: (event: string, payload: unknown) => void } };
    }).Homey;
    homey.__stub.emitHomeyEvent('deferred_objective_active_plans_updated', {
      version: 2,
      plansByDeviceId: {
        dev_connected300: {
          pending: false, deviceName: 'Connected 300', deadlineAtMs: Date.now() + 6 * 3_600_000,
          latest: { planStatus: 'cannot_meet', hours: [] },
        },
      },
    });
  });
  await expect(page.locator('#plan-smart-task-status')).toContainText('Cannot finish');
  await expect(row).toHaveAttribute('data-variant', 'miss_streak');

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
      startedAtMs: finalizedAtMs - 3_600_000,
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
                entry('h4', 'missed', Date.now() - 25 * 3_600_000),
                entry('h3', 'missed', Date.now() - 26 * 3_600_000),
                entry('h2', 'missed', Date.now() - 27 * 3_600_000),
                entry('h1', 'met', Date.now() - 28 * 3_600_000),
              ],
            }
            : {},
        }),
      },
    };
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const row = page.locator('#plan-smart-task-row');
  await expect(page.locator('#plan-smart-task-status')).toContainText('Next scheduled period starts at');

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
