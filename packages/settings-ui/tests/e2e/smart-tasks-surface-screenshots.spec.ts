import os from 'node:os';
import path from 'node:path';
import { expect, injectHomeyHostCss, test, type Page } from './fixtures/test';

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
  // Raw minor-unit (øre) cost the recorder accumulates. The render path scales
  // it to kr via the resolved `CostDisplay.divisor` (100 for the default
  // Norwegian scheme), so seed RAW øre here — `1200` renders "≈ 12 kr", not
  // "≈ 1200 kr". Mirrors the live hero's øre→kr scaling. Omit to leave the
  // per-row cost line suppressed (legacy entries record no cost).
  totalCostOre?: number;
  // Useful energy delivered across the run; renders the "· Y kWh delivered"
  // half of the same meta line. Omit to suppress it.
  deliveredKWh?: number;
  // When set, records a real mid-run replan so the history-detail surface
  // renders the "Revised trajectory" overlay (a second, re-anchored staircase)
  // + the "What changed" revisions card. The revision is anchored mid-window
  // (`revisedAtMs`) and the final plan books a genuinely different hour shape
  // than the original so the producer's replan detection fires.
  revised?: boolean;
}) => {
  const {
    id, deviceId, deviceName, outcome, finalizedAtMs, startC, finalC, targetC,
    totalCostOre, deliveredKWh, revised,
  } = params;
  const startedAtMs = finalizedAtMs - 8 * HOUR;
  const deadlineAtMs = finalizedAtMs - HOUR;
  const originalPlan = {
    hours: [
      { startsAtMs: startedAtMs, plannedKWh: 1.0 },
      { startsAtMs: startedAtMs + HOUR, plannedKWh: 0.8 },
      { startsAtMs: startedAtMs + 2 * HOUR, plannedKWh: 0.6 },
    ],
    energyNeededKWh: 4,
    planStatus: 'on_track' as const,
    revisedAtMs: startedAtMs,
    // The trajectory staircase needs a per-unit rate to integrate planned kWh
    // into °C; without it the detail chart falls back to the legacy kWh bars.
    kwhPerUnitMean: 0.8,
  };
  // A genuinely different hour shape (later, heavier hours) re-anchored at a
  // mid-window replan time — the producer compares start-anchored original vs
  // final and only overlays the revised staircase when they differ.
  const revisedAtMs = startedAtMs + 3 * HOUR;
  const finalPlan = revised
    ? {
      hours: [
        { startsAtMs: startedAtMs + 3 * HOUR, plannedKWh: 1.2 },
        { startsAtMs: startedAtMs + 4 * HOUR, plannedKWh: 1.0 },
        { startsAtMs: startedAtMs + 5 * HOUR, plannedKWh: 0.9 },
      ],
      energyNeededKWh: 4.5,
      planStatus: 'on_track' as const,
      revisedAtMs,
      kwhPerUnitMean: 0.8,
    }
    : null;
  // Hourly progress series so the observed line draws and the revised staircase
  // can re-anchor at the measured progress when the replan landed.
  const progressSamples = revised
    ? Array.from({ length: 7 }, (_, hour) => ({
      atMs: startedAtMs + hour * HOUR,
      valueC: Number((startC + ((finalC - startC) * hour) / 6).toFixed(1)),
      valuePercent: null,
    }))
    : undefined;
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
    observedIntervals: [{ fromMs: startedAtMs, toMs: deadlineAtMs }],
    discoveredFrom: 'observation',
    originalPlan,
    finalPlan,
    // One revision past the original so the detail surface renders the "What
    // changed" card (the recorder writes one `revisions` entry per replan; the
    // first revision lives on `originalPlan`).
    revisions: revised
      ? [{ atMs: revisedAtMs, reasonId: 'prices_revised', hoursAdded: 3, hoursRemoved: 3 }]
      : undefined,
    revisionCount: revised ? 2 : 1,
    progressSamples,
    totalCost: totalCostOre,
    deliveredKWh,
  };
};

// Stable history id for the entry the detail-surface capture navigates into.
// Carries the "Revised trajectory" overlay + the populated cost/delivered meta.
const REVISED_ENTRY_ID = 'c300-revised';

// Two devices, mixed outcomes, spanning this week + last week so the hit-rate
// strip, week dividers, device-filter chips and miss-streak badge all populate.
const buildHistory = (nowMs: number) => {
  const c300 = (
    i: number | string,
    outcome: Outcome,
    daysAgo: number,
    startC: number,
    finalC: number,
    extra?: { totalCostOre?: number; deliveredKWh?: number; revised?: boolean },
  ) =>
    makeEntry({ id: `c300-${i}`, deviceId: 'dev_connected300', deviceName: 'Connected 300', outcome, finalizedAtMs: nowMs - daysAgo * DAY, startC, finalC, targetC: 65, ...extra });
  const kontor = (i: number, outcome: Outcome, daysAgo: number, startC: number, finalC: number, extra?: { totalCostOre?: number; deliveredKWh?: number }) =>
    makeEntry({ id: `kontor-${i}`, deviceId: 'dev_termostat_kontor', deviceName: 'Termostat kontor', outcome, finalizedAtMs: nowMs - daysAgo * DAY, startC, finalC, targetC: 21, ...extra });
  const entries = [
    // The revised entry leads this week: it carries the re-anchored staircase
    // (detail-surface pixel path) AND the populated `Cost ≈ 12 kr · 4.6 kWh
    // delivered` meta line (list pixel path). `totalCostOre: 1200` is RAW øre →
    // renders "≈ 12 kr" after the ÷100 display divisor.
    makeEntry({ id: REVISED_ENTRY_ID, deviceId: 'dev_connected300', deviceName: 'Connected 300', outcome: 'met', finalizedAtMs: nowMs - 0.5 * DAY, startC: 50, finalC: 65, targetC: 65, totalCostOre: 1200, deliveredKWh: 4.6, revised: true }),
    // A second cost-bearing row (Missed) so the populated cost meta isn't a
    // single-row fluke and the whole-kr week roll-up has more than one summand.
    kontor(1, 'missed', 1, 17.7, 20.9, { totalCostOre: 340, deliveredKWh: 1.8 }),
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

// Drive the history-detail sub-page directly via its query-string route (the
// list card links to `./?page=deadline-plan&deviceId=…&historyId=…`). The
// `met`-outcome revised entry defaults the trajectory chart collapsed (receipt
// shape), so expand it via the "View details" toggle to render the "Revised
// trajectory" overlay + the "What changed" revisions card before capturing.
const openHistoryDetail = async (page: Page) => {
  await page.goto(
    `/?page=deadline-plan&deviceId=dev_connected300&historyId=${encodeURIComponent(REVISED_ENTRY_ID)}`,
    { waitUntil: 'domcontentloaded' },
  );
  await expect(page.locator('.plan-history-detail')).toBeVisible();
  await page.locator('button.pels-button.plan-history-detail__chart-toggle').click();
  await expect(page.locator('.deadline-horizon-chart svg')).toBeVisible();
};

const STATES = [
  { name: 'contradiction', clearActive: true, withHistory: true, detail: false },
  { name: 'active', clearActive: false, withHistory: true, detail: false },
  { name: 'first-run', clearActive: true, withHistory: false, detail: false },
  // History-detail sub-page for the revised run — gates the "Revised
  // trajectory" overlay + revisions-card pixels the list-only states miss.
  { name: 'history-detail', clearActive: false, withHistory: true, detail: true },
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
          // Render with Homey's host stylesheet present, exactly as the on-device
          // app-settings iframe does, so the capture shows real host-CSS bleed.
          await injectHomeyHostCss(page);
          // Pin the clock so seeded dates + relative week labels are stable.
          await page.clock.setFixedTime(FIXED_NOW_MS);
          const history = state.withHistory ? buildHistory(FIXED_NOW_MS) : { version: 1, entriesByDeviceId: {} };
          await page.addInitScript(seed, { clearActive: state.clearActive, history });
          if (state.detail) {
            await openHistoryDetail(page);
          } else {
            await openSmartTasks(page);
          }
          await page.waitForTimeout(500);
          await page.screenshot({ path: path.join(OUT_DIR, `${state.name}-${width}.png`), fullPage: false });
        } finally {
          await context.close();
        }
      });
    }
  });
}
