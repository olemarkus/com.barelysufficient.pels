import type { StubWindow } from '../stubWindow';
import { expect, type Page } from './test';

export type OverviewTaskFixture = {
  deviceId: string;
  deviceName: string;
  state: 'healthy' | 'price_off' | 'awaiting_prices' | 'unmanaged';
};

export const seedSecondOverviewTask = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    (window as unknown as StubWindow).__PELS_HOMEY_STUB__ = {
      settings: {
        'deferred_objective.dev_heatpump': {
          enabled: true, kind: 'temperature', enforcement: 'soft',
          targetTemperatureC: 23, deadlineAtMs: Date.now() + 8 * 3_600_000,
        },
      },
    };
  });
};

/** Push the owner-resolved reason; a UI setting change alone is not a plan diagnostic. */
export const pushOverviewTasks = async (page: Page, tasks: OverviewTaskFixture[]): Promise<void> => {
  await page.evaluate((entries) => {
    const nowMs = Date.now();
    const plansByDeviceId = Object.fromEntries(entries.map((task) => {
      const latest = {
        planStatus: 'on_track',
        hours: [{ startsAtMs: nowMs + 3_600_000, endsAtMs: nowMs + 2 * 3_600_000, plannedKWh: 2 }],
      };
      const reason = task.state === 'price_off' ? 'objective_price_feature_disabled'
        : task.state === 'unmanaged' ? 'objective_device_unmanaged' : undefined;
      return [task.deviceId, {
        deviceId: task.deviceId,
        deviceName: task.deviceName,
        objectiveKind: 'temperature',
        progressDirection: 'increasing',
        targetValue: 65,
        deadlineAtMs: nowMs + 6 * 3_600_000,
        pending: task.state === 'awaiting_prices',
        pendingReason: task.state === 'awaiting_prices' ? 'awaiting_horizon_plan' : undefined,
        diagnosticReasonCode: reason,
        liveCompletion: { kind: 'unavailable' },
        latest: task.state === 'awaiting_prices' ? null : latest,
      }];
    }));
    (window as unknown as StubWindow).Homey.__stub.emitHomeyEvent('deferred_objective_active_plans_updated', {
      version: 2, plansByDeviceId,
    });
  }, tasks);
};

export const openPriceAwareDevices = async (page: Page): Promise<void> => {
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-nav-card[data-settings-target="price-aware-devices"]').click();
  await expect(page.locator('#price-aware-devices-panel')).toBeVisible();
};

export const readRespondToPrices = async (page: Page): Promise<unknown> => (
  page.evaluate(() => new Promise((resolve, reject) => {
    (window as unknown as StubWindow).Homey.get('price_optimization_enabled', (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  }))
);
