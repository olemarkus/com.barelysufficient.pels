/**
 * Captures full-height device detail panel screenshots across device kinds.
 * Run locally:
 *   npx playwright test device-detail-full-screenshot.spec.ts --project=chromium-mobile-width
 */
import { expect, renderTest as test, type Page } from './fixtures/test';

const OUT = '../../docs/public/screenshots/device-detail';

// Populated activity-log + diagnostics seeds, so the full captures prove the
// rendered features (repeat collapse, chip-only entries, "None in window"
// beside a populated neighbour, Held-back details with and without the
// Temperature row) instead of six empty states. Entries are newest-first,
// matching the recorder payload. The water heater is the busy device (held,
// with history); the heat pump is the calm thermostat (temperature evidence,
// no starvation); every other device keeps the honest empty state.
const seedPopulatedStates = async (page: Page) => {
  await page.addInitScript(() => {
    const now = Date.now();
    const minute = 60_000;
    const hour = 3_600_000;
    const idleEntry = (atMs: number) => ({
      atMs,
      powerMsg: null,
      stateMsg: 'Idle',
      usageMsg: 'Measured: 0.00 kW',
      statusMsg: '',
      stateKind: 'idle',
      stateTone: 'muted',
    });
    // One coherent story, told with producer strings
    // (formatDeviceReasonUserFacing / PLAN_STATE_CAPACITY_STATUS): limited
    // 9.5 h ago, resumed 9 h ago (= starvationLastResumedAt below), then
    // ordinary thermostat cycling up to the present draw. Newest-first.
    const logPayload = {
      version: 1,
      entriesByDeviceId: {
        dev_waterheater: [
          {
            atMs: now - 22 * minute,
            powerMsg: 'off → on',
            stateMsg: 'Running',
            usageMsg: 'Measured: 2.10 kW / Expected: 2.00 kW',
            statusMsg: '',
            stateKind: 'active',
            stateTone: 'active',
          },
          // One visually-identical run — collapses to a single row with the
          // "Seen 3 times since HH:MM" caption, and its empty statusMsg also
          // proves the chip-only entry renders without an empty body row.
          idleEntry(now - 47 * minute),
          idleEntry(now - 76 * minute),
          idleEntry(now - 103 * minute),
          {
            atMs: now - 145 * minute,
            powerMsg: null,
            stateMsg: 'Running',
            usageMsg: 'Measured: 1.95 kW / Expected: 2.00 kW',
            statusMsg: '',
            stateKind: 'active',
            stateTone: 'active',
          },
          {
            atMs: now - 9 * hour,
            powerMsg: 'off → on',
            stateMsg: 'Resuming',
            usageMsg: 'Measured: 0.00 kW / Expected: 2.00 kW',
            statusMsg: 'Resume pending',
            stateKind: 'resuming',
            stateTone: 'resuming',
          },
          {
            atMs: now - (9 * hour + 30 * minute),
            powerMsg: 'on → off',
            stateMsg: 'Limited',
            usageMsg: 'Measured: 0.00 kW / Expected: 2.00 kW',
            statusMsg: 'Limited by the hard cap',
            stateKind: 'held',
            stateTone: 'held',
          },
        ],
      },
    };
    const calmWindow = {
      unmetDemandMs: 0,
      blockedByHeadroomMs: 0,
      blockedByCooldownBackoffMs: 0,
      targetDeficitMs: 0,
      shedCount: 0,
      restoreCount: 0,
      failedActivationCount: 0,
      stableActivationCount: 0,
      penaltyBumpCount: 0,
      maxPenaltyLevelSeen: 0,
      avgShedToRestoreMs: null,
      avgRestoreToSetbackMs: null,
      minRestoreToSetbackMs: null,
      maxRestoreToSetbackMs: null,
    };
    const diagnosticsPayload = {
      generatedAt: now,
      windowDays: 21,
      diagnosticsByDeviceId: {
        dev_waterheater: {
          // The fixture home runs simulation, so PELS is not actually holding
          // anything right now: no live backoff, no running starvation
          // episode. The populated 1/7/21-day WINDOWS carry the history; the
          // current episode reads "Not held back" — which is also the
          // history-vs-now split the card intro explains.
          currentPenaltyLevel: 0,
          starvation: {
            isStarved: false,
            starvedAccumulatedMs: 0,
            // The producer nulls BOTH episode timestamps whenever the device
            // is not currently starved (deviceDiagnosticsUiPayload.ts) — a
            // not-held card with a "Resumed" time is a state production
            // cannot emit.
            starvationEpisodeStartedAt: null,
            starvationLastResumedAt: null,
            // Non-thermostat: no temperature evidence, so the
            // Temperature / target row must be absent.
            intendedNormalTargetC: null,
            currentTemperatureC: null,
            starvationCause: null,
            starvationPauseReason: 'keep',
          },
          windows: {
            // 1d matches the seeded log exactly: one completed limited→
            // resumed cycle (the 30-minute hold that ended 9 h ago), and no
            // resumed→limited interval since — so THAT pair reads "None in
            // window" beside its populated neighbour. The two metrics count
            // different populations, which is exactly the split the card
            // intro explains, and the visible log proves rather than
            // contradicts it.
            '1d': {
              ...calmWindow,
              unmetDemandMs: 30 * minute,
              blockedByHeadroomMs: 25 * minute,
              blockedByCooldownBackoffMs: 5 * minute,
              shedCount: 1,
              restoreCount: 1,
              stableActivationCount: 1,
              avgShedToRestoreMs: 30 * minute,
            },
            '7d': {
              ...calmWindow,
              unmetDemandMs: 6 * hour,
              blockedByHeadroomMs: 4 * hour + 30 * minute,
              blockedByCooldownBackoffMs: 55 * minute,
              shedCount: 9,
              restoreCount: 9,
              failedActivationCount: 1,
              stableActivationCount: 8,
              penaltyBumpCount: 2,
              maxPenaltyLevelSeen: 2,
              avgShedToRestoreMs: 38 * minute,
              avgRestoreToSetbackMs: 3 * hour + 10 * minute,
              minRestoreToSetbackMs: 12 * minute,
              maxRestoreToSetbackMs: 9 * hour,
            },
            '21d': {
              ...calmWindow,
              unmetDemandMs: 14 * hour,
              blockedByHeadroomMs: 11 * hour,
              blockedByCooldownBackoffMs: 2 * hour + 5 * minute,
              shedCount: 24,
              restoreCount: 24,
              failedActivationCount: 2,
              stableActivationCount: 22,
              penaltyBumpCount: 4,
              maxPenaltyLevelSeen: 2,
              avgShedToRestoreMs: 42 * minute,
              avgRestoreToSetbackMs: 4 * hour + 20 * minute,
              minRestoreToSetbackMs: 12 * minute,
              maxRestoreToSetbackMs: 16 * hour,
            },
          },
        },
        dev_heatpump: {
          currentPenaltyLevel: 0,
          starvation: {
            isStarved: false,
            starvedAccumulatedMs: 0,
            // Not starved → both episode timestamps null, per the producer
            // (deviceDiagnosticsUiPayload.ts).
            starvationEpisodeStartedAt: null,
            starvationLastResumedAt: null,
            // Thermostat: temperature evidence present, so the
            // Temperature / target row renders.
            intendedNormalTargetC: 21,
            currentTemperatureC: 20.3,
            starvationCause: null,
            starvationPauseReason: 'keep',
          },
          windows: {
            '1d': { ...calmWindow, stableActivationCount: 4 },
            '7d': {
              ...calmWindow,
              targetDeficitMs: 1 * hour + 30 * minute,
              shedCount: 2,
              restoreCount: 2,
              stableActivationCount: 26,
              avgShedToRestoreMs: 22 * minute,
              avgRestoreToSetbackMs: 8 * hour,
              minRestoreToSetbackMs: 2 * hour,
              maxRestoreToSetbackMs: 14 * hour,
            },
            '21d': {
              ...calmWindow,
              targetDeficitMs: 5 * hour,
              shedCount: 5,
              restoreCount: 5,
              stableActivationCount: 80,
              avgShedToRestoreMs: 25 * minute,
              avgRestoreToSetbackMs: 9 * hour,
              minRestoreToSetbackMs: 2 * hour,
              maxRestoreToSetbackMs: 18 * hour,
            },
          },
        },
      },
    };
    const stubWindow = window as {
      __PELS_HOMEY_STUB__?: { apiHandlers?: Record<string, unknown> };
    };
    const existing = stubWindow.__PELS_HOMEY_STUB__ ?? {};
    const apiHandlers = existing.apiHandlers ?? {};
    apiHandlers['GET /ui_device_log'] = () => logPayload;
    apiHandlers['GET /ui_device_diagnostics'] = () => diagnosticsPayload;
    stubWindow.__PELS_HOMEY_STUB__ = { ...existing, apiHandlers };
  });
};

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(Boolean(process.env.CI), 'Full-panel screenshot is local only');
  // Outputs are CDN-bound docs assets, not browser comparison artifacts —
  // pin them to a single project so the two Playwright projects don't
  // overwrite each other's PNGs nondeterministically when running locally
  // with fullyParallel.
  test.skip(
    testInfo.project.name !== 'chromium-mobile-width',
    'Screenshots are pinned to chromium-mobile-width to avoid clobbering.',
  );
  await page.addInitScript(() => {
    const css = '*,*::before,*::after{transition:none!important;animation:none!important;}';
    const apply = () => {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    };
    if (document.head) apply();
    else document.addEventListener('DOMContentLoaded', apply);
  });
  await seedPopulatedStates(page);
});

test.use({ viewport: { width: 480, height: 900 } });

const openDeviceDetail = async (page: Page, deviceId: string) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('.settings-nav-card[data-settings-target="devices"]').click();
  const row = page.locator(`#devices-panel [data-device-id="${deviceId}"]`).first();
  await expect(row).toBeVisible();
  await row.locator('.pels-device-card__detail-button').click();
  await expect(page.locator('#device-detail-overlay')).toBeVisible();
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#dry-run-banner')?.style.setProperty('display', 'none');
  });
};

const expandAllSections = async (page: Page) => {
  await page.evaluate(() => {
    document
      .querySelectorAll<HTMLDetailsElement>('#device-detail-panel details')
      .forEach((d) => { d.open = true; });
  });
};

const fullPanelScreenshot = async (page: Page, name: string) => {
  const panel = page.locator('#device-detail-panel');
  await panel.waitFor();
  // Late-settling content must land BEFORE the height measurement below, or
  // the viewport is sized to the pre-render page and the bottom of the panel
  // is cut out of the shot:
  // - md-filled-select commits its trigger text a frame after `.value` is
  //   assigned (the Bedroom Thermostat capture shipped with an empty Control
  //   model field);
  // - the activity log and diagnostics sections fetch on open and append
  //   their cards asynchronously (the water-heater capture cut the 1/7/21
  //   diagnostics cards).
  await page.waitForFunction(() => {
    const select = document.querySelector('#device-detail-control-model') as
      | { displayText?: string }
      | null;
    if (select && (select.displayText ?? '') === '') return false;
    const logBody = document.querySelector('#device-detail-activity-log-body');
    if (logBody?.textContent?.includes('Loading activity')) return false;
    const diagnosticsStatus = document.querySelector('#device-detail-diagnostics-status');
    return !diagnosticsStatus?.textContent?.includes('Loading diagnostics');
  });
  const scrollHeight = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#device-detail-panel');
    if (!el) return 900;
    const content = el.querySelector<HTMLElement>('.slide-panel__content') ?? el;
    return Math.max(el.scrollHeight, content.scrollHeight) + 40;
  });
  await page.setViewportSize({ width: 480, height: Math.min(8000, Math.max(900, scrollHeight)) });
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.slide-panel__content');
    if (el) el.scrollTop = 0;
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await panel.screenshot({ path: `${OUT}/${name}.png` });
};

test('thermostat — heatpump', async ({ page }) => {
  await openDeviceDetail(page, 'dev_heatpump');
  await expandAllSections(page);
  await fullPanelScreenshot(page, 'mw-thermostat-heatpump-full');
});

test('thermostat — bedroom', async ({ page }) => {
  await openDeviceDetail(page, 'dev_bedroom');
  await expandAllSections(page);
  await fullPanelScreenshot(page, 'mw-thermostat-bedroom-full');
});

test('on/off — water heater', async ({ page }) => {
  await openDeviceDetail(page, 'dev_waterheater');
  await expandAllSections(page);
  await fullPanelScreenshot(page, 'mw-onoff-waterheater-full');
});

test('stepped — Zaptec EV charger', async ({ page }) => {
  await openDeviceDetail(page, 'dev_zaptec');
  await expandAllSections(page);
  await fullPanelScreenshot(page, 'mw-stepped-zaptec-full');
});

test('stepped — Connected 300 water heater', async ({ page }) => {
  await openDeviceDetail(page, 'dev_connected300');
  await expandAllSections(page);
  await fullPanelScreenshot(page, 'mw-stepped-connected300-full');
});

test('held hero — power-limited, outside simulation', async ({ page }) => {
  // The loudest pixel the hero rebind makes possible — a warning-toned
  // state word at display size — cannot appear in the managed captures,
  // because the fixture home runs simulation and the state word stays
  // factual there. Flip dry-run off for this one hero-only shot so the
  // amber "Limited" plus its need clause are seen rendered before they
  // ship.
  await page.addInitScript(() => {
    const stubWindow = window as {
      __PELS_HOMEY_STUB__?: { settings?: Record<string, unknown> };
    };
    const existing = stubWindow.__PELS_HOMEY_STUB__ ?? {};
    stubWindow.__PELS_HOMEY_STUB__ = {
      ...existing,
      settings: { ...(existing.settings ?? {}), capacity_dry_run: false },
    };
  });
  await openDeviceDetail(page, 'dev_waterheater');
  const hero = page.locator('#device-detail-live-status');
  await expect(hero).toBeVisible();
  await hero.screenshot({ path: `${OUT}/held-hero.png` });
});

test('generic EV charger', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('.settings-nav-card[data-settings-target="devices"]').click();
  const row = page.locator('#devices-panel [data-device-id="dev_evcharger"]').first();
  await expect(row).toBeVisible();
  await row.locator('.pels-device-card__detail-button').click();
  await expect(page.locator('#device-detail-overlay')).toBeVisible();
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#dry-run-banner')?.style.setProperty('display', 'none');
  });
  await expandAllSections(page);
  await fullPanelScreenshot(page, 'mw-ev-generic-full');
});
