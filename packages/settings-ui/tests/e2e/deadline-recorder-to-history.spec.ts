import { expect, test, type Page } from './fixtures/test';
import { build as buildRuntimeBundle } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryV3,
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
    load: () => DeferredObjectivePlanHistoryV3 | null;
    save: (history: DeferredObjectivePlanHistoryV3) => boolean;
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

const runRecorder = async (): Promise<DeferredObjectivePlanHistoryV3> => {
  const { DeferredObjectivePlanHistoryRecorder } = await loadPlanHistoryRuntime();
  let saved: DeferredObjectivePlanHistoryV3 | null = null;
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
  history: DeferredObjectivePlanHistoryV3,
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

const openHistory = async (page: Page, deviceId: string) => {
  await page.goto(`/deadline-plan.html?deviceId=${deviceId}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'History' }).click();
};

test.describe('Deadline recorder → history UI round-trip', () => {
  test('runs through a met deadline and renders the Succeeded card', async ({ page }) => {
    const history = await runRecorder();
    const entriesByDeviceId = groupByDevice(history);

    expect(entriesByDeviceId['dev_connected300']).toHaveLength(1);
    expect(entriesByDeviceId['dev_connected300'][0].outcome).toBe('met');
    expect(entriesByDeviceId['dev_connected300'][0].startProgressC).toBe(50);
    expect(entriesByDeviceId['dev_connected300'][0].finalProgressC).toBe(65);

    await page.addInitScript(stubHistory, entriesByDeviceId);
    await openHistory(page, 'dev_connected300');

    const list = page.getByLabel('Past plans');
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

    await page.addInitScript(stubHistory, entriesByDeviceId);
    await openHistory(page, 'dev_pool_pump');

    const list = page.getByLabel('Past plans');
    await expect(list).toBeVisible();
    const cards = list.locator('.plan-history-card');
    await expect(cards).toHaveCount(1);
    await expect(cards.first().locator('.plan-chip--warn')).toHaveText('Missed');
  });
});
