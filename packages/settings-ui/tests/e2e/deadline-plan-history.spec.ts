import { expect, test, type Page } from './fixtures/test';

const stubHistory = (entries: Record<string, unknown[]>) => {
  (window as typeof window & { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
    apiHandlers: {
      'GET /ui_deferred_objective_history': () => ({
        version: 1,
        entriesByDeviceId: entries,
      }),
    },
  };
};

const openPage = async (page: Page) => {
  await page.goto('/deadline-plan.html?deviceId=dev_connected300', { waitUntil: 'domcontentloaded' });
};

test.describe('Deadline plan history tab', () => {
  test('renders past plans when switching to the History tab', async ({ page }) => {
    await page.addInitScript(stubHistory, {
      dev_connected300: [
        {
          deviceId: 'dev_connected300',
          deviceName: 'Connected 300',
          objectiveKind: 'temperature',
          targetTemperatureC: 65,
          targetPercent: null,
          deadlineAtMs: Date.UTC(2026, 4, 6, 6, 0, 0),
          startedAtMs: Date.UTC(2026, 4, 6, 0, 0, 0),
          finalizedAtMs: Date.UTC(2026, 4, 6, 6, 0, 0),
          startProgressC: 50,
          startProgressPercent: null,
          finalProgressC: 65,
          finalProgressPercent: null,
          initialEnergyNeededKWh: 22.5,
          outcome: 'met',
          metAtMs: Date.UTC(2026, 4, 6, 4, 42, 0),
          usedDeadlineReserve: false,
          usedPolicyAvoid: true,
          observedIntervals: [{
            fromMs: Date.UTC(2026, 4, 6, 0, 0, 0),
            toMs: Date.UTC(2026, 4, 6, 6, 0, 0),
          }],
          discoveredFrom: 'observation',
        },
        {
          deviceId: 'dev_connected300',
          deviceName: 'Connected 300',
          objectiveKind: 'temperature',
          targetTemperatureC: 65,
          targetPercent: null,
          deadlineAtMs: Date.UTC(2026, 4, 5, 6, 0, 0),
          startedAtMs: Date.UTC(2026, 4, 5, 0, 0, 0),
          finalizedAtMs: Date.UTC(2026, 4, 5, 6, 0, 0),
          startProgressC: 50,
          startProgressPercent: null,
          finalProgressC: 58,
          finalProgressPercent: null,
          initialEnergyNeededKWh: 22.5,
          outcome: 'missed',
          metAtMs: null,
          usedDeadlineReserve: false,
          usedPolicyAvoid: false,
          observedIntervals: [{
            fromMs: Date.UTC(2026, 4, 5, 0, 0, 0),
            toMs: Date.UTC(2026, 4, 5, 6, 0, 0),
          }],
          discoveredFrom: 'observation',
        },
      ],
    });
    await page.setViewportSize({ width: 390, height: 780 });
    await openPage(page);

    // Tab strip is visible. Click History.
    await page.getByRole('button', { name: 'History' }).click();

    const list = page.getByLabel('Past plans');
    await expect(list).toBeVisible();
    // Two entries — newest first.
    const cards = list.locator('.plan-history-card');
    await expect(cards).toHaveCount(2);
    // First card is the May 6 met run with backup hours.
    await expect(cards.nth(0).locator('.plan-chip--ok')).toHaveText('Met');
    await expect(cards.nth(0).locator('.plan-chip--info')).toHaveText('Backup hours');
    // Second card is the May 5 missed run.
    await expect(cards.nth(1).locator('.plan-chip--warn')).toHaveText('Missed');
  });

  test('shows the empty state when no past plans exist for the device', async ({ page }) => {
    await page.addInitScript(stubHistory, {});
    await openPage(page);

    await page.getByRole('button', { name: 'History' }).click();
    await expect(page.getByLabel('Past plans')).toContainText('No past plans yet for this device.');
  });
});
