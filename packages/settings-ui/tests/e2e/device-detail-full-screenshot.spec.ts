/**
 * Captures the full-height device detail screenshot docs/configuration.md uses.
 * Run locally:
 *   npx playwright test device-detail-full-screenshot.spec.ts --project=chromium-mobile-width
 */
import { expect, renderTest as test, type Page } from './fixtures/test';

const OUT = '../../docs/public/screenshots/device-detail';

// A populated diagnostics seed, so the capture shows the Held-back details with
// the Temperature row instead of an empty state. The heat pump is the calm
// thermostat (temperature evidence, no starvation) and keeps an empty activity
// log.
const seedPopulatedStates = async (page: Page) => {
  await page.addInitScript(() => {
    const now = Date.now();
    const minute = 60_000;
    const hour = 3_600_000;
    const logPayload = {
      version: 2, retentionDays: 7, maxEntriesPerDevice: 100, maxEntries: 1000, persistence: 'stored',
      entries: [],
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
            intendedTarget: { kind: 'temperature', targetTemperatureC: 21 },
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
  //   assigned (a capture once shipped with an empty Control model field);
  // - the activity log and diagnostics sections fetch on open and append
  //   their cards asynchronously (a capture once cut the 1/7/21 diagnostics
  //   cards).
  //
  // Power when running is asserted rather than waited for: both halves render
  // synchronously, so an empty one means the fixture is wrong, not early. The
  // heat-pump capture shipped without the provenance sentence because the
  // fixture omitted `expectedPowerSource` (REQUIRED on `DeviceDescriptor`, so
  // `expectedPowerSourceLine` fell through its `never` guard to ''), which is
  // a state production cannot emit. Failing the capture beats shipping a doc
  // image that contradicts the prose it illustrates.
  await page.waitForFunction(() => {
    const select = document.querySelector('#device-detail-control-model') as
      | { displayText?: string }
      | null;
    if (select && (select.displayText ?? '') === '') return false;
    const expectedPowerRow = document.querySelector('#device-detail-expected-power-row') as
      | HTMLElement
      | null;
    if (!expectedPowerRow || expectedPowerRow.hidden) return false;
    const field = document.querySelector('#device-detail-expected-power') as
      | HTMLInputElement
      | null;
    if ((field?.value ?? '') === '') return false;
    const source = document.querySelector('#device-detail-expected-power-source');
    if ((source?.textContent ?? '') === '') return false;
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
