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
  it('renders a "Smart task" eyebrow above the heading', async () => {
    const root = await mount(buildEntry({ originalPlan: null, finalPlan: null }));
    const eyebrow = root.querySelector('.plan-history-detail__eyebrow');
    expect(eyebrow?.textContent).toBe('Smart task');
  });

  it('promotes the outcome chip into its own row above the timestamp', async () => {
    const root = await mount(buildEntry({ outcome: 'met' }));
    const outcomeRow = root.querySelector('.plan-history-detail__outcome');
    expect(outcomeRow).not.toBeNull();
    const chip = outcomeRow!.querySelector('.plan-history-detail__outcome-chip');
    expect(chip?.textContent).toBe('Succeeded');
  });

  it('brings the device name onto the heading line', async () => {
    const root = await mount(buildEntry({ deviceName: 'Connected 300' }));
    const heading = root.querySelector('.plan-history-detail__heading');
    expect(heading?.textContent).toContain('Connected 300');
    // The standalone device paragraph that used to sit below the heading must
    // no longer appear — the spec was to bring it *onto* the heading line.
    expect(root.querySelector('.plan-history-detail__device')).toBeNull();
  });

  it('renders the "no hourly schedule was saved" fallback when both plan snapshots are null', async () => {
    const root = await mount(buildEntry({ originalPlan: null, finalPlan: null }));
    expect(root.textContent).toContain('No hourly schedule was saved for this run');
    expect(root.querySelector('.deadline-horizon-chart')).toBeNull();
  });

  it('renders the chart card when at least one plan snapshot exists (missed outcome — always expanded)', async () => {
    // Missed entries land with `chartCollapsedByDefault: false` so the chart
    // is rendered immediately (diagnosis-shape hero). Succeeded entries
    // default to the receipt-shape (chart collapsed) and require the user to
    // click "View schedule" — covered in a separate test below.
    const revision = buildRevision({ planStatus: 'cannot_meet' });
    const root = await mount(buildEntry({
      outcome: 'missed',
      finalProgressC: 38,
      originalPlan: revision,
      finalPlan: revision,
    }));
    expect(root.querySelector('.deadline-horizon-chart')).not.toBeNull();
    // Card title uses smart-task-noun vocabulary, not planner-noun "Plan".
    expect(root.textContent).toContain('Scheduled vs observed');
  });

  it('suppresses the initial-schedule overlay when original and final revisions are identical', async () => {
    const revision = buildRevision({ planStatus: 'cannot_meet' });
    // Missed outcome forces the chart open by default (`chartCollapsedByDefault: false`).
    const root = await mount(buildEntry({
      outcome: 'missed',
      finalProgressC: 38,
      originalPlan: revision,
      finalPlan: revision,
    }));
    const legend = root.querySelectorAll('.deadline-horizon-chart');
    expect(legend.length).toBe(1);
    // Re-build the option directly via the exported helper so we can inspect
    // which series the chart actually drew without depending on echarts
    // running inside JSDOM.
    const { buildHistoryDetailRows, buildHistoryDetailChartOption } =
      await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
    const rows = buildHistoryDetailRows(revision, revision, [], 'UTC', {
      startedAtMs: DEADLINE_MS - 2 * HOUR_MS,
      deadlineAtMs: DEADLINE_MS - HOUR_MS,
    });
    const option = buildHistoryDetailChartOption(
      rows,
      stubPalette,
      false,
      true,
      'Measured Heating',
    ) as {
      series: Array<{ name: string }>;
    };
    const seriesNames = option.series.map((entry) => entry.name);
    expect(seriesNames).toContain('Revised schedule');
    expect(seriesNames).not.toContain('Initial schedule');
  });

  it('falls back to the original snapshot when no final revision was recorded', async () => {
    const original = buildRevision({
      hours: [{ startsAtMs: DEADLINE_MS - 3 * HOUR_MS, plannedKWh: 2 }],
    });
    const { buildHistoryDetailRows } =
      await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
    const rows = buildHistoryDetailRows(original, null, [], 'UTC', {
      startedAtMs: DEADLINE_MS - 3 * HOUR_MS,
      deadlineAtMs: DEADLINE_MS - 2 * HOUR_MS,
    });
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
      { startedAtMs: DEADLINE_MS - 4 * HOUR_MS, deadlineAtMs: DEADLINE_MS - HOUR_MS },
    );
    // Window spans 3 hours; the gap hour at -3h is included with zeroes so
    // the chart axis covers the deadline window even though no plan or
    // observation touched that hour.
    expect(rows.map((row) => row.originalKWh)).toEqual([1, 0, 0]);
    expect(rows.map((row) => row.finalKWh)).toEqual([0, 0, 3]);
    expect(rows.map((row) => row.observed)).toEqual([true, false, false]);

    const option = buildHistoryDetailChartOption(
      rows,
      stubPalette,
      true,
      true,
      'Measured Charging',
    ) as {
      series: Array<{ name: string }>;
      legend: { data: Array<{ name: string }> };
    };
    const seriesNames = option.series.map((entry) => entry.name);
    expect(seriesNames).toContain('Initial schedule');
    expect(seriesNames).toContain('Revised schedule');
    expect(seriesNames).toContain('Measured Charging');
    const legendNames = option.legend.data.map((entry) => entry.name);
    expect(legendNames).toContain('Measured Charging');
  });

  it('seeds every hour in the deadline window even when the plan covers only one', async () => {
    // Regression: a one-hour plan would previously render as a single floating
    // bar with no temporal context. The chart must span [startedAtMs, deadlineAtMs)
    // so the user sees the full window with the planned hour in context.
    const { buildHistoryDetailRows } =
      await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
    const onlyHour = buildRevision({
      hours: [{ startsAtMs: DEADLINE_MS - HOUR_MS, plannedKWh: 0.6 }],
      energyNeededKWh: 0.6,
    });
    const rows = buildHistoryDetailRows(onlyHour, onlyHour, [], 'UTC', {
      startedAtMs: DEADLINE_MS - 8 * HOUR_MS,
      deadlineAtMs: DEADLINE_MS,
    });
    expect(rows).toHaveLength(8);
    // The planned hour sits at the end of the window; every earlier hour is zero.
    expect(rows.slice(0, 7).every((row) => row.finalKWh === 0)).toBe(true);
    expect(rows[7]!.finalKWh).toBeCloseTo(0.6);
  });

  it('omits the observed-series legend item when no hour was observed', async () => {
    const { buildHistoryDetailRows, buildHistoryDetailChartOption } =
      await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
    const revision = buildRevision();
    const rows = buildHistoryDetailRows(revision, revision, [], 'UTC', {
      startedAtMs: DEADLINE_MS - 2 * HOUR_MS,
      deadlineAtMs: DEADLINE_MS,
    });
    const option = buildHistoryDetailChartOption(
      rows,
      stubPalette,
      false,
      true,
      'Measured Heating',
    ) as {
      legend: { data: Array<{ name: string }> };
    };
    const legendNames = option.legend.data.map((entry) => entry.name);
    expect(legendNames).not.toContain('Measured Heating');
    expect(legendNames).not.toContain('Measured Charging');
  });

  it('y-axis uses multiple ticks instead of a single ceiling label', async () => {
    const { buildHistoryDetailRows, buildHistoryDetailChartOption } =
      await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
    const revision = buildRevision();
    const rows = buildHistoryDetailRows(revision, revision, [], 'UTC', {
      startedAtMs: DEADLINE_MS - 2 * HOUR_MS,
      deadlineAtMs: DEADLINE_MS,
    });
    const option = buildHistoryDetailChartOption(
      rows,
      stubPalette,
      false,
      true,
      'Measured Heating',
    ) as {
      yAxis: { splitNumber?: number; interval?: number };
    };
    expect(option.yAxis.splitNumber).toBe(4);
    expect(option.yAxis.interval).toBeUndefined();
  });

  it('uses the kind-aware Measured Heating series name for thermostat runs', async () => {
    const { buildHistoryDetailRows, buildHistoryDetailChartOption } =
      await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
    const { deadlineLabels } = await import('../../shared-domain/src/deadlineLabels');
    const revision = buildRevision();
    const rows = buildHistoryDetailRows(
      revision,
      revision,
      [{ fromMs: DEADLINE_MS - 2 * HOUR_MS, toMs: DEADLINE_MS - HOUR_MS }],
      'UTC',
      { startedAtMs: DEADLINE_MS - 2 * HOUR_MS, deadlineAtMs: DEADLINE_MS },
    );
    const observedSeriesName = deadlineLabels('temperature').actualDeviceSeriesName;
    expect(observedSeriesName).toBe('Measured Heating');
    const option = buildHistoryDetailChartOption(
      rows,
      stubPalette,
      false,
      true,
      observedSeriesName,
    ) as {
      series: Array<{ name: string }>;
      legend: { data: Array<{ name: string }> };
    };
    expect(option.series.map((s) => s.name)).toContain('Measured Heating');
    expect(option.legend.data.map((l) => l.name)).toContain('Measured Heating');
  });

  // Missed-history detail used to render a chart + chip only; users opening
  // a missed run had no copy explaining *why*. The reason resolver now plumbs
  // a postmortem sentence under the progress line so the surface mirrors the
  // succeeded path's explanation density.
  it('renders a missed-reason sentence under the progress line on missed entries', async () => {
    const finalCannotMeet = buildRevision({ planStatus: 'cannot_meet' });
    const root = await mount(buildEntry({
      outcome: 'missed',
      finalProgressC: 38,
      originalPlan: finalCannotMeet,
      finalPlan: finalCannotMeet,
    }));
    const reason = root.querySelector('.plan-history-detail__missed-reason');
    expect(reason).not.toBeNull();
    expect(reason?.textContent).toMatch(/couldn.t reserve enough energy/i);
  });

  it('omits the missed-reason sentence on succeeded entries', async () => {
    const root = await mount(buildEntry({ outcome: 'met' }));
    expect(root.querySelector('.plan-history-detail__missed-reason')).toBeNull();
  });

  it('renders the observed-vs-target progress line even on missed entries', async () => {
    const root = await mount(buildEntry({
      outcome: 'missed',
      startProgressC: 50,
      finalProgressC: 38,
      targetTemperatureC: 65,
    }));
    const progress = root.querySelector('.plan-history-detail__progress');
    expect(progress).not.toBeNull();
    expect(progress?.textContent).toContain('50.0 °C');
    expect(progress?.textContent).toContain('38.0 °C');
    expect(progress?.textContent).toContain('target 65.0 °C');
  });

  // v2.7.2 PR 3 — outcome-asymmetric hero shapes. Each shape carries a
  // different combination of tone, secondary line, "why" line, recourse
  // CTA, and default chart-collapsed state, mirroring the table in
  // `notes/smart-task-ui/README.md` ("Asymmetric treatment of failure").
  describe('outcome-asymmetric hero (PR 3)', () => {
    it('Succeeded shape: tone=ok, postmortem present, no recourse, chart collapsed by default', async () => {
      const root = await mount(buildEntry({
        outcome: 'met',
        metAtMs: DEADLINE_MS - 4 * HOUR_MS - 3 * 60 * 1000,
        finalProgressC: 65,
        originalPlan: buildRevision(),
        finalPlan: buildRevision(),
      }));
      const hero = root.querySelector<HTMLElement>('.plan-history-detail__hero');
      expect(hero?.dataset.tone).toBe('good');
      // Postmortem sentence under the heading.
      const postmortem = root.querySelector('.plan-history-detail__postmortem');
      expect(postmortem).not.toBeNull();
      expect(postmortem?.textContent).toContain('65.0 °C');
      // No recourse CTA on succeeded.
      expect(root.querySelector('.plan-history-detail__recourse')).toBeNull();
      // No "Why" line on succeeded.
      expect(root.querySelector('.plan-history-detail__missed-reason')).toBeNull();
      // Chart card exists but the comparison chart is collapsed — "View
      // schedule" toggle visible.
      const toggle = root.querySelector('.plan-history-detail__chart-toggle');
      expect(toggle).not.toBeNull();
      expect(toggle?.textContent).toBe('View schedule');
      expect(root.querySelector('.deadline-horizon-chart')).toBeNull();
    });

    it('Missed shape: tone=warn, postmortem + Why line + recourse, chart always expanded', async () => {
      const revision = buildRevision({
        planStatus: 'cannot_meet',
        dailyBudgetExhaustedBucketCount: 4,
      });
      const root = await mount(buildEntry({
        outcome: 'missed',
        finalProgressC: 38,
        targetTemperatureC: 65,
        originalPlan: revision,
        finalPlan: revision,
      }));
      const hero = root.querySelector<HTMLElement>('.plan-history-detail__hero');
      expect(hero?.dataset.tone).toBe('warn');
      // Postmortem on Missed.
      expect(root.querySelector('.plan-history-detail__postmortem')?.textContent)
        .toMatch(/daily energy budget/);
      // "Why" line on Missed.
      expect(root.querySelector('.plan-history-detail__missed-reason')?.textContent)
        .toMatch(/daily/i);
      // Recourse CTA on Missed.
      const recourseBtn = root.querySelector<HTMLButtonElement>('.plan-history-detail__recourse button');
      expect(recourseBtn).not.toBeNull();
      expect(recourseBtn?.dataset.deadlineRecourseTab).toBe('budget');
      expect(recourseBtn?.textContent).toContain('Lower daily budget');
      // Missed → chart is rendered expanded; no toggle.
      expect(root.querySelector('.plan-history-detail__chart-toggle')).toBeNull();
      expect(root.querySelector('.deadline-horizon-chart')).not.toBeNull();
    });

    it('Missed-by-shortfall recourse uses Move-deadline-later, not budget', async () => {
      const revision = buildRevision({ planStatus: 'cannot_meet' });
      const root = await mount(buildEntry({
        outcome: 'missed',
        finalProgressC: 38,
        targetTemperatureC: 65,
        originalPlan: revision,
        finalPlan: revision,
      }));
      const recourseBtn = root.querySelector<HTMLButtonElement>('.plan-history-detail__recourse button');
      expect(recourseBtn?.textContent).toContain('Move deadline later');
      expect(recourseBtn?.dataset.deadlineRecourseTab).toBe('overview');
    });

    it('Abandoned shape: tone=muted, postmortem present, no recourse, chart collapsed', async () => {
      const root = await mount(buildEntry({
        outcome: 'abandoned',
        objectiveKind: 'ev_soc',
        targetTemperatureC: null,
        targetPercent: 80,
        startProgressC: null,
        startProgressPercent: 30,
        finalProgressC: null,
        finalProgressPercent: 45,
        finalizedAtMs: DEADLINE_MS - 13 * HOUR_MS,
        originalPlan: buildRevision(),
        finalPlan: buildRevision(),
      }));
      const hero = root.querySelector<HTMLElement>('.plan-history-detail__hero');
      expect(hero?.dataset.tone).toBe('muted');
      expect(root.querySelector('.plan-history-detail__postmortem')?.textContent)
        .toMatch(/stopped/);
      // No recourse / Why on Abandoned.
      expect(root.querySelector('.plan-history-detail__recourse')).toBeNull();
      expect(root.querySelector('.plan-history-detail__missed-reason')).toBeNull();
      // Chart collapsed by default on Abandoned.
      expect(root.querySelector('.plan-history-detail__chart-toggle')).not.toBeNull();
      expect(root.querySelector('.deadline-horizon-chart')).toBeNull();
    });

    it('Succeeded hero has a "View schedule" toggle that expands the chart on click', async () => {
      const root = await mount(buildEntry({
        outcome: 'met',
        metAtMs: DEADLINE_MS - 4 * HOUR_MS,
        finalProgressC: 65,
        originalPlan: buildRevision(),
        finalPlan: buildRevision(),
      }));
      const toggle = root.querySelector<HTMLButtonElement>('.plan-history-detail__chart-toggle');
      expect(toggle).not.toBeNull();
      expect(root.querySelector('.deadline-horizon-chart')).toBeNull();
      toggle!.click();
      // Preact's effect/render is synchronous on click in JSDOM here.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(toggle!.textContent).toBe('Hide schedule');
      expect(root.querySelector('.deadline-horizon-chart')).not.toBeNull();
    });
  });

  it('uses the kind-aware Measured Charging series name for EV runs', async () => {
    const { buildHistoryDetailRows, buildHistoryDetailChartOption } =
      await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
    const { deadlineLabels } = await import('../../shared-domain/src/deadlineLabels');
    const revision = buildRevision();
    const rows = buildHistoryDetailRows(
      revision,
      revision,
      [{ fromMs: DEADLINE_MS - 2 * HOUR_MS, toMs: DEADLINE_MS - HOUR_MS }],
      'UTC',
      { startedAtMs: DEADLINE_MS - 2 * HOUR_MS, deadlineAtMs: DEADLINE_MS },
    );
    const observedSeriesName = deadlineLabels('ev_soc').actualDeviceSeriesName;
    expect(observedSeriesName).toBe('Measured Charging');
    const option = buildHistoryDetailChartOption(
      rows,
      stubPalette,
      false,
      true,
      observedSeriesName,
    ) as {
      series: Array<{ name: string }>;
      legend: { data: Array<{ name: string }> };
    };
    expect(option.series.map((s) => s.name)).toContain('Measured Charging');
    expect(option.legend.data.map((l) => l.name)).toContain('Measured Charging');
  });
});
