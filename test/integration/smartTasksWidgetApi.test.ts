/**
 * @vitest-environment node
 *
 * Scenario tests for the smart_tasks widget that mock the app's SDK/settings
 * data sources and run the REAL `getSmartTasks` API handler end-to-end
 * (api → payload builder → shared-domain chart producers). The widget previews
 * carry a *static* chart object, so they bypass `resolveActivePlanChartData`
 * entirely — these tests exercise the live producer path that the previews
 * can't, and pin the states that only show up with real SDK-shaped data.
 */
import { getSmartTasks } from '../../widgets/smart_tasks/src/api';
import type {
  DeferredObjectiveActivePlanV1,
  ResolvedDeferredObjectiveActivePlansV1,
} from '../../packages/contracts/src/deferredObjectiveActivePlans';
import { toResolvedActivePlans } from '../../packages/shared-domain/src/deferredActivePlanResolvedView';
import type {
  DeferredObjectivePlanHistoryEntry,
  ResolvedDeferredObjectivePlanHistoryEntry,
} from '../../packages/contracts/src/deferredObjectivePlanHistory';
import type { SettingsUiDeferredObjectivePlanHistoryPayload } from '../../packages/contracts/src/settingsUiApi';
import { toResolvedPlanHistoryEntry } from '../../packages/shared-domain/src/deferredPlanHistoryResolvedView';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

const NOW = Date.now();
const H = 60 * 60 * 1000;

const activePlan = (o: Partial<DeferredObjectiveActivePlanV1> = {}): DeferredObjectiveActivePlanV1 => ({
  deviceId: 'wh',
  deviceName: 'Water heater',
  objectiveKind: 'temperature',
  targetTemperatureC: 65,
  targetPercent: null,
  deadlineAtMs: NOW + 5 * H,
  startedAtMs: NOW - 2 * H,
  pending: false,
  objectiveSignature: 'sig',
  original: null,
  latest: {
    revision: 1,
    revisedAtMs: NOW,
    computedFromPricesUpTo: null,
    reason: 'flow_card',
    hours: [{ startsAtMs: NOW, plannedKWh: 1 }, { startsAtMs: NOW + H, plannedKWh: 1 }],
    energyNeededKWh: 2,
    planStatus: 'on_track',
    rateMean: 0.5,
  },
  ...o,
});

const device = (o: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
  id: 'wh',
  name: 'Water heater',
  zoneName: null,
  capabilities: [],
  ...o,
} as TargetDeviceSnapshot);

const historyEntry = (
  o: Partial<DeferredObjectivePlanHistoryEntry> = {},
): ResolvedDeferredObjectivePlanHistoryEntry => toResolvedPlanHistoryEntry({
  id: `e${Math.random()}`,
  deviceId: 'wh',
  deviceName: 'Water heater',
  objectiveKind: 'temperature',
  targetTemperatureC: 65,
  targetPercent: null,
  deadlineAtMs: NOW - H,
  startedAtMs: NOW - 5 * H,
  finalizedAtMs: NOW - H,
  startProgressC: 40,
  startProgressPercent: null,
  finalProgressC: 65,
  finalProgressPercent: null,
  initialEnergyNeededKWh: 4,
  outcome: 'met',
  metAtMs: NOW - H,
  usedDeadlineReserve: false,
  observedIntervals: [],
  discoveredFrom: 'observation',
  originalPlan: {
    hours: [{ startsAtMs: NOW - 5 * H, plannedKWh: 1 }, { startsAtMs: NOW - 4 * H, plannedKWh: 1 }],
    energyNeededKWh: 2,
    planStatus: 'on_track',
    revisedAtMs: NOW - 5 * H,
    kwhPerUnitMean: 0.5,
  },
  finalPlan: null,
  progressSamples: [
    { atMs: NOW - 5 * H, valueC: 40, valuePercent: null },
    { atMs: NOW - 4 * H, valueC: 50, valuePercent: null },
  ],
  ...o,
});

const emptyHistory: SettingsUiDeferredObjectivePlanHistoryPayload = { version: 1, entriesByDeviceId: {} };

// Structural mock of the app methods the widget API reads — the SDK/settings
// surface, faked. Every method optional, matching the real `WidgetApiApp`.
type AppMock = {
  getDeferredObjectiveActivePlansUiPayload?: () => ResolvedDeferredObjectiveActivePlansV1 | null;
  getDeferredObjectivePlanHistoryRecentUiPayload?: (sinceMs: number) => SettingsUiDeferredObjectivePlanHistoryPayload;
  getDeferredObjectivePlanHistoryUiPayload?: () => SettingsUiDeferredObjectivePlanHistoryPayload;
  getUiPickerDevices?: () => TargetDeviceSnapshot[];
};

const run = (app: AppMock, timeZone = 'UTC') => getSmartTasks({
  homey: { app, clock: { getTimezone: () => timeZone } },
});

// The app's `getDeferredObjectiveActivePlansUiPayload` returns the RESOLVED
// container in production (the assembler stitches trajectory then resolves the
// kind-split columns), so resolve the raw fixtures here at the same boundary.
const plansOf = (...plans: DeferredObjectiveActivePlanV1[]): ResolvedDeferredObjectiveActivePlansV1 =>
  toResolvedActivePlans({
    version: 1,
    plansByDeviceId: Object.fromEntries(plans.map((p) => [p.deviceId, p])),
  });

describe('smart_tasks widget API — mocked SDK/settings scenarios', () => {
  test('active task with stitched start + samples renders a planned+observed trajectory', async () => {
    const payload = await run({
      getDeferredObjectiveActivePlansUiPayload: () => plansOf(activePlan({
        startProgressC: 42,
        progressSamples: [
          { atMs: NOW - 2 * H, valueC: 42, valuePercent: null },
          { atMs: NOW - H, valueC: 48, valuePercent: null },
        ],
      })),
      getDeferredObjectivePlanHistoryRecentUiPayload: () => emptyHistory,
      getUiPickerDevices: () => [device({ currentTemperature: 48 })],
    });
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows[0].chart?.mode).toBe('trajectory');
    expect(payload.rows[0].chart?.plannedOriginal.length).toBeGreaterThanOrEqual(2);
    expect(payload.rows[0].chart?.observed.length).toBeGreaterThanOrEqual(2);
  });

  test('REGRESSION: active task with NO stitch still charts from the live device reading', async () => {
    // The on-device bug: the in-progress stitch delivered no start progress and
    // no samples (e.g. just after an app restart), but the device snapshot has a
    // current temperature. The planned line must still render.
    const payload = await run({
      getDeferredObjectiveActivePlansUiPayload: () => plansOf(activePlan()),
      getDeferredObjectivePlanHistoryRecentUiPayload: () => emptyHistory,
      getUiPickerDevices: () => [device({ currentTemperature: 30 })],
    });
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows[0].chart?.mode).toBe('trajectory');
    expect(payload.rows[0].chart?.plannedOriginal.length).toBeGreaterThanOrEqual(2);
  });

  test('active task with NO stitch AND no live reading → no chart (honest, not a glitch)', async () => {
    const payload = await run({
      getDeferredObjectiveActivePlansUiPayload: () => plansOf(activePlan()),
      getDeferredObjectivePlanHistoryRecentUiPayload: () => emptyHistory,
      getUiPickerDevices: () => [device({})],
    });
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect(payload.rows[0].chart).toBeNull();
  });

  test('recently-ended met + missed render outcome chips, why copy, and charts', async () => {
    const payload = await run({
      getDeferredObjectiveActivePlansUiPayload: () => null,
      getDeferredObjectivePlanHistoryRecentUiPayload: () => ({
        version: 1,
        entriesByDeviceId: {
          wh: [historyEntry({ id: 'met', outcome: 'met', finalizedAtMs: NOW - H })],
          wh2: [historyEntry({
            id: 'missed',
            deviceId: 'wh2',
            outcome: 'missed',
            metAtMs: null,
            finalProgressC: 48,
            finalizedAtMs: NOW - 2 * H,
            finalPlan: {
              hours: [{ startsAtMs: NOW - 5 * H, plannedKWh: 1 }],
              energyNeededKWh: 4,
              planStatus: 'cannot_meet',
              revisedAtMs: NOW - 5 * H,
              kwhPerUnitMean: 0.5,
              dailyBudgetExhaustedBucketCount: 2,
            },
          })],
        },
      }),
      getUiPickerDevices: () => [],
    });
    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') return;
    expect([...payload.endedRows.map((r) => r.outcomeLabel)].sort()).toEqual(['Missed', 'Succeeded']);
    const missed = payload.endedRows.find((r) => r.outcomeLabel === 'Missed')!;
    expect(missed.whyLabel).toContain('Daily budget');
    expect(missed.recourseHint).toContain('Budget settings');
    expect(missed.chart?.mode).toBe('trajectory');
  });

  test('uses the bounded recent-history method with a 24h window', async () => {
    // Freeze time so the handler's internal Date.now() is deterministic — the
    // assertion is then exact rather than a CI-timing-dependent tolerance.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      let sinceMs: number | null = null;
      await run({
        getDeferredObjectiveActivePlansUiPayload: () => null,
        getDeferredObjectivePlanHistoryRecentUiPayload: (s) => { sinceMs = s; return emptyHistory; },
        getUiPickerDevices: () => [],
      });
      expect(sinceMs).toBe(NOW - 24 * H);
    } finally {
      vi.useRealTimers();
    }
  });

  test('falls back to the full-history method when the bounded one is absent (older app build)', async () => {
    let fullCalled = false;
    const payload = await run({
      getDeferredObjectiveActivePlansUiPayload: () => null,
      getDeferredObjectivePlanHistoryUiPayload: () => {
        fullCalled = true;
        return { version: 1, entriesByDeviceId: { wh: [historyEntry({ id: 'm' })] } };
      },
      getUiPickerDevices: () => [],
    });
    expect(fullCalled).toBe(true);
    expect(payload.state).toBe('ready');
  });

  test('empty when no active plans and no recent history', async () => {
    const payload = await run({
      getDeferredObjectiveActivePlansUiPayload: () => null,
      getDeferredObjectivePlanHistoryRecentUiPayload: () => emptyHistory,
      getUiPickerDevices: () => [],
    });
    expect(payload.state).toBe('empty');
  });

  test('degrades to empty (no throw) when the app exposes none of the methods', async () => {
    const payload = await run({});
    expect(payload.state).toBe('empty');
  });
});
