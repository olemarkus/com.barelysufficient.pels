import { expect, renderTest as test, loadSpaceGrotesk } from './fixtures/test';
import type { StubWindow } from './stubWindow';

test.use({ viewport: { width: 320, height: 900 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const mainId = 'north-charger';
    const secondaryId = 'south-charger';
    const mainName = 'North driveway charger';
    const installation = { id: 'driveway', mainId, memberIds: [mainId, secondaryId] };
    const chargers = [
      { id: mainId, name: mainName, measuredPowerKw: 3.2, role: 'main' },
      { id: secondaryId, name: 'South driveway charger', measuredPowerKw: 0, role: 'secondary' },
    ];
    (window as unknown as StubWindow).__PELS_HOMEY_STUB__ = {
      settings: {
        target_devices_snapshot: [
          ...chargers.map(({ id, name, measuredPowerKw }) => ({
            id, name, measuredPowerKw, available: true, deviceClass: 'evcharger', isEvCharger: true,
            capabilities: ['evcharger_charging', 'measure_power'],
            binaryControllable: true, canSetControl: true, powerCapable: true, targets: [],
            controlAdapter: { kind: 'capability_adapter', activationRequired: false, activationEnabled: true,
              chargingInstallation: installation },
          })),
          { id: 'heater', name: 'Hall heater', available: true, deviceType: 'temperature',
            capabilities: ['onoff'], measuredPowerKw: 0.3, powerCapable: true,
            targets: [{ name: 'target_temperature', value: 20 }] },
        ],
        managed_devices: { [mainId]: true, [secondaryId]: true, heater: true },
        controllable_devices: { [mainId]: true, [secondaryId]: true, heater: true },
        capacity_priorities: { Home: { [mainId]: 1, heater: 2, [secondaryId]: 3 } },
        plan_snapshot: {
          meta: {
            gridImportLimitKw: null, gridImportTargetKw: null, totalKw: 11, lastPowerUpdateMs: Date.now(),
            softLimitKw: 12, capacitySoftLimitKw: 12, budgetPaceKw: null, projectedExemptKw: null,
            softLimitSource: 'capacity', capacityPeriodMinutes: 60, capacityPeriodCoverageComplete: true,
            powerIsMeasured: true, hardCapLimitKw: 13, hardCapSource: 'configured', configuredHardCapLimitKw: 13,
            controlledKw: 10.4, uncontrolledKw: 0.6, usedKWh: 5, hourBudgetKWh: 13, minutesRemaining: 30,
          },
          devices: chargers.map(({ id, name, measuredPowerKw, role }) => {
            const main = role === 'main';
            return { id, name, currentDrawKw: measuredPowerKw, isEvCharger: true, status: {
              cardKind: main ? 'stepped' : 'binary', kind: main ? 'active' : 'idle',
              tone: main ? 'active' : 'idle', label: main ? 'Running' : 'Idle',
              powerText: main ? '3.2 kW · installation 10.4 kW' : '0.0 kW',
              powerVariant: 'live', factText: main ? 'Charging' : 'Waiting for current',
              reason: { text: main ? 'Sets the available current for this installation.'
                : `Its current is set through ${mainName}. The chargers share the available current between the cars that are charging.` },
              reading: null, rail: null, limited: false, wouldLimit: false, canEaseOff: false,
              controlOffDrawing: false, holdCause: null,
            } };
          }),
        },
      },
      apiHandlers: {
        'GET /ui_charging_current': () => chargers.map(({ id, name, role }) => ({
          deviceId: id, name, setup: { method: 'flow', confirmation: 'none' }, supportsAppAction: false,
          capabilityWritable: false, scope: 'installation', sharedInstallation: false,
          flowCheck: 'clear', flowNames: [], currentRoute: 'built_in', missingCompanion: 'none',
          chargingInstallation: { role, mainName, automaticWatts: role === 'main' },
        })),
        'GET /ui_charging_access': () => ({ configured: false, state: 'not_configured' }),
      },
    };
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await loadSpaceGrotesk(page);
});

test('fits the installation’s charger cards and current setup at 320 px', async ({ page }) => {
  const main = page.locator('#plan-cards [data-device-id="north-charger"]');
  const secondary = page.locator('#plan-cards [data-device-id="south-charger"]');
  await expect(main).toContainText('3.2 kW · installation 10.4 kW');
  await expect(main).toContainText('Sets the available current for this installation.');
  await expect(secondary).toContainText('Waiting for current');
  await expect(secondary).toContainText('Its current is set through North driveway charger.');
  for (const card of [main, secondary]) {
    expect(await card.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  }

  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-nav-card[data-settings-target="devices"]').click();
  await page.locator('#devices-panel [data-device-id="south-charger"] .pels-device-card__detail-button').click();
  await page.locator('#device-detail-setup-disclosure summary').first().click();
  const setup = page.locator('#device-detail-charging-current');
  await expect(setup).toContainText('PELS sets the available current for this installation through North driveway charger.');
  await expect(setup.getByRole('button', { name: 'Use a Flow' })).toHaveCount(0);
  expect(await setup.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
});

test('moves the whole priority group when its secondary charger moves', async ({ page }) => {
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-nav-card[data-settings-target="modes"]').click();
  const rows = page.locator('#priority-list .device-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute('data-device-id', 'north-charger');
  await expect(rows.nth(1)).toHaveAttribute('data-device-id', 'south-charger');
  await expect(rows.getByText('Shares priority with the other chargers on this installation.')).toHaveCount(2);

  const handle = rows.nth(1).locator('.drag-handle');
  await handle.scrollIntoViewIfNeeded();
  const handleBox = await handle.boundingBox();
  const heaterBox = await rows.nth(2).boundingBox();
  if (!handleBox || !heaterBox) throw new Error('Priority rows are unavailable');
  const x = handleBox.x + handleBox.width / 2;
  await page.mouse.move(x, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, heaterBox.y + heaterBox.height - 3, { steps: 12 });
  await page.mouse.up();

  const readPriorities = () => page.evaluate(() => new Promise((resolve, reject) => {
    (window as unknown as StubWindow).Homey.get('capacity_priorities', (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  }));
  await expect.poll(readPriorities).toEqual({ Home: { heater: 1, 'north-charger': 2, 'south-charger': 3 } });
  await expect(rows.nth(0)).toHaveAttribute('data-device-id', 'heater');
  await expect(rows.nth(1)).toHaveAttribute('data-device-id', 'north-charger');
  await expect(rows.nth(2)).toHaveAttribute('data-device-id', 'south-charger');
  await expect(rows.locator('.priority-badge')).toHaveText(['#1', '#2', '#2']);
});
