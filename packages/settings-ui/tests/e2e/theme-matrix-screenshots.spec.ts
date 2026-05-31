import os from 'node:os';
import path from 'node:path';
import { captureThemes, test, type Locator, type Page } from './fixtures/test';

// Whole-surface capture matrix. Not a CI assertion — a reusable review harness.
// Each main surface is rendered in the three contexts users actually meet
// (light-desktop / dark-mobile / light-mobile, all with the Homey host CSS), via
// `captureThemes`. Skipped unless PELS_CAPTURE_THEMES=1; writes to the OS temp
// dir so it never clobbers committed docs screenshots.
//
//   PELS_CAPTURE_THEMES=1 npx playwright test theme-matrix-screenshots \
//     --project=chromium-mobile-width
//
// Output: <tmp>/pels-theme-matrix/<surface>.{light-desktop,dark-mobile,light-mobile}.png
const OUT_DIR = process.env.PELS_THEME_MATRIX_OUT_DIR ?? path.join(os.tmpdir(), 'pels-theme-matrix');

const FIXED_NOW_MS = Date.UTC(2026, 4, 15, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Minimal smart-task history so that surface shows real content (week dividers,
// hit-rate strip, device-filter chips) instead of the empty state.
const seedSmartTasks = (nowMs: number) => {
  const entry = (id: string, deviceId: string, deviceName: string, outcome: string, daysAgo: number, targetC: number) => {
    const finalizedAtMs = nowMs - daysAgo * DAY;
    const startedAtMs = finalizedAtMs - 8 * HOUR;
    const deadlineAtMs = finalizedAtMs - HOUR;
    return {
      id, deviceId, deviceName, objectiveKind: 'temperature', targetTemperatureC: targetC, targetPercent: null,
      deadlineAtMs, startedAtMs, finalizedAtMs, startProgressC: targetC - 12, startProgressPercent: null,
      finalProgressC: outcome === 'met' ? targetC : targetC - 4, finalProgressPercent: null, initialEnergyNeededKWh: 4,
      outcome, metAtMs: outcome === 'met' ? deadlineAtMs - HOUR : null, usedDeadlineReserve: false, usedPolicyAvoid: false,
      observedIntervals: [{ fromMs: startedAtMs, toMs: deadlineAtMs }], discoveredFrom: 'observation',
      originalPlan: { hours: [{ startsAtMs: startedAtMs, plannedKWh: 1 }], energyNeededKWh: 4, planStatus: 'on_track', revisedAtMs: startedAtMs },
      finalPlan: null, revisionCount: 1,
    };
  };
  return {
    version: 1,
    entriesByDeviceId: {
      dev_connected300: [entry('c1', 'dev_connected300', 'Connected 300', 'met', 1, 65), entry('c2', 'dev_connected300', 'Connected 300', 'missed', 3, 65)],
      dev_termostat_kontor: [entry('k1', 'dev_termostat_kontor', 'Termostat kontor', 'met', 2, 21)],
    },
  };
};

const tab = (name: string) => async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name }).click();
};

// Open a device's detail overlay and return the panel for an element capture.
// (Navigation mirrors device-detail-screenshots.spec.ts, but here it feeds the
// theme matrix instead of a single committed docs PNG.)
const openDeviceDetail = (deviceId: string) => async (page: Page): Promise<Locator> => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as { Homey?: unknown }).Homey === 'object');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('.settings-nav-card[data-settings-target="devices"]').click();
  const row = page.locator(`#devices-panel [data-device-id="${deviceId}"]`).first();
  await row.waitFor();
  await row.locator('.pels-device-card__detail-button').click();
  const panel = page.locator('#device-detail-panel');
  await panel.waitFor();
  await page.waitForTimeout(300);
  return panel;
};

const SURFACES: { name: string; prepare?: (page: Page) => Promise<void>; open: (page: Page) => Promise<Locator | void> }[] = [
  { name: 'overview', open: async (page) => { await page.goto('/', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(700); } },
  { name: 'budget', open: async (page) => { await tab('Budget')(page); await page.locator('#budget-redesign-surface').waitFor(); await page.waitForTimeout(500); } },
  { name: 'usage', open: async (page) => { await tab('Usage')(page); await page.waitForTimeout(1000); } },
  {
    name: 'smart-tasks',
    prepare: async (page) => {
      await page.clock.setFixedTime(FIXED_NOW_MS);
      await page.addInitScript((history) => {
        (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = {
          apiHandlers: { 'GET /ui_deferred_objective_history': () => history },
        };
      }, seedSmartTasks(FIXED_NOW_MS));
    },
    open: async (page) => { await tab('Smart tasks')(page); await page.locator('.deadlines-history__heading').waitFor(); await page.waitForTimeout(400); },
  },
  { name: 'settings', open: async (page) => { await tab('Settings')(page); await page.waitForTimeout(500); } },
  // Detail surfaces (element captures of the device panel). Dense with native
  // button/chip/slider primitives — the exact place host-CSS bleed shows — so the
  // DARK variant here is the one that would catch a device-card bleed regression.
  { name: 'device-detail-thermostat', open: openDeviceDetail('dev_heatpump') },
  { name: 'device-detail-stepped', open: openDeviceDetail('dev_zaptec') },
  {
    name: 'deadline-plan',
    open: async (page) => {
      await page.goto('/?page=deadline-plan&deviceId=dev_connected300', { waitUntil: 'domcontentloaded' });
      const panel = page.locator('#deadline-plan-panel');
      await panel.locator('.plan-hero__headline').waitFor();
      await page.waitForTimeout(400);
      return panel;
    },
  },
];

test.describe('Theme matrix captures', () => {
  test.skip(process.env.PELS_CAPTURE_THEMES !== '1', 'Set PELS_CAPTURE_THEMES=1 to capture.');
  for (const surface of SURFACES) {
    test(surface.name, async ({ browser, browserName, baseURL }) => {
      test.skip(browserName !== 'chromium', 'Dark capture needs chromium isMobile emulation (Firefox rejects it).');
      await captureThemes({ browser, baseURL, name: surface.name, outDir: OUT_DIR, prepare: surface.prepare, open: surface.open });
    });
  }
});
