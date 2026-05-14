import { h, render } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
} from '../../contracts/src/deferredObjectivePlanHistory';

vi.mock('../src/ui/echartsRegistry.ts', () => ({
  initEcharts: vi.fn(() => ({
    setOption: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
  })),
  encodeHtml: (value: string) => value,
}));

const HOUR_MS = 60 * 60 * 1000;
const DEADLINE_MS = Date.UTC(2026, 4, 6, 6, 0, 0);

const buildRevision = (
  overrides: Partial<DeferredObjectivePlanHistoryRevisionSnapshot> = {},
): DeferredObjectivePlanHistoryRevisionSnapshot => ({
  hours: [{ startsAtMs: DEADLINE_MS - 2 * HOUR_MS, plannedKWh: 2 }],
  energyNeededKWh: 2,
  planStatus: 'on_track',
  revisedAtMs: DEADLINE_MS - 3 * HOUR_MS,
  ...overrides,
});

const buildEntry = (
  overrides: Partial<DeferredObjectivePlanHistoryEntry> = {},
): DeferredObjectivePlanHistoryEntry => ({
  id: 'entry-test-1',
  deviceId: 'dev_water_heater',
  deviceName: 'Connected 300',
  objectiveKind: 'temperature',
  targetTemperatureC: 65,
  targetPercent: null,
  deadlineAtMs: DEADLINE_MS,
  startedAtMs: DEADLINE_MS - 6 * HOUR_MS,
  finalizedAtMs: DEADLINE_MS,
  startProgressC: 50,
  startProgressPercent: null,
  finalProgressC: 65,
  finalProgressPercent: null,
  initialEnergyNeededKWh: 22.5,
  outcome: 'met',
  metAtMs: DEADLINE_MS - HOUR_MS,
  usedDeadlineReserve: false,
  usedPolicyAvoid: false,
  observedIntervals: [{ fromMs: DEADLINE_MS - 6 * HOUR_MS, toMs: DEADLINE_MS - 3 * HOUR_MS }],
  discoveredFrom: 'observation',
  originalPlan: null,
  finalPlan: null,
  ...overrides,
});

const mount = async (entry: DeferredObjectivePlanHistoryEntry): Promise<HTMLElement> => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const { DeadlinePlanHistoryDetail } = await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
  render(h(DeadlinePlanHistoryDetail, { entry, timeZone: 'UTC' }), root);
  return root;
};

const stubPalette = {
  device: '#0ff', deviceMuted: '#222', observed: '#0f0',
  text: '#fff', muted: '#888', grid: '#333',
  tooltipBackground: '#000', tooltipText: '#fff', tooltipBorder: '#444',
};

describe('DeadlinePlanHistoryDetail', () => {
  it('renders the "no plan detail recorded" fallback when both plan snapshots are null', async () => {
    const root = await mount(buildEntry({ originalPlan: null, finalPlan: null }));
    expect(root.textContent).toContain('No plan detail was recorded for this run');
    expect(root.querySelector('.deadline-horizon-chart')).toBeNull();
  });

  it('renders the chart card when at least one plan snapshot exists', async () => {
    const revision = buildRevision();
    const root = await mount(buildEntry({ originalPlan: revision, finalPlan: revision }));
    expect(root.querySelector('.deadline-horizon-chart')).not.toBeNull();
    expect(root.textContent).toContain('Plan vs observed');
  });

  it('suppresses the Original plan overlay when original and final revisions are identical', async () => {
    const revision = buildRevision();
    const root = await mount(buildEntry({ originalPlan: revision, finalPlan: revision }));
    const legend = root.querySelectorAll('.deadline-horizon-chart');
    expect(legend.length).toBe(1);
    // Re-build the option directly via the exported helper so we can inspect
    // which series the chart actually drew without depending on echarts
    // running inside JSDOM.
    const { buildHistoryDetailRows, buildHistoryDetailChartOption } =
      await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
    const rows = buildHistoryDetailRows(revision, revision, [], 'UTC');
    const option = buildHistoryDetailChartOption(rows, stubPalette, false, true) as {
      series: Array<{ name: string }>;
    };
    const seriesNames = option.series.map((entry) => entry.name);
    expect(seriesNames).toContain('Final plan');
    expect(seriesNames).not.toContain('Original plan');
  });

  it('falls back to the original snapshot when no final revision was recorded', async () => {
    const original = buildRevision({
      hours: [{ startsAtMs: DEADLINE_MS - 3 * HOUR_MS, plannedKWh: 2 }],
    });
    const { buildHistoryDetailRows } =
      await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
    const rows = buildHistoryDetailRows(original, null, [], 'UTC');
    // Only the original snapshot was recorded. The row's `finalKWh` mirrors
    // the original so the chart still draws bars (instead of an empty chart)
    // and the diff-based overlay gate stays suppressed.
    expect(rows).toHaveLength(1);
    expect(rows[0].originalKWh).toBe(2);
    expect(rows[0].finalKWh).toBe(2);
  });

  it('builds rows that mark observed hours and pair original/final kWh', async () => {
    const { buildHistoryDetailRows, buildHistoryDetailChartOption } =
      await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
    const original = buildRevision({
      hours: [{ startsAtMs: DEADLINE_MS - 4 * HOUR_MS, plannedKWh: 1 }],
      energyNeededKWh: 1,
    });
    const final = buildRevision({
      hours: [{ startsAtMs: DEADLINE_MS - 2 * HOUR_MS, plannedKWh: 3 }],
      energyNeededKWh: 3,
    });
    const rows = buildHistoryDetailRows(
      original,
      final,
      [{ fromMs: DEADLINE_MS - 4 * HOUR_MS, toMs: DEADLINE_MS - 3 * HOUR_MS }],
      'UTC',
    );
    expect(rows.map((row) => row.originalKWh)).toEqual([1, 0]);
    expect(rows.map((row) => row.finalKWh)).toEqual([0, 3]);
    expect(rows.map((row) => row.observed)).toEqual([true, false]);

    const option = buildHistoryDetailChartOption(rows, stubPalette, true, true) as {
      series: Array<{ name: string }>;
    };
    const seriesNames = option.series.map((entry) => entry.name);
    expect(seriesNames).toContain('Original plan');
    expect(seriesNames).toContain('Final plan');
    expect(seriesNames).toContain('Observed charging');
  });
});
