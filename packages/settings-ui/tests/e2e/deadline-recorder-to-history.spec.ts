import { expect, test, type Page } from './fixtures/test';
import { build as buildRuntimeBundle } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryV4,
} from '../../../contracts/src/deferredObjectivePlanHistory';

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

// Minimal structural shapes for the recorder + diagnostic. Defined locally rather than
// imported from `lib/` so the settings-ui tsconfig (ES2020 lib) is not asked to type-check
// runtime files that rely on ES2022 features (e.g. Array.prototype.at).
type DeferredObjectiveDiagnosticLike = {
  deviceId: string;
  deviceName?: string;
  objectiveId: string;
  objectiveKind: 'temperature' | 'ev_soc';
  enforcement: 'soft' | 'hard';
  status:
    | 'unknown'
    | 'invalid'
    | 'at_risk'
    | 'cannot_meet'
    | 'on_track'
    | 'satisfied';
  reasonCode: string;
  targetPercent: number | null;
  currentPercent: number | null;
  targetTemperatureC: number | null;
  currentTemperatureC: number | null;
  deadlineAtMs: number | null;
  deadlineLocalTime: string;
  energyNeededKWh: number | null;
  kWhPerPercent: number | null;
  kWhPerDegreeC: number | null;
  rateConfidence: string | null;
  horizonBucketCount: number;
  requestedMinimumStepId: string | null;
};

type PlanHistoryRecorderLike = {
  observe(diagnostics: ReadonlyArray<DeferredObjectiveDiagnosticLike>, nowMs: number): void;
  flushIfDirty(): boolean;
};

type PlanHistoryRuntimeModule = {
  DeferredObjectivePlanHistoryRecorder: new (deps: {
    load: () => DeferredObjectivePlanHistoryV4 | null;
    save: (history: DeferredObjectivePlanHistoryV4) => boolean;
  }) => PlanHistoryRecorderLike;
};

let runtimeBundleDir: string | null = null;
let planHistoryRuntimePromise: Promise<PlanHistoryRuntimeModule> | null = null;

const loadPlanHistoryRuntime = (): Promise<PlanHistoryRuntimeModule> => {
  if (planHistoryRuntimePromise) return planHistoryRuntimePromise;
  planHistoryRuntimePromise = (async () => {
    runtimeBundleDir = mkdtempSync(path.join(tmpdir(), 'pels-plan-history-e2e-'));
    const runtimeBundleFile = path.join(runtimeBundleDir, 'plan-history-runtime.cjs');
    await buildRuntimeBundle({
      stdin: {
        contents: [
          "export { DeferredObjectivePlanHistoryRecorder } from './lib/plan/deferredObjectives/planHistory';",
        ].join('\n'),
        resolveDir: repoRoot,
        sourcefile: path.join(repoRoot, 'plan-history-recorder.runtime.ts'),
        loader: 'ts',
      },
      bundle: true,
      format: 'cjs',
      outfile: runtimeBundleFile,
      platform: 'node',
      target: 'node22',
      logLevel: 'silent',
    });
    return require(runtimeBundleFile) as PlanHistoryRuntimeModule;
  })();
  return planHistoryRuntimePromise;
};

test.afterAll(() => {
  if (runtimeBundleDir) {
    rmSync(runtimeBundleDir, { recursive: true, force: true });
    runtimeBundleDir = null;
  }
  planHistoryRuntimePromise = null;
});

const HOUR_MS = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 4, 10, 0, 0, 0);
const DEADLINE_MS = T0 + 6 * HOUR_MS;
const MISSED_DEADLINE_MS = DEADLINE_MS + HOUR_MS;

type TemperatureDiagOverrides = {
  deviceId: string;
  deviceName: string;
  status: DeferredObjectiveDiagnosticLike['status'];
  currentTemperatureC: number;
  targetTemperatureC: number;
  deadlineAtMs: number;
};

const buildTemperatureDiag = (overrides: TemperatureDiagOverrides): DeferredObjectiveDiagnosticLike => ({
  deviceId: overrides.deviceId,
  deviceName: overrides.deviceName,
  objectiveId: `${overrides.deviceId}:temperature`,
  objectiveKind: 'temperature',
  enforcement: 'soft',
  status: overrides.status,
  reasonCode: 'planned_with_margin',
  targetPercent: null,
  currentPercent: null,
  targetTemperatureC: overrides.targetTemperatureC,
  currentTemperatureC: overrides.currentTemperatureC,
  deadlineAtMs: overrides.deadlineAtMs,
  deadlineLocalTime: '06:00',
  energyNeededKWh: 22.5,
  kWhPerPercent: null,
  kWhPerDegreeC: 1.5,
  rateConfidence: 'high',
  horizonBucketCount: 6,
  requestedMinimumStepId: null,
});

const runRecorder = async (): Promise<DeferredObjectivePlanHistoryV4> => {
  const { DeferredObjectivePlanHistoryRecorder } = await loadPlanHistoryRuntime();
  let saved: DeferredObjectivePlanHistoryV4 | null = null;
  const recorder = new DeferredObjectivePlanHistoryRecorder({
    load: () => null,
    save: (history) => { saved = history; return true; },
  });

  // Both devices are observed on every planning tick, mirroring how the runtime hands the
  // recorder the full set of active diagnostics each cycle. dev_connected300 reaches its
  // target by T0+5h ('satisfied'); dev_pool_pump stalls at 58 °C and misses its deadline.
  const connected300Diag = (
    status: DeferredObjectiveDiagnosticLike['status'],
    currentTemperatureC: number,
  ): DeferredObjectiveDiagnosticLike => buildTemperatureDiag({
    deviceId: 'dev_connected300',
    deviceName: 'Connected 300',
    status,
    currentTemperatureC,
    targetTemperatureC: 65,
    deadlineAtMs: DEADLINE_MS,
  });
  const poolPumpDiag = (
    status: DeferredObjectiveDiagnosticLike['status'],
    currentTemperatureC: number,
  ): DeferredObjectiveDiagnosticLike => buildTemperatureDiag({
    deviceId: 'dev_pool_pump',
    deviceName: 'Pool pump',
    status,
    currentTemperatureC,
    targetTemperatureC: 65,
    deadlineAtMs: MISSED_DEADLINE_MS,
  });

  recorder.observe([
    connected300Diag('on_track', 50),
    poolPumpDiag('at_risk', 50),
  ], T0);
  recorder.observe([
    connected300Diag('on_track', 60),
    poolPumpDiag('at_risk', 55),
  ], T0 + 3 * HOUR_MS);
  recorder.observe([
    connected300Diag('satisfied', 65),
    poolPumpDiag('cannot_meet', 58),
  ], T0 + 5 * HOUR_MS);

  // Final tick past both deadlines — no live diagnostics, both records finalize as deadline_passed.
  recorder.observe([], MISSED_DEADLINE_MS + 1);
  recorder.flushIfDirty();

  if (!saved) {
    throw new Error('Recorder did not produce any history entries');
  }
  return saved;
};

const groupByDevice = (
  history: DeferredObjectivePlanHistoryV4,
): Record<string, DeferredObjectivePlanHistoryEntry[]> => {
  const grouped: Record<string, DeferredObjectivePlanHistoryEntry[]> = {};
  for (const entry of history.entries) {
    const bucket = grouped[entry.deviceId] ?? [];
    bucket.push(entry);
    grouped[entry.deviceId] = bucket;
  }
  for (const deviceId of Object.keys(grouped)) {
    grouped[deviceId].sort((a, b) => b.finalizedAtMs - a.finalizedAtMs);
  }
  return grouped;
};

const stubHistory = (entriesByDeviceId: Record<string, DeferredObjectivePlanHistoryEntry[]>) => {
  (window as typeof window & { __PELS_HOMEY_STUB__?: unknown }).__PELS_HOMEY_STUB__ = {
    apiHandlers: {
      'GET /ui_deferred_objective_history': () => ({
        version: 1,
        entriesByDeviceId,
      }),
    },
  };
};

// Past plans are surfaced on the Smart tasks tab (Past tasks section). The
// per-device deadline-plan view no longer carries an in-page History tab —
// duplicating that list inside an individual plan view was confusing and
// kept showing empty for new devices.
const openHistory = async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Smart tasks' }).click();
};

test.describe('Deadline recorder → history UI round-trip', () => {
  test('runs through a met deadline and renders the Succeeded card', async ({ page }) => {
    const history = await runRecorder();
    const entriesByDeviceId = groupByDevice(history);

    expect(entriesByDeviceId['dev_connected300']).toHaveLength(1);
    expect(entriesByDeviceId['dev_connected300'][0].outcome).toBe('met');
    expect(entriesByDeviceId['dev_connected300'][0].startProgressC).toBe(50);
    expect(entriesByDeviceId['dev_connected300'][0].finalProgressC).toBe(65);

    // Only stub the entries for this device — the Smart tasks tab renders
    // history across every device, so leaving sibling devices in the stub
    // would pull in additional cards unrelated to this assertion.
    await page.addInitScript(stubHistory, { dev_connected300: entriesByDeviceId['dev_connected300'] });
    await openHistory(page);

    const list = page.locator('.deadlines-history');
    await expect(list).toBeVisible();
    const cards = list.locator('.plan-history-card');
    await expect(cards).toHaveCount(1);
    await expect(cards.first().locator('.plan-chip--ok')).toHaveText('Succeeded');
  });

  test('runs through a missed deadline and renders the Missed card', async ({ page }) => {
    const history = await runRecorder();
    const entriesByDeviceId = groupByDevice(history);

    expect(entriesByDeviceId['dev_pool_pump']).toHaveLength(1);
    expect(entriesByDeviceId['dev_pool_pump'][0].outcome).toBe('missed');
    expect(entriesByDeviceId['dev_pool_pump'][0].finalProgressC).toBe(58);

    await page.addInitScript(stubHistory, { dev_pool_pump: entriesByDeviceId['dev_pool_pump'] });
    await openHistory(page);

    const list = page.locator('.deadlines-history');
    await expect(list).toBeVisible();
    const cards = list.locator('.plan-history-card');
    await expect(cards).toHaveCount(1);
    await expect(cards.first().locator('.plan-chip--warn')).toHaveText('Missed');
  });

  // Regression: leading digits of the y-axis labels rendered under the chart
  // container's left edge as `.2 kWh` / `.9 kWh` instead of `1.2 / 0.9 kWh`
  // on every history-detail page. Caused by a fixed `grid.left: 36` that was
  // narrower than the label width; the fix uses `containLabel: true` so
  // ECharts auto-expands the grid to fit every label. Run at 480 px and at
  // 320 px so we catch a regression at either supported width.
  for (const viewport of [{ width: 480, height: 800 }, { width: 320, height: 700 }] as const) {
    test(`history-detail chart Y-axis labels fit inside container at ${viewport.width}px`, async ({ page }) => {
      // Build a synthetic history entry with `originalPlan` populated so the
      // chart actually renders. The recorder fixture above produces entries
      // without plan snapshots (`deadline_passed` finalization without a live
      // planner revision); a chart-clip test needs the plan bars to be drawn.
      const T0 = Date.UTC(2026, 4, 16, 4, 0, 0);
      const HOUR = 3_600_000;
      const entry = {
        id: 'fixture-yaxis-regression',
        deviceId: 'dev_connected300',
        deviceName: 'Connected 300',
        objectiveKind: 'temperature' as const,
        targetTemperatureC: 65,
        targetPercent: null,
        deadlineAtMs: T0 + 6 * HOUR,
        startedAtMs: T0,
        finalizedAtMs: T0 + 6 * HOUR + HOUR,
        startProgressC: 50,
        startProgressPercent: null,
        finalProgressC: 65,
        finalProgressPercent: null,
        initialEnergyNeededKWh: 4.0,
        outcome: 'met' as const,
        metAtMs: T0 + 5 * HOUR,
        usedDeadlineReserve: false,
        usedPolicyAvoid: false,
        observedIntervals: [{ fromMs: T0 + HOUR, toMs: T0 + 3 * HOUR }],
        discoveredFrom: 'observation' as const,
        // Plan values chosen so labels include a leading digit > 0: ECharts
        // splits the [0,1.2] axis into 0/0.3/0.6/0.9/1.2 kWh, exactly the
        // values the live walk reported being clipped to `.2`/`.9`/etc.
        originalPlan: {
          hours: [
            { startsAtMs: T0, plannedKWh: 1.2 },
            { startsAtMs: T0 + HOUR, plannedKWh: 0.9 },
            { startsAtMs: T0 + 2 * HOUR, plannedKWh: 0.6 },
            { startsAtMs: T0 + 3 * HOUR, plannedKWh: 0.3 },
            { startsAtMs: T0 + 4 * HOUR, plannedKWh: 0.6 },
            { startsAtMs: T0 + 5 * HOUR, plannedKWh: 0.4 },
          ],
          energyNeededKWh: 4.0,
          planStatus: 'on_track' as const,
          revisedAtMs: T0,
        },
        finalPlan: null,
        revisionCount: 1,
      };

      await page.setViewportSize(viewport);
      await page.addInitScript(stubHistory, { dev_connected300: [entry] });
      await page.goto(
        `/?page=deadline-plan&deviceId=dev_connected300&historyId=${encodeURIComponent(entry.id)}`,
        { waitUntil: 'domcontentloaded' },
      );

      // PR 3 collapses the chart by default on the Succeeded receipt shape
      // (this fixture is `outcome: 'met'`). Click the "View details" toggle
      // to render the chart before asserting its Y-axis labels fit.
      await page.locator('.plan-history-detail__chart-toggle').click();

      const chart = page.locator('.deadline-horizon-chart');
      await expect(chart).toBeVisible();
      await expect(chart.locator('svg')).toBeVisible();

      // Every y-axis label inside the SVG must render fully inside the
      // chart container's left/right bounds. A label whose left edge is to
      // the left of the container is being clipped by the container — the
      // original bug. We filter to labels ending in `kWh` so x-axis ticks
      // and legend text don't pollute the assertion.
      const offenders = await chart.evaluate((container) => {
        const rect = container.getBoundingClientRect();
        const labels = container.querySelectorAll('svg text');
        const issues: Array<{ text: string; left: number; right: number; containerLeft: number; containerRight: number }> = [];
        for (const node of Array.from(labels)) {
          if (!(node instanceof SVGTextElement)) continue;
          const text = (node.textContent ?? '').trim();
          if (!text.endsWith('kWh')) continue;
          const labelRect = node.getBoundingClientRect();
          if (labelRect.left < rect.left - 1 || labelRect.right > rect.right + 1) {
            issues.push({
              text,
              left: Number(labelRect.left.toFixed(2)),
              right: Number(labelRect.right.toFixed(2)),
              containerLeft: Number(rect.left.toFixed(2)),
              containerRight: Number(rect.right.toFixed(2)),
            });
          }
        }
        return issues;
      });
      expect(
        offenders,
        `Y-axis labels clipped by chart container: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
    });
  }
});
