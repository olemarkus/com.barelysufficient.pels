import { renderTest as test, expect } from './fixtures/test';

const EXTERNAL_OFF_COPY = 'Turned off elsewhere — turn it on to resume';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
      settings: { capacity_dry_run: false },
    };
  });
});

test('distinguishes an observed Off device from an on-but-idle device', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  await page.evaluate(() => {
    type PlanDevice = Record<string, unknown> & { id: string };
    type PlanSnapshot = { devices: PlanDevice[] };
    type StubWindow = Window & {
      Homey: {
        __stub: {
          getSetting: (key: string) => unknown;
          emitHomeyEvent: (event: string, payload: unknown) => void;
        };
      };
    };

    const homey = (window as unknown as StubWindow).Homey;
    const plan = homey.__stub.getSetting('plan_snapshot') as PlanSnapshot;
    const device = (id: string): PlanDevice => {
      const found = plan.devices.find((candidate) => candidate.id === id);
      if (!found) throw new Error(`Missing fixture plan device ${id}`);
      return found;
    };
    const temperature = (
      baseId: string,
      currentState: 'on' | 'off',
      reason: Record<string, unknown>,
    ): PlanDevice => ({
      ...device(baseId),
      currentState,
      plannedState: 'inactive',
      stateKind: 'idle',
      stateTone: 'idle',
      temperature: { currentTarget: 5, currentTemperature: 18.7, plannedTarget: 5 },
      currentDrawKw: 0,
      reason,
    });
    const externalReason = { code: 'external_off_hold' };

    homey.__stub.emitHomeyEvent('plan_updated', {
      ...plan,
      devices: [
        temperature('dev_bedroom', 'on', { code: 'keep', detail: null }),
        temperature('dev_hallway', 'off', { code: 'keep', detail: null }),
        temperature('dev_heatpump', 'off', externalReason),
        {
          ...device('dev_waterheater'),
          currentState: 'off',
          plannedState: 'inactive',
          stateKind: 'idle',
          stateTone: 'idle',
          currentDrawKw: 0,
          reason: externalReason,
        },
        {
          ...device('dev_connected300'),
          currentState: 'off',
          plannedState: 'inactive',
          stateKind: 'idle',
          stateTone: 'idle',
          currentDrawKw: 0,
          reason: externalReason,
        },
        {
          ...device('dev_poolpump'),
          currentState: 'off',
          plannedState: 'inactive',
          stateKind: 'unavailable',
          stateTone: 'unavailable',
          currentDrawKw: 0,
          reason: externalReason,
        },
      ],
    });
  });

  const stateLabel = (deviceId: string) => (
    page.locator(`#plan-cards [data-device-id="${deviceId}"] .plan-card__state-label`)
  );
  const reasonLine = (deviceId: string) => (
    page.locator(
      `#plan-cards [data-device-id="${deviceId}"]`
      + ' :is(.plan-card__reason, .plan-card__temp-reason, .plan-card__status-line)',
    )
  );

  await expect(stateLabel('dev_bedroom')).toHaveText('Idle');
  await expect(stateLabel('dev_hallway')).toHaveText('Off');
  await expect(reasonLine('dev_hallway')).toHaveCount(0);

  for (const deviceId of ['dev_heatpump', 'dev_waterheater', 'dev_connected300']) {
    await expect(stateLabel(deviceId)).toHaveText('Off');
    await expect(reasonLine(deviceId)).toHaveText(EXTERNAL_OFF_COPY);
  }
  await expect(stateLabel('dev_poolpump')).toHaveText('Unavailable');
  await expect(reasonLine('dev_poolpump')).toHaveCount(0);

  const hasHorizontalOverflow = await page.evaluate(() => (
    document.documentElement.scrollWidth > document.documentElement.clientWidth
    || [...document.querySelectorAll<HTMLElement>('#plan-cards [data-device-id]')]
      .some((card) => card.scrollWidth > card.clientWidth)
  ));
  expect(hasHorizontalOverflow).toBe(false);

  await page.locator('#plan-cards [data-device-id="dev_heatpump"]').click();
  await expect(page.locator('#device-detail-live-state')).toHaveText('Off');
  await expect(page.locator('#device-detail-live-reason')).toHaveText(EXTERNAL_OFF_COPY);
  const detailHasHorizontalOverflow = await page.locator('#device-detail-panel').evaluate((panel) => (
    panel.scrollWidth > panel.clientWidth
  ));
  expect(detailHasHorizontalOverflow).toBe(false);

  await page.locator('#device-detail-close').click();
  await page.locator('#plan-cards [data-device-id="dev_poolpump"]').click();
  await expect(page.locator('#device-detail-live-state')).toHaveText('Unavailable');
  await expect(page.locator('#device-detail-live-reason')).toBeHidden();
});
