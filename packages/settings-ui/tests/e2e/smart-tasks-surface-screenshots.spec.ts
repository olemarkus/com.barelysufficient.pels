import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from './fixtures/test';

// Baseline whole-surface render of the Smart tasks tab. Not a CI assertion — a
// reusable capture harness for the periodic render-gate. Skipped unless
// PELS_CAPTURE_SMART_TASKS=1; writes PNGs to the OS temp dir so it never
// clobbers committed docs screenshots.
//
// THEME: PELS renders its mobile DARK palette only under touch (hover:none /
// pointer:coarse); the desktop light-canvas override is gated on `(hover:hover)
// and (pointer:fine)` (Homey inverts that to dark on desktop). We get the real
// mobile dark surface by creating a per-test context with `isMobile`+`hasTouch`
// at a fixed TALL viewport and screenshotting the viewport — NOT `fullPage`, and
// no `setViewportSize`; both resize device metrics mid-test and silently reset
// the touch emulation back to desktop (→ light canvas). `isMobile` is
// chromium-only, so the spec skips non-chromium projects (Firefox rejects it at
// context creation). The browser clock is pinned so captures are deterministic.
const OUT_DIR = process.env.PELS_SMART_TASKS_OUT_DIR ?? path.join(os.tmpdir(), 'pels-smarttasks-render');

// Frozen "now" so the seeded history dates, the 7-day hit-rate window and the
// relative week dividers ("This week" / "Last week") render identically on
// every run. 2026-05-15T12:00Z is a Friday, giving a clean this-week /
// last-week split across the seeded entries below.
const FIXED_NOW_MS = Date.UTC(2026, 4, 15, 12, 0, 0);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Outcome = 'met' | 'missed' | 'abandoned';

const makeEntry = (params: {
  id: string;
  deviceId: string;
  deviceName: string;
  outcome: Outcome;
  finalizedAtMs: number;
  startC: number;
  finalC: number;
  targetC: number;
}) => {
  const { id, deviceId, deviceName, outcome, finalizedAtMs, startC, finalC, targetC } = params;
  const startedAtMs = finalizedAtMs - 8 * HOUR;
  const deadlineAtMs = finalizedAtMs - HOUR;
  return {
    id,
    deviceId,
    deviceName,
    objectiveKind: 'temperature',
    targetTemperatureC: targetC,
    targetPercent: null,
    deadlineAtMs,
    startedAtMs,
    finalizedAtMs,
    startProgressC: startC,
    startProgressPercent: null,
    finalProgressC: finalC,
    finalProgressPercent: null,
    initialEnergyNeededKWh: 4,
    outcome,
    metAtMs: outcome === 'met' ? deadlineAtMs - HOUR : null,
    usedDeadlineReserve: false,
    usedPolicyAvoid: false,
    observedIntervals: [{ fromMs: startedAtMs, toMs: deadlineAtMs }],
    discoveredFrom: 'observation',
    originalPlan: {
      hours: [
        { startsAtMs: startedAtMs, plannedKWh: 1.0 },
        { startsAtMs: startedAtMs + HOUR, plannedKWh: 0.8 },
        { startsAtMs: startedAtMs + 2 * HOUR, plannedKWh: 0.6 },
      ],
      energyNeededKWh: 4,
      planStatus: 'on_track',
      revisedAtMs: startedAtMs,
    },
    finalPlan: null,
    revisionCount: 1,
  };
};

// Two devices, mixed outcomes, spanning this week + last week so the hit-rate
// strip, week dividers, device-filter chips and miss-streak badge all populate.
const buildHistory = (nowMs: number) => {
  const c300 = (i: number, outcome: Outcome, daysAgo: number, startC: number, finalC: number) =>
    makeEntry({ id: `c300-${i}`, deviceId: 'dev_connected300', deviceName: 'Connected 300', outcome, finalizedAtMs: nowMs - daysAgo * DAY, startC, finalC, targetC: 65 });
  const kontor = (i: number, outcome: Outcome, daysAgo: number, startC: number, finalC: number) =>
    makeEntry({ id: `kontor-${i}`, deviceId: 'dev_termostat_kontor', deviceName: 'Termostat kontor', outcome, finalizedAtMs: nowMs - daysAgo * DAY, startC, finalC, targetC: 21 });
  const entries = [
    kontor(1, 'missed', 1, 17.7, 20.9),
    kontor(2, 'met', 2, 19.0, 21.0),
    c300(1, 'met', 1, 50, 65),
    c300(2, 'missed', 3, 50, 58),
    c300(3, 'abandoned', 4, 50, 52),
    kontor(3, 'missed', 8, 18.0, 20.0),
    kontor(4, 'met', 9, 19.5, 21.0),
    c300(4, 'met', 9, 55, 65),
    c300(5, 'missed', 10, 50, 60),
    c300(6, 'abandoned', 11, 50, 51),
  ];
  return {
    version: 1,
    entriesByDeviceId: {
      dev_connected300: entries.filter((e) => e.deviceId === 'dev_connected300'),
      dev_termostat_kontor: entries.filter((e) => e.deviceId === 'dev_termostat_kontor'),
    },
  };
};

const seed = (data: { clearActive: boolean; history: unknown }) => {
  const stub: Record<string, unknown> = {
    apiHandlers: {
      'GET /ui_deferred_objective_history': () => data.history,
    },
  };
  if (data.clearActive) {
    // No enabled objectives -> buildSampleActivePlans returns {} -> the active
    // list renders its empty stanza ("Add your first smart task").
    stub.settings = { deferred_objectives: { version: 1, objectivesByDeviceId: {} } };
  }
  (window as unknown as { __PELS_HOMEY_STUB__: unknown }).__PELS_HOMEY_STUB__ = stub;
};

const openSmartTasks = async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Smart tasks' }).click();
  await expect(page.locator('.deadlines-history__heading')).toBeVisible();
};

const STATES = [
  { name: 'contradiction', clearActive: true, withHistory: true },
  { name: 'active', clearActive: false, withHistory: true },
  { name: 'first-run', clearActive: true, withHistory: false },
] as const;

for (const width of [480, 360] as const) {
  test.describe(`Smart tasks surface render @ ${width}px`, () => {
    test.skip(process.env.PELS_CAPTURE_SMART_TASKS !== '1', 'Set PELS_CAPTURE_SMART_TASKS=1 to capture.');
    for (const state of STATES) {
      // Take `browser` (not `page`) so no context is created until after the
      // chromium guard — Firefox rejects `isMobile` at context creation, so we
      // must skip it BEFORE building the mobile context.
      test(state.name, async ({ browser, browserName, baseURL }) => {
        test.skip(browserName !== 'chromium', 'Mobile dark capture needs chromium isMobile emulation (unsupported in Firefox).');
        // A manually-created context does not inherit baseURL from the page
        // fixture, so pass it explicitly or page.goto('/') has no base to
        // resolve against.
        const context = await browser.newContext({
          baseURL,
          viewport: { width, height: 3400 },
          isMobile: true,
          hasTouch: true,
        });
        try {
          const page = await context.newPage();
          // Pin the clock so seeded dates + relative week labels are stable.
          await page.clock.setFixedTime(FIXED_NOW_MS);
          const history = state.withHistory ? buildHistory(FIXED_NOW_MS) : { version: 1, entriesByDeviceId: {} };
          await page.addInitScript(seed, { clearActive: state.clearActive, history });
          await openSmartTasks(page);
          await page.waitForTimeout(500);
          await page.screenshot({ path: path.join(OUT_DIR, `${state.name}-${width}.png`), fullPage: false });
        } finally {
          await context.close();
        }
      });
    }
  });
}
