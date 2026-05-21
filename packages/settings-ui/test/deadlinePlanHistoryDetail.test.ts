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

const mount = async (
  entry: DeferredObjectivePlanHistoryEntry,
  options: { costUnit?: string } = {},
): Promise<HTMLElement> => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const { DeadlinePlanHistoryDetail } = await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
  render(
    h(DeadlinePlanHistoryDetail, { entry, timeZone: 'UTC', costUnit: options.costUnit ?? '' }),
    root,
  );
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
    // click "View details" — covered in a separate test below.
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
    // v2.7.3 — blameless rewrite. The cannot_meet branch reads "PELS
    // couldn't reserve enough cheap hours before the deadline." with no
    // recourse copy (the recourse button carries that signal).
    expect(reason?.textContent).toMatch(/couldn.t reserve enough cheap hours/i);
    // Recourse copy must not duplicate the recourse button.
    expect(reason?.textContent?.toLowerCase()).not.toContain('try lowering');
    expect(reason?.textContent?.toLowerCase()).not.toContain('moving the deadline');
  });

  it('omits the missed-reason sentence on succeeded entries', async () => {
    const root = await mount(buildEntry({ outcome: 'met' }));
    expect(root.querySelector('.plan-history-detail__missed-reason')).toBeNull();
  });

  // v2.7.3 — the legacy `formatPlanHistoryProgressLine` paragraph
  // ("Charged 50.0 → 38.0 °C, target 65.0 °C") is retired on every outcome
  // shape. Missed entries surface the same "by how much" signal via the
  // shortfall chip + reachedAtLine; the progressLine paragraph was density
  // duplication (`pels-ux-fit` finding).
  it('retires the legacy progress paragraph on missed entries (shortfall chip carries the signal)', async () => {
    const root = await mount(buildEntry({
      outcome: 'missed',
      startProgressC: 50,
      finalProgressC: 38,
      targetTemperatureC: 65,
    }));
    // No `__progress` paragraph (the legacy "Charged X → Y, target Z" line
    // is gone). The reachedAtLine fallback may render the same element
    // class when present, but the body never contains the start-reading
    // (start kWh) the legacy paragraph led with.
    const progress = root.querySelector('.plan-history-detail__progress');
    if (progress !== null) {
      expect(progress.textContent).not.toContain('target 65.0 °C');
    }
  });

  it('retires the legacy progress paragraph on succeeded entries (receipt timeline carries the signal)', async () => {
    const root = await mount(buildEntry({
      outcome: 'met',
      finalProgressC: 65,
      metAtMs: DEADLINE_MS - 18 * 60 * 1000,
    }));
    expect(root.querySelector('.plan-history-detail__progress')).toBeNull();
    expect(root.querySelector('.plan-history-detail__overshoot')).toBeNull();
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
      // Outcome headline promoted above the chart card (PR10).
      const outcomeHeadline = root.querySelector('.plan-history-detail__outcome-headline');
      expect(outcomeHeadline).not.toBeNull();
      expect(outcomeHeadline?.textContent).toContain('65.0 °C');
      // No recourse CTA on succeeded.
      expect(root.querySelector('.plan-history-detail__recourse')).toBeNull();
      // No "Why" line on succeeded.
      expect(root.querySelector('.plan-history-detail__missed-reason')).toBeNull();
      // Chart card exists but the comparison chart is collapsed — "View
      // details" toggle visible (renamed in PR10 to avoid the "schedule"
      // vocabulary overload with the deadline-plan page).
      const toggle = root.querySelector('.plan-history-detail__chart-toggle');
      expect(toggle).not.toBeNull();
      expect(toggle?.textContent).toBe('View details');
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
      // Outcome headline on Missed (promoted above chart card in PR10).
      expect(root.querySelector('.plan-history-detail__outcome-headline')?.textContent)
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

    it('Missed-by-shortfall recourse opens device settings for the entry device, not a dead-end tab', async () => {
      const revision = buildRevision({ planStatus: 'cannot_meet' });
      const root = await mount(buildEntry({
        outcome: 'missed',
        deviceId: 'dev_water_heater',
        finalProgressC: 38,
        targetTemperatureC: 65,
        originalPlan: revision,
        finalPlan: revision,
      }));
      const recourseBtn = root.querySelector<HTMLButtonElement>('.plan-history-detail__recourse button');
      // Label is action-oriented and honest about the landing surface — the
      // prior "Move deadline later" copy promised an action the destination
      // didn't offer (owner walk 2026-05-17). "Review device" is honest:
      // the overlay shows shed behaviour, target power, boost, modes, deltas.
      expect(recourseBtn?.textContent).toContain('Review device');
      expect(recourseBtn?.dataset.deadlineRecourseTab).toBe('overview');
      // Producer threads the entry's deviceId through so the dispatcher can
      // open the device-settings overlay in a single click.
      expect(recourseBtn?.dataset.deadlineRecourseDeviceId).toBe('dev_water_heater');
    });

    it('Abandoned shape: tone=muted, quiet — no chart card, no recourse, <details> body for evidence (v2.7.3)', async () => {
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
        deliveredKWh: 0.4,
        originalPlan: buildRevision(),
        finalPlan: buildRevision(),
      }));
      const hero = root.querySelector<HTMLElement>('.plan-history-detail__hero');
      expect(hero?.dataset.tone).toBe('muted');
      expect(root.querySelector('.plan-history-detail__outcome-headline')?.textContent)
        .toMatch(/stopped/);
      // No recourse / Why on Abandoned.
      expect(root.querySelector('.plan-history-detail__recourse')).toBeNull();
      expect(root.querySelector('.plan-history-detail__missed-reason')).toBeNull();
      // v2.7.3: the chart card is suppressed entirely on Abandoned — the
      // hero collapses to eyebrow + sentence + Material <details>.
      expect(root.querySelector('.plan-history-detail__chart-toggle')).toBeNull();
      expect(root.querySelector('.deadline-horizon-chart')).toBeNull();
      // Evidence-on-demand lives inside the disclosure.
      const details = root.querySelector('details.plan-history-detail__abandoned-details');
      expect(details).not.toBeNull();
      expect(details!.textContent).toMatch(/0\.4 kWh delivered before it stopped/);
    });

    it('Succeeded hero has a "View details" toggle that expands the chart on click', async () => {
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
      expect(toggle!.textContent).toBe('Hide details');
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

  // v2.7.2 PR 4 — actual-vs-plan trajectory chart shape. The chart's y-axis
  // moves to the target unit (°C / %), planned hours render as a stepped
  // staircase derived from `kwhPerUnitMean`, observed samples render as a
  // line + points, and the target reference + metAtMs marker land on the
  // chart.
  describe('actual-vs-plan trajectory chart (PR 4)', () => {
    it('renders the trajectory chart and the "Progress history" title for entries with progressSamples', async () => {
      const revision = buildRevision({ kwhPerUnitMean: 0.5 });
      const root = await mount(buildEntry({
        outcome: 'missed', // missed → chart expanded by default
        finalProgressC: 38,
        originalPlan: revision,
        finalPlan: revision,
        progressSamples: [
          { atMs: DEADLINE_MS - 3 * HOUR_MS, valueC: 50, valuePercent: null },
          { atMs: DEADLINE_MS - 2 * HOUR_MS, valueC: 54, valuePercent: null },
          { atMs: DEADLINE_MS - HOUR_MS, valueC: 58, valuePercent: null },
        ],
      }));
      expect(root.textContent).toContain('Progress history');
      expect(root.textContent).not.toContain('Scheduled vs observed');
      expect(root.querySelector('.deadline-horizon-chart')).not.toBeNull();
    });

    it('falls back to the legacy "Scheduled vs observed" card title when neither samples nor rate were captured', async () => {
      const revision = buildRevision({ planStatus: 'cannot_meet' });
      // Strip kwhPerUnitMean so the producer returns mode `legacy_kwh`.
      delete (revision as { kwhPerUnitMean?: number }).kwhPerUnitMean;
      const root = await mount(buildEntry({
        outcome: 'missed',
        finalProgressC: 38,
        originalPlan: revision,
        finalPlan: revision,
        // No progressSamples → legacy mode locked in.
        progressSamples: undefined,
      }));
      expect(root.textContent).toContain('Scheduled vs observed');
      expect(root.textContent).toContain('Schedule only — observations not recorded for this run.');
    });

    it('builds a time-axis trajectory option with planned staircase, observed line, and target reference', async () => {
      const { buildHistoryDetailTrajectoryOption } =
        await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
      const { resolveHistoryDetailChartData } =
        await import('../../shared-domain/src/deferredPlanHistory');
      const revision = buildRevision({
        hours: [
          { startsAtMs: DEADLINE_MS - 2 * HOUR_MS, plannedKWh: 1 },
          { startsAtMs: DEADLINE_MS - HOUR_MS, plannedKWh: 1 },
        ],
        kwhPerUnitMean: 0.5,
      });
      const entry = buildEntry({
        outcome: 'met',
        metAtMs: DEADLINE_MS - HOUR_MS,
        startProgressC: 50,
        finalProgressC: 65,
        targetTemperatureC: 65,
        startedAtMs: DEADLINE_MS - 2 * HOUR_MS,
        originalPlan: revision,
        finalPlan: revision,
        progressSamples: [
          { atMs: DEADLINE_MS - 2 * HOUR_MS, valueC: 50, valuePercent: null },
          { atMs: DEADLINE_MS - HOUR_MS, valueC: 60, valuePercent: null },
        ],
      });
      const chartData = resolveHistoryDetailChartData(entry);
      const option = buildHistoryDetailTrajectoryOption(
        chartData,
        stubPalette,
        'UTC',
        'Measured Heating',
      ) as {
        xAxis: { type: string; min: number; max: number };
        series: Array<{ name: string; type: string; step?: string }>;
        legend: { data: Array<{ name: string }> };
      };
      expect(option.xAxis.type).toBe('time');
      expect(option.xAxis.min).toBe(DEADLINE_MS - 2 * HOUR_MS);
      expect(option.xAxis.max).toBe(DEADLINE_MS);
      const seriesNames = option.series.map((s) => s.name);
      expect(seriesNames).toContain('Planned trajectory');
      expect(seriesNames).toContain('Measured Heating');
      expect(seriesNames).toContain('Target');
      // Planned series must be a stepped line so the horizontal-hour
      // semantic reads correctly.
      const plannedSeries = option.series.find((s) => s.name === 'Planned trajectory');
      expect(plannedSeries?.type).toBe('line');
      expect(plannedSeries?.step).toBe('end');
    });

    it('exposes the metAtMs marker on the planned staircase for met outcomes', async () => {
      const { buildHistoryDetailTrajectoryOption } =
        await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
      const { resolveHistoryDetailChartData } =
        await import('../../shared-domain/src/deferredPlanHistory');
      const revision = buildRevision({ kwhPerUnitMean: 0.5 });
      const entry = buildEntry({
        outcome: 'met',
        metAtMs: DEADLINE_MS - HOUR_MS,
        originalPlan: revision,
        finalPlan: revision,
        progressSamples: [
          { atMs: DEADLINE_MS - 2 * HOUR_MS, valueC: 50, valuePercent: null },
          { atMs: DEADLINE_MS - HOUR_MS, valueC: 65, valuePercent: null },
        ],
      });
      const chartData = resolveHistoryDetailChartData(entry);
      const option = buildHistoryDetailTrajectoryOption(
        chartData,
        stubPalette,
        'UTC',
        'Measured Heating',
      ) as {
        series: Array<{ name: string; markPoint?: { data: Array<{ name: string; coord: number[] }> } }>;
      };
      const plannedSeries = option.series.find((s) => s.name === 'Planned trajectory');
      expect(plannedSeries?.markPoint?.data[0]?.name).toBe('Reached target');
      expect(plannedSeries?.markPoint?.data[0]?.coord[0]).toBe(DEADLINE_MS - HOUR_MS);
      expect(plannedSeries?.markPoint?.data[0]?.coord[1]).toBe(65);
    });

    it('uses % unit formatting for EV SoC entries', async () => {
      const { buildHistoryDetailTrajectoryOption } =
        await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
      const { resolveHistoryDetailChartData } =
        await import('../../shared-domain/src/deferredPlanHistory');
      const entry = buildEntry({
        objectiveKind: 'ev_soc',
        targetTemperatureC: null,
        targetPercent: 80,
        startProgressC: null,
        startProgressPercent: 30,
        finalProgressC: null,
        finalProgressPercent: 80,
        outcome: 'met',
        originalPlan: buildRevision({ kwhPerUnitMean: 0.5 }),
        finalPlan: buildRevision({ kwhPerUnitMean: 0.5 }),
        progressSamples: [
          { atMs: DEADLINE_MS - 2 * HOUR_MS, valueC: null, valuePercent: 30 },
          { atMs: DEADLINE_MS - HOUR_MS, valueC: null, valuePercent: 80 },
        ],
      });
      const chartData = resolveHistoryDetailChartData(entry);
      expect(chartData.unit).toBe('%');
      const option = buildHistoryDetailTrajectoryOption(
        chartData,
        stubPalette,
        'UTC',
        'Measured Charging',
      ) as {
        yAxis: { axisLabel: { formatter: (value: number) => string } };
      };
      expect(option.yAxis.axisLabel.formatter(50)).toBe('50 %');
    });

    it('preserves the legacy bar chart for v3 entries (kWh y-axis)', async () => {
      const { buildHistoryDetailChartOption, buildHistoryDetailRows } =
        await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
      const revision = buildRevision();
      delete (revision as { kwhPerUnitMean?: number }).kwhPerUnitMean;
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
        yAxis: { axisLabel: { formatter: (value: number) => string } };
      };
      // The legacy mode keeps the existing kWh axis so the existing y-axis
      // regression test in `deadline-recorder-to-history.spec.ts` continues
      // to assert against `kWh` labels.
      expect(option.yAxis.axisLabel.formatter(1.2)).toContain('kWh');
    });
  });

  describe('per-hour bar strip (v2.7.3)', () => {
    it('renders one bucket per hour in the deadline window when hourlyContributions is present', async () => {
      const startedAtMs = DEADLINE_MS - 4 * HOUR_MS;
      // Missed outcome so the chart card defaults expanded — the postmortem
      // strip is only worth rendering when the user is actively reading the
      // diagnosis, which matches the chart-expanded contract.
      const entry = buildEntry({
        startedAtMs,
        outcome: 'missed',
        finalProgressC: 60,
        metAtMs: null,
        // originalPlan present so `hasChartData` is true and the chart card
        // (where the strip lives) renders rather than the empty-state card.
        originalPlan: buildRevision({
          hours: [{ startsAtMs: startedAtMs, plannedKWh: 2 }],
        }),
        hourlyContributions: [
          { atMs: startedAtMs, deliveredKWh: 1.5, priceValue: 0.20, tone: 'cheap' },
          { atMs: startedAtMs + HOUR_MS, deliveredKWh: 1.2, priceValue: 0.55, tone: 'normal' },
        ],
      });
      const root = await mount(entry);
      const strip = root.querySelector('.hourly-strip');
      expect(strip).not.toBeNull();
      // 4-hour window → 4 buckets, regardless of how many contributions
      // landed (gap buckets are emitted to keep the time axis intact).
      const buckets = strip!.querySelectorAll('.hourly-strip__bucket');
      expect(buckets.length).toBe(4);
      expect(buckets[0]!.getAttribute('data-tone')).toBe('cheap');
      expect(buckets[1]!.getAttribute('data-tone')).toBe('normal');
      expect(buckets[2]!.getAttribute('data-tone')).toBe('gap');
    });

    it('suppresses the strip on legacy v4 entries without hourlyContributions', async () => {
      const root = await mount(buildEntry({
        originalPlan: null,
        finalPlan: null,
        hourlyContributions: undefined,
      }));
      expect(root.querySelector('.hourly-strip')).toBeNull();
    });

    it('writes a tooltip with time, kWh, price and planned/skipped marker', async () => {
      const startedAtMs = DEADLINE_MS - 2 * HOUR_MS;
      const entry = buildEntry({
        startedAtMs,
        outcome: 'missed',
        finalProgressC: 60,
        metAtMs: null,
        originalPlan: buildRevision({
          hours: [
            { startsAtMs: startedAtMs, plannedKWh: 1.0 },
            { startsAtMs: startedAtMs + HOUR_MS, plannedKWh: 1.0 },
          ],
        }),
        hourlyContributions: [
          { atMs: startedAtMs, deliveredKWh: 0.42, priceValue: 0.18, tone: 'cheap' },
        ],
      });
      const root = await mount(entry, { costUnit: 'kr' });
      const buckets = root.querySelectorAll('.hourly-strip__bucket');
      // Delivered bucket: token-styled tooltip (via `data-tooltip` + CSS
      // `::after`, not native `title`) carries kWh + price (in display
      // unit) + "planned". `aria-label` mirrors the same text so screen
      // readers still announce the data. The native `title` attribute is
      // gone — the browser's OS-themed tooltip clashed with the dark
      // chart-tooltip rendered above the strip.
      expect(buckets[0]!.getAttribute('title')).toBeNull();
      const deliveredTooltip = buckets[0]!.getAttribute('data-tooltip') ?? '';
      expect(deliveredTooltip).toContain('0.42 kWh');
      expect(deliveredTooltip).toContain('0.18 kr');
      expect(deliveredTooltip).toContain('planned');
      expect(buckets[0]!.getAttribute('aria-label')).toBe(deliveredTooltip);
      // Outlined bucket (planned but not delivered): tooltip says "skipped"
      // and suppresses the kWh + price segments so it doesn't contradict
      // itself (the bucket's `kwh` field still carries `plannedKWh` for
      // bar-height context, but that detail stays out of the tooltip).
      const skippedTooltip = buckets[1]!.getAttribute('data-tooltip') ?? '';
      expect(skippedTooltip).toContain('skipped');
      expect(skippedTooltip).not.toContain('kWh');
      expect(buckets[1]!.getAttribute('data-outline')).toBe('true');
    });

    it('renders øre prices as whole integers (minor-unit convention)', async () => {
      const startedAtMs = DEADLINE_MS - HOUR_MS;
      const entry = buildEntry({
        startedAtMs,
        outcome: 'missed',
        finalProgressC: 60,
        metAtMs: null,
        originalPlan: buildRevision({
          hours: [{ startsAtMs: startedAtMs, plannedKWh: 1.0 }],
        }),
        hourlyContributions: [
          { atMs: startedAtMs, deliveredKWh: 0.42, priceValue: 17.6, tone: 'cheap' },
        ],
      });
      const root = await mount(entry, { costUnit: 'øre' });
      const bucket = root.querySelector('.hourly-strip__bucket');
      const tooltip = bucket!.getAttribute('data-tooltip') ?? '';
      // 17.6 øre → "18 øre" (whole-integer, no fractional øre per the
      // PELS money convention).
      expect(tooltip).toContain('18 øre');
      expect(tooltip).not.toContain('17.60');
    });

    it('renders three token-styled legend chips and a screen-reader caption', async () => {
      const startedAtMs = DEADLINE_MS - HOUR_MS;
      const entry = buildEntry({
        startedAtMs,
        outcome: 'missed',
        finalProgressC: 60,
        metAtMs: null,
        originalPlan: buildRevision({
          hours: [{ startsAtMs: startedAtMs, plannedKWh: 1.0 }],
        }),
        hourlyContributions: [
          { atMs: startedAtMs, deliveredKWh: 0.5, priceValue: 0.2, tone: 'cheap' },
        ],
      });
      const root = await mount(entry);
      const legend = root.querySelector('.hourly-strip__legend');
      expect(legend).not.toBeNull();
      // No `aria-hidden` on the legend wrapper any more — the chips carry
      // visible labels, and a visually-hidden caption announces the tier
      // vocabulary to screen readers.
      expect(legend!.getAttribute('aria-hidden')).toBeNull();
      expect(legend!.querySelector('.visually-hidden')).not.toBeNull();
      // Three chips, all reusing the `.plan-chip` primitive.
      const chips = legend!.querySelectorAll('.hourly-strip__legend-item');
      expect(chips.length).toBe(3);
      for (const chip of chips) {
        expect(chip.classList.contains('plan-chip')).toBe(true);
      }
    });
  });
});
