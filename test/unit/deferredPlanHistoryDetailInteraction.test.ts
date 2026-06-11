// Unit tests for the history-detail interaction producers (chart-overhaul
// Phase 1B): the "Plan changed" marker, per-hour pinned-readout rows for the
// trajectory chart and the hourly strip, skip-reason attribution, and run
// bands. Each test pins one branch so the view layer can stay a flat mapper.
import {
  resolveHistoryPlanChangeMarker,
  resolveHistoryRunBands,
  resolveHistoryStripReadout,
  resolveHistoryTrajectoryReadout,
  HISTORY_STRIP_PLANNED_NOT_RUN,
  HISTORY_STRIP_RAN_AS_PLANNED,
} from '../../packages/shared-domain/src/deferredPlanHistoryDetailInteraction';
import {
  resolveHistoryDetailChartData,
} from '../../packages/shared-domain/src/deferredPlanHistoryChartData';
import {
  resolveHistoryDetailHourlyStrip,
} from '../../packages/shared-domain/src/deferredPlanHistoryHourlyStrip';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
  ResolvedDeferredObjectivePlanHistoryEntry,
} from '../../packages/contracts/src/deferredObjectivePlanHistory';
import { toResolvedPlanHistoryEntry } from '../../packages/shared-domain/src/deferredPlanHistoryResolvedView';

const HOUR_MS = 60 * 60 * 1000;
// 2026-05-15: start 19:00 UTC, deadline 01:00 UTC next day (the mock's window).
const START_MS = Date.UTC(2026, 4, 15, 19, 0, 0);
const DEADLINE_MS = START_MS + 6 * HOUR_MS;

const buildSnapshot = (
  overrides: Partial<DeferredObjectivePlanHistoryRevisionSnapshot> = {},
): DeferredObjectivePlanHistoryRevisionSnapshot => ({
  hours: [
    { startsAtMs: START_MS, plannedKWh: 1.0 },
    { startsAtMs: START_MS + HOUR_MS, plannedKWh: 0.8 },
    { startsAtMs: START_MS + 3 * HOUR_MS, plannedKWh: 0.6 },
  ],
  energyNeededKWh: 2.4,
  planStatus: 'on_track',
  revisedAtMs: START_MS,
  kwhPerUnitMean: 0.4,
  ...overrides,
});

const buildEntry = (
  overrides: Partial<DeferredObjectivePlanHistoryEntry> = {},
): ResolvedDeferredObjectivePlanHistoryEntry => toResolvedPlanHistoryEntry({
  id: 'entry-1',
  deviceId: 'dev-1',
  deviceName: 'Connected 300',
  objectiveKind: 'temperature',
  targetTemperatureC: 65,
  targetPercent: null,
  deadlineAtMs: DEADLINE_MS,
  startedAtMs: START_MS,
  finalizedAtMs: DEADLINE_MS,
  startProgressC: 50,
  startProgressPercent: null,
  finalProgressC: 65,
  finalProgressPercent: null,
  initialEnergyNeededKWh: 6,
  outcome: 'met',
  metAtMs: DEADLINE_MS - HOUR_MS,
  usedDeadlineReserve: false,
  observedIntervals: [],
  discoveredFrom: 'observation',
  originalPlan: buildSnapshot(),
  finalPlan: null,
  progressSamples: [
    { atMs: START_MS, valueC: 50, valuePercent: null },
    { atMs: START_MS + 2 * HOUR_MS, valueC: 56.1, valuePercent: null },
    { atMs: DEADLINE_MS - HOUR_MS, valueC: 65, valuePercent: null },
  ],
  ...overrides,
});

// A genuinely different final plan (later, heavier hours) so the chart-data
// producer's replan detection fires and `plannedFinal` populates.
const revisedEntry = (
  overrides: Partial<DeferredObjectivePlanHistoryEntry> = {},
): ResolvedDeferredObjectivePlanHistoryEntry => buildEntry({
  finalPlan: buildSnapshot({
    hours: [
      { startsAtMs: START_MS + 2 * HOUR_MS, plannedKWh: 1.2 },
      { startsAtMs: START_MS + 3 * HOUR_MS, plannedKWh: 1.0 },
      { startsAtMs: START_MS + 4 * HOUR_MS, plannedKWh: 0.9 },
    ],
    revisedAtMs: START_MS + 2 * HOUR_MS,
  }),
  revisions: [
    { atMs: START_MS + 2 * HOUR_MS, reasonId: 'prices_revised', hoursAdded: 3, hoursRemoved: 3 },
  ],
  revisionCount: 2,
  ...overrides,
});

describe('resolveHistoryPlanChangeMarker', () => {
  it('resolves the marker from the first post-start revision with the canonical reason sentence', () => {
    const entry = revisedEntry();
    const chartData = resolveHistoryDetailChartData(entry);
    expect(chartData.plannedFinal).not.toBeNull();
    const marker = resolveHistoryPlanChangeMarker(entry, chartData, 'UTC');
    expect(marker).not.toBeNull();
    expect(marker!.atMs).toBe(START_MS + 2 * HOUR_MS);
    expect(marker!.label).toBe('Plan changed 21:00');
    // Composed from the existing revision-log label vocabulary (lowercased
    // mid-sentence) + the canonical hour-diff chip text — no new vocabulary.
    expect(marker!.readoutLine).toBe('Plan changed here — tomorrow’s prices published (+3h −3h)');
  });

  it('returns null for legacy_kwh entries (v3 fallback path untouched)', () => {
    const entry = revisedEntry({
      progressSamples: undefined,
      originalPlan: buildSnapshot({ kwhPerUnitMean: undefined }),
      finalPlan: buildSnapshot({ kwhPerUnitMean: undefined }),
    });
    const chartData = resolveHistoryDetailChartData(entry);
    expect(chartData.mode).toBe('legacy_kwh');
    expect(resolveHistoryPlanChangeMarker(entry, chartData, 'UTC')).toBeNull();
  });

  it('returns null when the run never replanned', () => {
    const entry = buildEntry();
    const chartData = resolveHistoryDetailChartData(entry);
    expect(chartData.plannedFinal).toBeNull();
    expect(resolveHistoryPlanChangeMarker(entry, chartData, 'UTC')).toBeNull();
  });

  it('falls back to the bare "Plan changed here" line on an unknown reason code (no misattributed diff)', () => {
    const entry = revisedEntry({
      revisions: [
        { atMs: START_MS + 2 * HOUR_MS, reasonId: 'some_future_reason', hoursAdded: 3, hoursRemoved: 3 },
      ],
    });
    const marker = resolveHistoryPlanChangeMarker(entry, resolveHistoryDetailChartData(entry), 'UTC');
    expect(marker!.readoutLine).toBe('Plan changed here');
  });

  it('falls back to the final snapshot revisedAtMs when no revision log was recorded', () => {
    const entry = revisedEntry({ revisions: undefined });
    const marker = resolveHistoryPlanChangeMarker(entry, resolveHistoryDetailChartData(entry), 'UTC');
    expect(marker).not.toBeNull();
    expect(marker!.atMs).toBe(START_MS + 2 * HOUR_MS);
    expect(marker!.readoutLine).toBe('Plan changed here');
  });
});

describe('resolveHistoryTrajectoryReadout', () => {
  it('composes per-hour rows with Measured + Planned values and defaults to the plan-change hour', () => {
    const entry = revisedEntry();
    const chartData = resolveHistoryDetailChartData(entry);
    const marker = resolveHistoryPlanChangeMarker(entry, chartData, 'UTC');
    const readout = resolveHistoryTrajectoryReadout(chartData, marker, 'UTC');
    // 19:00 → 01:00 window = 6 hour rows.
    expect(readout.rows).toHaveLength(6);
    expect(readout.rows[0]!.primary).toMatch(/^19:00 · Measured 50\.0 °C/);
    // Default selection = the plan-change hour (21:00, index 2); its
    // secondary line carries the canonical revision sentence.
    expect(readout.defaultIndex).toBe(2);
    expect(readout.rows[2]!.primary).toMatch(/^21:00 · Measured 56\.1 °C · Planned/);
    expect(readout.rows[2]!.secondary).toBe('Plan changed here — tomorrow’s prices published (+3h −3h)');
    expect(readout.rows[1]!.secondary).toBeNull();
  });

  it('defaults to the met hour when the run never replanned', () => {
    const entry = buildEntry();
    const chartData = resolveHistoryDetailChartData(entry);
    const readout = resolveHistoryTrajectoryReadout(chartData, null, 'UTC');
    // metAtMs = deadline − 1h = index 5 of the 6-hour grid.
    expect(readout.defaultIndex).toBe(5);
  });

  it('renders the midnight row as "00:00", never "24:00" (h23 hour cycle)', () => {
    // The 19:00 → 01:00 window crosses midnight at row 5. A bare
    // `hour12: false` can resolve to the `h24` cycle in some locales and
    // print "24:00"; the producers force `hourCycle: 'h23'`.
    const entry = buildEntry();
    const chartData = resolveHistoryDetailChartData(entry);
    const readout = resolveHistoryTrajectoryReadout(chartData, null, 'UTC');
    expect(readout.rows[5]!.primary).toMatch(/^00:00/);
    for (const row of readout.rows) {
      expect(row.primary).not.toContain('24:00');
    }
  });

  it('never fabricates a Measured segment from the echoed start reading alone', () => {
    // Sample-less entry with no final reading either: the chart payload
    // carries no measured series, so every readout row must suppress the
    // Measured segment instead of echoing the start value for each hour.
    const entry = buildEntry({ progressSamples: undefined, finalProgressC: null });
    const chartData = resolveHistoryDetailChartData(entry);
    expect(chartData.observed).toHaveLength(0);
    const readout = resolveHistoryTrajectoryReadout(chartData, null, 'UTC');
    for (const row of readout.rows) {
      expect(row.primary).not.toContain('Measured');
    }
    // Planned values still read from the staircase.
    expect(readout.rows[0]!.primary).toContain('Planned');
  });
});

describe('resolveHistoryRunBands', () => {
  it('labels the chart payload\'s final-preferred merged bands with the kind verb', () => {
    const entry = revisedEntry();
    const bands = resolveHistoryRunBands(entry, resolveHistoryDetailChartData(entry));
    // Final plan books 21:00–24:00 contiguously → one band.
    expect(bands).toHaveLength(1);
    expect(bands[0]).toEqual({
      fromMs: START_MS + 2 * HOUR_MS,
      toMs: START_MS + 5 * HOUR_MS,
      label: 'Heating',
    });
  });

  it('keeps gapped hours as separate bands (label on the first only)', () => {
    const entry = buildEntry();
    const bands = resolveHistoryRunBands(entry, resolveHistoryDetailChartData(entry));
    expect(bands).toHaveLength(2);
    expect(bands[0]!.label).toBe('Heating');
    expect(bands[1]!.label).toBeNull();
  });
});

describe('resolveHistoryStripReadout', () => {
  const stripEntry = (
    overrides: Partial<DeferredObjectivePlanHistoryEntry> = {},
  ): ResolvedDeferredObjectivePlanHistoryEntry => revisedEntry({
    // Raw øre prices (the recorder's accumulation unit under the default
    // øre→kr scheme); display scaling happens in the readout producer.
    hourlyContributions: [
      { atMs: START_MS + 2 * HOUR_MS, deliveredKWh: 1.2, priceValue: 42, tone: 'cheap' },
      { atMs: START_MS + 4 * HOUR_MS, deliveredKWh: 1.1, priceValue: 48, tone: 'normal' },
    ],
    costDisplay: { unit: 'kr', divisor: 100 },
    ...overrides,
  });

  const resolveRows = (entry: ResolvedDeferredObjectivePlanHistoryEntry) => {
    const strip = resolveHistoryDetailHourlyStrip(entry);
    if (strip.mode !== 'present') throw new Error('expected present strip');
    return resolveHistoryStripReadout(strip, entry, resolveHistoryDetailChartData(entry), 'UTC');
  };

  it('pays the title promise: per-hour kWh · rate ≈ cost, scaled by the recorded divisor', () => {
    const readout = resolveRows(stripEntry());
    // 23:00 bucket (index 4): 1.1 kWh at raw 48 øre → 0.48 kr/kWh ≈ 0.53 kr.
    expect(readout.rows[4]!.primary).toBe('23:00 · 1.1 kWh · 0.48 kr/kWh ≈ 0.53 kr');
    expect(readout.rows[4]!.secondary).toBe(HISTORY_STRIP_RAN_AS_PLANNED);
  });

  it('defaults the selection to the tallest delivered bar', () => {
    const readout = resolveRows(stripEntry());
    // 1.2 kWh at 21:00 (index 2) beats 1.1 kWh at 23:00.
    expect(readout.defaultIndex).toBe(2);
  });

  it('attributes a dropped hour to the single recorded replan', () => {
    const readout = resolveRows(stripEntry());
    // 19:00 was planned in the original, absent from the final plan, and the
    // run has exactly one revision → attributable skip.
    expect(readout.rows[0]!.primary).toBe('19:00 · 1.0 kWh planned');
    expect(readout.rows[0]!.secondary).toBe('Skipped at the 21:00 plan change — tomorrow’s prices published');
  });

  it('keeps the stem only on a bare schedule_revised reason (no "plan change — schedule revised" tautology)', () => {
    const readout = resolveRows(stripEntry({
      revisions: [
        { atMs: START_MS + 2 * HOUR_MS, reasonId: 'schedule_revised', hoursAdded: 3, hoursRemoved: 3 },
      ],
    }));
    expect(readout.rows[0]!.secondary).toBe('Skipped at the 21:00 plan change');
  });

  it('falls back to the neutral line when several replans make attribution a guess', () => {
    const readout = resolveRows(stripEntry({
      revisions: [
        { atMs: START_MS + HOUR_MS, reasonId: 'prices_revised', hoursAdded: 1, hoursRemoved: 1 },
        { atMs: START_MS + 2 * HOUR_MS, reasonId: 'schedule_revised', hoursAdded: 2, hoursRemoved: 2 },
      ],
    }));
    expect(readout.rows[0]!.secondary).toBe(HISTORY_STRIP_PLANNED_NOT_RUN);
  });

  it('falls back to the neutral line when the hour stayed in the final plan but never ran', () => {
    // 22:00 (index 3) is booked by BOTH plans but received no delivery —
    // there is no replan to attribute, so the neutral line renders.
    const readout = resolveRows(stripEntry());
    expect(readout.rows[3]!.secondary).toBe(HISTORY_STRIP_PLANNED_NOT_RUN);
  });

  it('reads "Not scheduled" on gap buckets and suppresses price parts without a usable unit', () => {
    const readout = resolveRows(stripEntry({
      costDisplay: { unit: '', divisor: 1 },
    }));
    // 00:00 (index 5): neither planned nor delivered → gap bucket.
    expect(readout.rows[5]!.primary).toBe('00:00');
    expect(readout.rows[5]!.secondary).toBe('Not scheduled');
    // Empty recorded unit → kWh only, no fabricated currency.
    expect(readout.rows[4]!.primary).toBe('23:00 · 1.1 kWh');
  });

  it('labels every bucket with its bare hour on a short window', () => {
    const readout = resolveRows(stripEntry());
    // 6 buckets ≤ the dense ceiling → every bucket carries its hour label.
    expect(readout.rows.map((row) => row.axisLabel)).toEqual(['19', '20', '21', '22', '23', '00']);
  });

  it('thins the axis cadence to first/last/every-2nd when the buckets get narrow', () => {
    // 24-hour window → 24 buckets, well past the dense ceiling.
    const readout = resolveRows(stripEntry({ deadlineAtMs: START_MS + 24 * HOUR_MS }));
    expect(readout.rows).toHaveLength(24);
    expect(readout.rows[0]!.axisLabel).toBe('19');
    expect(readout.rows[1]!.axisLabel).toBeNull();
    expect(readout.rows[2]!.axisLabel).toBe('21');
    // Last bucket always keeps its label so the strip's extent stays legible.
    expect(readout.rows[23]!.axisLabel).toBe('18');
  });

  it('renders minor-unit display currencies as whole integers', () => {
    const readout = resolveRows(stripEntry({
      costDisplay: { unit: 'øre', divisor: 1 },
    }));
    // 48 øre/kWh × 1.1 kWh ≈ 53 øre — integers per the money convention.
    expect(readout.rows[4]!.primary).toBe('23:00 · 1.1 kWh · 48 øre/kWh ≈ 53 øre');
  });
});
