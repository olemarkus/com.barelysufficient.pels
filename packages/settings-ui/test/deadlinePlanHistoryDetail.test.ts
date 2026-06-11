import { h, render } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { describe, expect, it, vi } from 'vitest';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
  ResolvedDeferredObjectivePlanHistoryEntry,
} from '../../contracts/src/deferredObjectivePlanHistory';
import { toResolvedPlanHistoryEntry } from '../../shared-domain/src/deferredPlanHistoryResolvedView.ts';

// Mock the ECharts registry to avoid mounting real ECharts in JSDOM. The
// `useEchartsMount` stub mirrors the production hook's shape — it still runs
// `buildOption(container)` inside an effect so the option-builder code paths
// the view depends on are exercised, and it invokes `onChartInit` with a
// stub chart (the trajectory section's scrub wiring + hairline effect read
// the handle) — but binds to a stub instead of a real instance.
vi.mock('../src/ui/echartsRegistry.ts', () => ({
  encodeHtml: (value: string) => value,
  useEchartsMount: (params: {
    buildOption: (container: HTMLDivElement) => unknown;
    onChartInit?: (chart: unknown, container: HTMLDivElement) => void;
    deps: ReadonlyArray<unknown>;
  }) => {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const container = ref.current;
      if (!container) return;
      const chart = {
        setOption: vi.fn(),
        resize: vi.fn(),
        dispose: vi.fn(),
        isDisposed: () => false,
        dispatchAction: vi.fn(),
        getZr: () => ({ on: vi.fn() }),
        containPixel: () => false,
        convertFromPixel: () => null,
      };
      chart.setOption(params.buildOption(container));
      params.onChartInit?.(chart, container);
    }, params.deps);
    return ref;
  },
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
): ResolvedDeferredObjectivePlanHistoryEntry => toResolvedPlanHistoryEntry({
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
  observedIntervals: [{ fromMs: DEADLINE_MS - 6 * HOUR_MS, toMs: DEADLINE_MS - 3 * HOUR_MS }],
  discoveredFrom: 'observation',
  originalPlan: null,
  finalPlan: null,
  ...overrides,
});

const mount = async (
  entry: ResolvedDeferredObjectivePlanHistoryEntry,
): Promise<HTMLElement> => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const { DeadlinePlanHistoryDetail } = await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
  render(
    h(DeadlinePlanHistoryDetail, { entry, timeZone: 'UTC' }),
    root,
  );
  return root;
};

const stubPalette = {
  device: '#0ff', deviceMuted: '#222', observed: '#0f0',
  // Distinct from `observed` so the met-ring test can prove the marker reads
  // the accent role, not the planner-state observed colour.
  accent: '#abcdef',
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

  // Usage cross-link footer. The asymmetric task→Usage link helps a user
  // investigating a missed run see the device's whole-day power profile;
  // reverse direction (Usage→task) is intentionally not added. The Usage view
  // today is household-scoped (no per-device filtering), so the copy says
  // "household usage"; the click handler in `deadlinePlanMount.ts` arms a
  // return link instead of relying on Usage to honour the `deviceId` / `date`
  // URL params.
  it('renders the Usage cross-link below the hero with the correct href and copy', async () => {
    const root = await mount(buildEntry({ deviceId: 'dev_water_heater' }));
    const hero = root.querySelector('.plan-history-detail__hero');
    expect(hero).not.toBeNull();
    const link = hero!.querySelector<HTMLAnchorElement>('.plan-history-detail__usage-link-anchor');
    expect(link).not.toBeNull();
    // Copy comes from the shared-domain helper so runtime logs and the UI
    // share the same wording (no UI-only inline strings).
    expect(link!.textContent).toBe('See household usage on 6 May →');
    // Href encodes `page=usage`, the deviceId, and the deadline date ISO so a
    // future Usage view that honours filter params can read them off the URL.
    expect(link!.getAttribute('href')).toBe(
      './?page=usage&deviceId=dev_water_heater&date=2026-05-06T06%3A00%3A00.000Z',
    );
    // The deviceId data-attribute is what the SPA click handler reads to arm
    // the return-link state; the anchor stays a real `<a>` so middle-click /
    // open-in-new-tab keep working when Usage gains filter routing.
    expect(link!.dataset.deadlineUsageLink).toBe('dev_water_heater');
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
      // Made real progress toward the 65 °C target (start 50 → 55) so the run
      // doesn't classify as `no_delivery`, and no delivery was recorded so the
      // delivery split is inconclusive — leaving the cannot_meet fallback copy.
      finalProgressC: 55,
      originalPlan: finalCannotMeet,
      finalPlan: finalCannotMeet,
    }));
    const reason = root.querySelector('.plan-history-detail__missed-reason');
    expect(reason).not.toBeNull();
    // v2.7.3 — blameless rewrite. The cannot_meet branch reads "Couldn't
    // reserve enough cheap hours in time." with no recourse copy (the recourse
    // button carries that signal).
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
    // No overshoot line for an exactly-on-target run — the producer's threshold
    // check (> 5 °C / > 10 %) keeps the line quiet on the common path. See the
    // dedicated overshoot describe block below for the threshold-crossing case.
    expect(root.querySelector('.plan-history-detail__overshoot')).toBeNull();
  });

  // v2.9.x batch 47 — muted Overshoot line surfaces on Succeeded entries whose
  // final reading exceeded the target by > 5 °C / > 10 % (lived-state Connected
  // 300 regression: `29.3 → 77.7 °C · target 65 °C`, 12.7 °C overshoot — flagged
  // in `TODO.md` ~L2724 as a passive support-cost surface). Producer-resolved
  // by `formatPlanHistoryOvershootLine`; the view only renders the string.
  describe('overshoot line on Succeeded entries (TODO ~L2724)', () => {
    it('renders the muted overshoot line when a Succeeded thermal run overshoots > 5 °C', async () => {
      const root = await mount(buildEntry({
        outcome: 'met',
        startProgressC: 29.3,
        finalProgressC: 77.7,
        targetTemperatureC: 65,
        metAtMs: DEADLINE_MS - HOUR_MS,
      }));
      const overshoot = root.querySelector('.plan-history-detail__overshoot');
      expect(overshoot).not.toBeNull();
      // Canonical lived-state regression value — see `notes/smart-task-ui/README.md`.
      expect(overshoot?.textContent).toBe('Overshoot 12.7 °C');
    });

    it('renders the muted overshoot line when a Succeeded EV run overshoots > 10 %', async () => {
      const root = await mount(buildEntry({
        outcome: 'met',
        objectiveKind: 'ev_soc',
        targetTemperatureC: null,
        targetPercent: 80,
        startProgressC: null,
        startProgressPercent: 30,
        finalProgressC: null,
        finalProgressPercent: 95,
        metAtMs: DEADLINE_MS - HOUR_MS,
      }));
      const overshoot = root.querySelector('.plan-history-detail__overshoot');
      expect(overshoot?.textContent).toBe('Overshoot 15 %');
    });

    it('keeps the overshoot line quiet on Missed entries even when readings exceed the target', async () => {
      // A Missed outcome whose `finalProgressC` happens to exceed the target
      // is a malformed-data shape, not a real overshoot — surfacing it would
      // noise up the diagnosis surface. Producer returns null; the view never
      // sees the element.
      const root = await mount(buildEntry({
        outcome: 'missed',
        finalProgressC: 80,
        targetTemperatureC: 65,
        metAtMs: null,
      }));
      expect(root.querySelector('.plan-history-detail__overshoot')).toBeNull();
    });
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

    // v2.9.x — copilot reviewer follow-up on PR #887. Discriminator for the
    // `unknown` outcome is plan presence, not outcome value: an `unknown`
    // run that recorded a plan flips out of the quiet shape so the chart
    // renders as evidence (collapsed by default, same as Succeeded). An
    // `unknown` run with no plan stays quiet — nothing to draw.
    it('Unknown shape with recorded plan: tone=muted, chart card renders collapsed with "View details" toggle (v2.9.x)', async () => {
      const root = await mount(buildEntry({
        outcome: 'unknown',
        // Unknown outcomes have no final progress recorded — that's what
        // produced the classification (see `classifyOutcome` in
        // `lib/objectives/deferredObjectives/planHistory.ts`).
        finalProgressC: null,
        finalProgressPercent: null,
        originalPlan: buildRevision(),
        finalPlan: buildRevision(),
      }));
      const hero = root.querySelector<HTMLElement>('.plan-history-detail__hero');
      expect(hero?.dataset.tone).toBe('muted');
      // No recourse / Why on Unknown — those belong to Missed.
      expect(root.querySelector('.plan-history-detail__recourse')).toBeNull();
      expect(root.querySelector('.plan-history-detail__missed-reason')).toBeNull();
      // Chart card IS rendered (the plan provides evidence), and the toggle
      // is present because `chartCollapsedByDefault: true`. The chart body
      // itself starts collapsed.
      const toggle = root.querySelector<HTMLButtonElement>('.plan-history-detail__chart-toggle');
      expect(toggle).not.toBeNull();
      expect(toggle!.textContent).toBe('View details');
      expect(root.querySelector('.deadline-horizon-chart')).toBeNull();
    });

    it('Unknown shape with no recorded plan: stays quiet — no chart card, no toggle (v2.9.x)', async () => {
      const root = await mount(buildEntry({
        outcome: 'unknown',
        finalProgressC: null,
        finalProgressPercent: null,
        originalPlan: null,
        finalPlan: null,
      }));
      const hero = root.querySelector<HTMLElement>('.plan-history-detail__hero');
      expect(hero?.dataset.tone).toBe('muted');
      // v2.9.x quiet branch: no plan, no chart card — same shape as Abandoned.
      expect(root.querySelector('.plan-history-detail__chart-toggle')).toBeNull();
      expect(root.querySelector('.deadline-horizon-chart')).toBeNull();
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

  // Receipt-first trajectory card (chart-overhaul Phase 1B). The y-axis is
  // unit space (°C / %) with floor/mid ticks only, the card title is the
  // kind-aware question, the ECharts legend/tooltip are retired in favour of
  // a compact DOM legend + the pinned readout, and revised runs show only
  // the final staircase by default with a "Plan changed HH:MM" marker + a
  // "Compare with initial plan" toggle.
  describe('actual-vs-plan trajectory card (Phase 1B)', () => {
    const trajectoryRevision = (
      overrides: Partial<DeferredObjectivePlanHistoryRevisionSnapshot> = {},
    ) => buildRevision({
      kwhPerUnitMean: 0.5,
      ...overrides,
    });
    const trajectorySamples = [
      { atMs: DEADLINE_MS - 3 * HOUR_MS, valueC: 50, valuePercent: null },
      { atMs: DEADLINE_MS - 2 * HOUR_MS, valueC: 54, valuePercent: null },
      { atMs: DEADLINE_MS - HOUR_MS, valueC: 58, valuePercent: null },
    ];
    const buildOptionParams = async (
      entry: ResolvedDeferredObjectivePlanHistoryEntry,
      showInitialPlan = false,
    ) => {
      const { resolveHistoryDetailChartData } = await import('../../shared-domain/src/deferredPlanHistory');
      const { resolveHistoryPlanChangeMarker, resolveHistoryRunBands } =
        await import('../../shared-domain/src/deferredPlanHistoryDetailInteraction');
      const data = resolveHistoryDetailChartData(entry);
      return {
        data,
        marker: resolveHistoryPlanChangeMarker(entry, data, 'UTC'),
        runBands: resolveHistoryRunBands(entry, data),
        showInitialPlan,
        palette: stubPalette,
        timeZone: 'UTC',
        chartWidth: 480,
      };
    };

    it('renders the kind-aware question title for trajectory entries', async () => {
      const revision = trajectoryRevision();
      const root = await mount(buildEntry({
        outcome: 'missed', // missed → chart expanded by default
        finalProgressC: 38,
        originalPlan: revision,
        finalPlan: revision,
        progressSamples: trajectorySamples,
      }));
      expect(root.textContent).toContain('Did it heat up as planned?');
      expect(root.textContent).not.toContain('Progress history');
      expect(root.textContent).not.toContain('Scheduled vs observed');
      expect(root.querySelector('.deadline-history-trajectory-chart')).not.toBeNull();
    });

    it('renders the compact DOM legend row: Measured / Planned / Target {value}', async () => {
      const revision = trajectoryRevision();
      const root = await mount(buildEntry({
        outcome: 'missed',
        finalProgressC: 38,
        targetTemperatureC: 65,
        originalPlan: revision,
        finalPlan: revision,
        progressSamples: trajectorySamples,
      }));
      const legend = root.querySelector('.deadline-history-legend');
      expect(legend).not.toBeNull();
      const items = [...legend!.querySelectorAll('.deadline-history-legend__item')]
        .map((item) => item.textContent?.trim());
      expect(items).toEqual(['Measured', 'Planned', 'Target 65.0 °C']);
    });

    it('renders the pinned readout row with the per-hour Measured · Planned line', async () => {
      const revision = trajectoryRevision();
      const root = await mount(buildEntry({
        outcome: 'missed',
        finalProgressC: 38,
        originalPlan: revision,
        finalPlan: revision,
        progressSamples: trajectorySamples,
      }));
      const readout = root.querySelector('.deadline-readout');
      expect(readout).not.toBeNull();
      expect(readout!.querySelector('.deadline-readout__primary')?.textContent)
        .toMatch(/^\d{2}:\d{2} · Measured /);
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
      // Legacy fallback path stays exactly as before Phase 1B: no DOM
      // legend, no readout, no compare toggle.
      expect(root.querySelector('.deadline-history-legend')).toBeNull();
      expect(root.querySelector('.deadline-readout')).toBeNull();
      expect(root.querySelector('.plan-history-detail__compare-row')).toBeNull();
    });

    it('builds a time-axis option with the planned staircase, measured line, and target — no legend, no tooltip', async () => {
      const { buildHistoryDetailTrajectoryOption } =
        await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
      const revision = trajectoryRevision({
        hours: [
          { startsAtMs: DEADLINE_MS - 2 * HOUR_MS, plannedKWh: 1 },
          { startsAtMs: DEADLINE_MS - HOUR_MS, plannedKWh: 1 },
        ],
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
      const option = buildHistoryDetailTrajectoryOption(await buildOptionParams(entry)) as {
        xAxis: { type: string; min: number; max: number };
        legend?: unknown;
        tooltip?: unknown;
        series: Array<{ name?: string; type: string; step?: string }>;
      };
      expect(option.xAxis.type).toBe('time');
      expect(option.xAxis.min).toBe(DEADLINE_MS - 2 * HOUR_MS);
      expect(option.xAxis.max).toBe(DEADLINE_MS);
      // No ECharts legend / floating tooltip — DOM legend + pinned readout
      // are the one interaction grammar.
      expect(option.legend).toBeUndefined();
      expect(option.tooltip).toBeUndefined();
      const seriesNames = option.series.map((s) => s.name);
      expect(seriesNames).toContain('Planned trajectory');
      expect(seriesNames).toContain('Measured');
      expect(seriesNames).toContain('Target');
      // Planned series must be a stepped line so the horizontal-hour
      // semantic reads correctly.
      const plannedSeries = option.series.find((s) => s.name === 'Planned trajectory');
      expect(plannedSeries?.type).toBe('line');
      expect(plannedSeries?.step).toBe('end');
    });

    it('shows only the final staircase by default on revised runs; the toggle reveals the dashed original', async () => {
      const { buildHistoryDetailTrajectoryOption } =
        await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
      const original = trajectoryRevision();
      const revised = trajectoryRevision({
        hours: [
          { startsAtMs: DEADLINE_MS - 2 * HOUR_MS, plannedKWh: 1 },
          { startsAtMs: DEADLINE_MS - HOUR_MS, plannedKWh: 1.5 },
        ],
      });
      const entry = buildEntry({
        outcome: 'met',
        metAtMs: DEADLINE_MS - HOUR_MS,
        startedAtMs: DEADLINE_MS - 4 * HOUR_MS,
        originalPlan: original,
        finalPlan: revised,
        revisions: [
          { atMs: DEADLINE_MS - 3 * HOUR_MS, reasonId: 'prices_revised', hoursAdded: 1, hoursRemoved: 1 },
        ],
        progressSamples: [
          { atMs: DEADLINE_MS - 4 * HOUR_MS, valueC: 50, valuePercent: null },
          { atMs: DEADLINE_MS - HOUR_MS, valueC: 65, valuePercent: null },
        ],
      });
      const collapsed = buildHistoryDetailTrajectoryOption(await buildOptionParams(entry)) as {
        series: Array<{ name?: string; lineStyle?: { type?: string }; markLine?: { data: Array<{ xAxis: number }>; label: { formatter: string } } }>;
      };
      expect(collapsed.series.map((s) => s.name)).not.toContain('Initial plan');
      // The plan-change marker pins the replan instant with the producer label.
      const planned = collapsed.series.find((s) => s.name === 'Planned trajectory');
      expect(planned?.markLine?.data[0]?.xAxis).toBe(DEADLINE_MS - 3 * HOUR_MS);
      expect(planned?.markLine?.label.formatter).toMatch(/^Plan changed \d{2}:\d{2}$/);
      const compared = buildHistoryDetailTrajectoryOption(await buildOptionParams(entry, true)) as {
        series: Array<{ name?: string; lineStyle?: { type?: string } }>;
      };
      const initial = compared.series.find((s) => s.name === 'Initial plan');
      expect(initial).toBeDefined();
      expect(initial?.lineStyle?.type).toBe('dashed');
    });

    it('renders the met marker as an accent ring sitting on the measured line', async () => {
      const { buildHistoryDetailTrajectoryOption } =
        await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
      const revision = trajectoryRevision();
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
      const option = buildHistoryDetailTrajectoryOption(await buildOptionParams(entry)) as {
        series: Array<{
          name?: string;
          type?: string;
          data?: Array<[number, number]>;
          itemStyle?: { color?: string; borderColor?: string };
        }>;
      };
      const ring = option.series.find((s) => s.name === 'Reached target');
      expect(ring?.type).toBe('scatter');
      expect(ring?.data?.[0]).toEqual([DEADLINE_MS - HOUR_MS, 65]);
      // Transparent fill + accent stroke = a ring punched out of the line.
      expect(ring?.itemStyle?.color).toBe('transparent');
      expect(ring?.itemStyle?.borderColor).toBe('#abcdef');
    });

    it('labels only the floor and mid y-ticks — the target is never an axis tick', async () => {
      const { buildHistoryDetailTrajectoryOption } =
        await import('../src/ui/views/DeadlinePlanHistoryDetail.tsx');
      const revision = trajectoryRevision();
      const entry = buildEntry({
        outcome: 'met',
        metAtMs: DEADLINE_MS - HOUR_MS,
        targetTemperatureC: 65,
        originalPlan: revision,
        finalPlan: revision,
        progressSamples: [
          { atMs: DEADLINE_MS - 2 * HOUR_MS, valueC: 50, valuePercent: null },
          { atMs: DEADLINE_MS - HOUR_MS, valueC: 65, valuePercent: null },
        ],
      });
      const option = buildHistoryDetailTrajectoryOption(await buildOptionParams(entry)) as {
        grid: { top: number; containLabel: boolean };
        yAxis: { min: number; max: number; interval: number; axisLabel: { formatter: (value: number) => string } };
      };
      const { min, max, interval, axisLabel } = option.yAxis;
      expect(interval).toBeCloseTo((max - min) / 2);
      const mid = (min + max) / 2;
      expect(axisLabel.formatter(min)).not.toBe('');
      expect(axisLabel.formatter(mid)).not.toBe('');
      // The ceiling tick (which would sit nearest the target line) stays
      // unlabeled — the legend's "Target 65.0 °C" carries the value.
      expect(axisLabel.formatter(max)).toBe('');
      // `containLabel: true` is the load-bearing pattern from PR 1 that
      // gives ECharts room to auto-fit the y-axis labels; keep it pinned.
      expect(option.grid.containLabel).toBe(true);
      // 28 px top reserve holds the "Plan changed HH:MM" marker label.
      expect(option.grid.top).toBe(28);
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
        originalPlan: trajectoryRevision(),
        finalPlan: trajectoryRevision(),
        progressSamples: [
          { atMs: DEADLINE_MS - 2 * HOUR_MS, valueC: null, valuePercent: 30 },
          { atMs: DEADLINE_MS - HOUR_MS, valueC: null, valuePercent: 80 },
        ],
      });
      const chartData = resolveHistoryDetailChartData(entry);
      expect(chartData.unit).toBe('%');
      const option = buildHistoryDetailTrajectoryOption(await buildOptionParams(entry)) as {
        yAxis: { min: number; axisLabel: { formatter: (value: number) => string } };
      };
      // Delegated to the shared formatProgressValueForUnit — "25%", no space.
      expect(option.yAxis.axisLabel.formatter(option.yAxis.min)).toMatch(/^\d+%$/);
    });

    it('mounts the compare toggle only on revised runs', async () => {
      const original = trajectoryRevision();
      const revised = trajectoryRevision({
        hours: [
          { startsAtMs: DEADLINE_MS - 2 * HOUR_MS, plannedKWh: 1 },
          { startsAtMs: DEADLINE_MS - HOUR_MS, plannedKWh: 1.5 },
        ],
      });
      const revisedRoot = await mount(buildEntry({
        outcome: 'missed',
        finalProgressC: 58,
        originalPlan: original,
        finalPlan: revised,
        progressSamples: trajectorySamples,
      }));
      const toggleRow = revisedRoot.querySelector('.plan-history-detail__compare-row');
      expect(toggleRow).not.toBeNull();
      expect(toggleRow!.textContent).toContain('Compare with initial plan');
      expect(toggleRow!.querySelector('md-switch')).not.toBeNull();
      const unrevisedRoot = await mount(buildEntry({
        outcome: 'missed',
        finalProgressC: 58,
        originalPlan: original,
        finalPlan: original,
        progressSamples: trajectorySamples,
      }));
      expect(unrevisedRoot.querySelector('.plan-history-detail__compare-row')).toBeNull();
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

    // Legacy grid pinning — keeps the untouched v3 chart's legend headroom
    // from silently regressing while the trajectory chart now manages its
    // own (legend-free) 28 px reserve.
    it('reserves 60 px grid.top on the legacy bar chart for legend-wrap headroom', async () => {
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
        true,
        true,
        'Measured Heating',
      ) as { grid: { top: number; containLabel: boolean } };
      expect(option.grid.top).toBe(60);
      expect(option.grid.containLabel).toBe(true);
    });
  });

  describe('per-hour bar strip (Phase 1B pinned readout)', () => {
    const stripEntry = (overrides: Partial<DeferredObjectivePlanHistoryEntry> = {}) => {
      const startedAtMs = DEADLINE_MS - 4 * HOUR_MS;
      // Missed outcome so the chart card defaults expanded — the postmortem
      // strip is only worth rendering when the user is actively reading the
      // diagnosis, which matches the chart-expanded contract.
      return buildEntry({
        startedAtMs,
        outcome: 'missed',
        finalProgressC: 60,
        metAtMs: null,
        // originalPlan present so `hasChartData` is true and the chart card
        // (where the strip lives) renders rather than the empty-state card.
        originalPlan: buildRevision({
          hours: [
            { startsAtMs: startedAtMs, plannedKWh: 2 },
            { startsAtMs: startedAtMs + 2 * HOUR_MS, plannedKWh: 1 },
          ],
        }),
        // Raw øre prices; the readout scales by the recorded divisor.
        hourlyContributions: [
          { atMs: startedAtMs, deliveredKWh: 1.5, priceValue: 20, tone: 'cheap' },
          { atMs: startedAtMs + HOUR_MS, deliveredKWh: 1.2, priceValue: 55, tone: 'normal' },
        ],
        costDisplay: { unit: 'kr', divisor: 100 },
        ...overrides,
      });
    };

    it('renders the question title, one bucket per hour, and no floating tooltips', async () => {
      const root = await mount(stripEntry());
      expect(root.textContent).toContain('When did each hour run, and what did it cost?');
      const strip = root.querySelector('.hourly-strip');
      expect(strip).not.toBeNull();
      // 4-hour window → 4 buckets, regardless of how many contributions
      // landed (gap buckets are emitted to keep the time axis intact).
      const buckets = strip!.querySelectorAll('.hourly-strip__bucket');
      expect(buckets.length).toBe(4);
      expect(buckets[0]!.getAttribute('data-tone')).toBe('cheap');
      expect(buckets[1]!.getAttribute('data-tone')).toBe('normal');
      expect(buckets[2]!.getAttribute('data-tone')).toBe('gap');
      // The CSS-tooltip hook is retired — the pinned readout is the one
      // interaction grammar; aria-labels stay for non-visual access.
      for (const bucket of buckets) {
        expect(bucket.getAttribute('data-tooltip')).toBeNull();
        expect(bucket.getAttribute('aria-label')).toBeTruthy();
      }
    });

    it('suppresses the strip on legacy v4 entries without hourlyContributions', async () => {
      const root = await mount(buildEntry({
        originalPlan: null,
        finalPlan: null,
        hourlyContributions: undefined,
      }));
      expect(root.querySelector('.hourly-strip')).toBeNull();
    });

    it('defaults the readout to the tallest delivered bar and pays the cost promise', async () => {
      const root = await mount(stripEntry());
      // Default selection = tallest delivered bar (1.5 kWh at index 0).
      const buckets = root.querySelectorAll('.hourly-strip__bucket');
      expect(buckets[0]!.getAttribute('data-selected')).toBe('true');
      // Strip readout is the LAST `.deadline-readout` in the card (the
      // trajectory's own readout renders above the strip when trajectory
      // mode is active; this fixture is legacy mode so it is the only one).
      const readouts = root.querySelectorAll('.deadline-readout');
      const stripReadout = readouts[readouts.length - 1]!;
      // 20 raw øre at divisor 100 → 0.20 kr/kWh; × 1.5 kWh ≈ 0.30 kr.
      expect(stripReadout.querySelector('.deadline-readout__primary')?.textContent)
        .toBe('02:00 · 1.5 kWh · 0.20 kr/kWh ≈ 0.30 kr');
      expect(stripReadout.querySelector('.deadline-readout__secondary')?.textContent)
        .toBe('Ran as planned');
    });

    it('moves the readout + selection outline on tap and explains skipped hours', async () => {
      const root = await mount(stripEntry());
      const buckets = root.querySelectorAll<HTMLElement>('.hourly-strip__bucket');
      // Index 2 (04:00) was planned but never delivered → outline bucket.
      expect(buckets[2]!.getAttribute('data-outline')).toBe('true');
      buckets[2]!.click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const bucketsAfter = root.querySelectorAll<HTMLElement>('.hourly-strip__bucket');
      expect(bucketsAfter[2]!.getAttribute('data-selected')).toBe('true');
      expect(bucketsAfter[0]!.getAttribute('data-selected')).toBe('false');
      const readouts = root.querySelectorAll('.deadline-readout');
      const stripReadout = readouts[readouts.length - 1]!;
      expect(stripReadout.querySelector('.deadline-readout__primary')?.textContent)
        .toBe('04:00 · 1.0 kWh planned');
      // No replan recorded → the neutral skip line, never a guessed reason.
      expect(stripReadout.querySelector('.deadline-readout__secondary')?.textContent)
        .toBe('Planned, didn’t run');
    });

    it('renders the price-level legend chips plus the dashed skipped sample', async () => {
      const root = await mount(stripEntry());
      const legend = root.querySelector('.hourly-strip__legend');
      expect(legend).not.toBeNull();
      expect(legend!.querySelector('.visually-hidden')).not.toBeNull();
      const chips = legend!.querySelectorAll('.hourly-strip__legend-item');
      expect(chips.length).toBe(4);
      const labels = [...chips].map((chip) => chip.textContent?.trim());
      // One phrasing + casing with the readout's skipped verdict.
      expect(labels).toEqual(['Price low', 'Price normal', 'Price high', 'Planned, didn’t run']);
      for (const chip of chips) {
        expect(chip.classList.contains('plan-chip')).toBe(true);
      }
      expect(legend!.querySelector('.hourly-strip__legend-bar[data-tone="skipped"]')).not.toBeNull();
    });

    it('"View details" collapses and expands the trajectory chart AND the strip together', async () => {
      // Succeeded outcome → receipt shape, chart card collapsed by default.
      const revision = buildRevision({
        kwhPerUnitMean: 0.5,
        hours: [{ startsAtMs: DEADLINE_MS - 2 * HOUR_MS, plannedKWh: 2 }],
      });
      const root = await mount(buildEntry({
        outcome: 'met',
        metAtMs: DEADLINE_MS - HOUR_MS,
        originalPlan: revision,
        finalPlan: revision,
        progressSamples: [
          { atMs: DEADLINE_MS - 3 * HOUR_MS, valueC: 50, valuePercent: null },
          { atMs: DEADLINE_MS - HOUR_MS, valueC: 65, valuePercent: null },
        ],
        hourlyContributions: [
          { atMs: DEADLINE_MS - 2 * HOUR_MS, deliveredKWh: 1.8, priceValue: 30, tone: 'cheap' },
        ],
        costDisplay: { unit: 'kr', divisor: 100 },
      }));
      // Collapsed: neither the chart nor the strip renders.
      expect(root.querySelector('.deadline-history-trajectory-chart')).toBeNull();
      expect(root.querySelector('.hourly-strip')).toBeNull();
      const toggle = root.querySelector<HTMLButtonElement>('.plan-history-detail__chart-toggle');
      toggle!.click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(root.querySelector('.deadline-history-trajectory-chart')).not.toBeNull();
      expect(root.querySelector('.hourly-strip')).not.toBeNull();
    });
  });

  // Post-finalization "What changed" card on the history-detail page. The
  // RevisionsCard renders when a v4 entry carries one or more `revisions`
  // entries and the chart is expanded; it shares `.plan-revision-row`
  // markup with the live-task panel per `pels-m3-critic`'s contract.
  describe('What changed (RevisionsCard)', () => {
    it('renders an "After this task ran" eyebrow that distinguishes the post-finalization surface from the live-task panel', async () => {
      // Missed outcome forces `chartCollapsedByDefault: false`, so the
      // RevisionsCard renders without the user clicking the chart toggle.
      const revisionFixture = buildRevision({ planStatus: 'cannot_meet' });
      const root = await mount(buildEntry({
        outcome: 'missed',
        finalProgressC: 38,
        originalPlan: revisionFixture,
        finalPlan: revisionFixture,
        revisions: [
          { atMs: DEADLINE_MS - 2 * HOUR_MS, reasonId: 'prices_revised', hoursAdded: 1, hoursRemoved: 0 },
        ],
      }));
      const card = root.querySelector('.plan-history-detail__revisions-card');
      expect(card).not.toBeNull();
      const eyebrow = card!.querySelector('.eyebrow');
      expect(eyebrow?.textContent).toBe('After this task ran');
      // Heading stays the same — the eyebrow adds context, it doesn't
      // replace the title.
      expect(card!.querySelector('.plan-card__title')?.textContent).toBe('What changed');
    });

    it('renders the longer "Plan refreshed (details unavailable)" reason copy and suppresses the diff chip on fallback rows', async () => {
      // Same shape as the live-panel fallback test: when the recorder ships
      // a reason code the resolver hasn't learned about, the row template
      // swaps in the longer copy so the absent `+/−Nh` chip is
      // self-explained.
      const revisionFixture = buildRevision({ planStatus: 'cannot_meet' });
      const root = await mount(buildEntry({
        outcome: 'missed',
        finalProgressC: 38,
        originalPlan: revisionFixture,
        finalPlan: revisionFixture,
        revisions: [
          { atMs: DEADLINE_MS - 2 * HOUR_MS, reasonId: 'some_future_reason', hoursAdded: 1, hoursRemoved: 0 },
        ],
      }));
      const rows = Array.from(root.querySelectorAll<HTMLElement>('.plan-revision-row'));
      expect(rows.length).toBe(1);
      expect(rows[0].querySelector('.plan-revision-reason')?.textContent).toBe(
        'Plan refreshed (details unavailable)',
      );
      // Diff chip suppressed on fallback rows, matching the live-panel
      // behaviour — vague reason + concrete diff would mis-attribute.
      expect(rows[0].querySelector('.plan-revision-diff')).toBeNull();
    });

    it('keeps the producer-resolved short label on known reason codes', async () => {
      const revisionFixture = buildRevision({ planStatus: 'cannot_meet' });
      const root = await mount(buildEntry({
        outcome: 'missed',
        finalProgressC: 38,
        originalPlan: revisionFixture,
        finalPlan: revisionFixture,
        revisions: [
          { atMs: DEADLINE_MS - 2 * HOUR_MS, reasonId: 'prices_revised', hoursAdded: 1, hoursRemoved: 0 },
        ],
      }));
      const row = root.querySelector<HTMLElement>('.plan-revision-row');
      expect(row?.querySelector('.plan-revision-reason')?.textContent).toBe(
        'Tomorrow’s prices published',
      );
      // Known-reason rows keep their diff chip.
      expect(row?.querySelector('.plan-revision-diff')?.textContent).toBe('+1h');
    });
  });
});
