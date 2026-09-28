// Unit tests for the LIVE smart-task trajectory chart producer (smart-tasks
// widget). Mirrors the finished-run history producer's shape but anchors a
// single planned staircase at the run's start progress and overlays the
// observed-so-far line — no revised line, no "reached" marker.
import { resolveActivePlanChartData } from '../../packages/shared-domain/src/deferredActivePlanChartData';
import { type ActivePlanFixture, resolveActivePlanFixture } from '../helpers/activePlanFixtures';

const HOUR_MS = 60 * 60 * 1000;
const START_MS = Date.UTC(2026, 4, 26, 10, 0, 0);
const DEADLINE_MS = START_MS + 4 * HOUR_MS;

const buildPlan = (
  overrides: Partial<ActivePlanFixture> = {},
): ActivePlanFixture => ({
  deviceId: 'dev-1',
  deviceName: 'Hot water',
  objectiveKind: 'temperature',
  targetValue: 55,
  deadlineAtMs: DEADLINE_MS,
  startedAtMs: START_MS,
  pending: false,
  objectiveSignature: 'sig',
  original: null,
  latest: {
    revision: 1,
    revisedAtMs: START_MS,
    computedFromPricesUpTo: null,
    reason: 'flow_card',
    // 0.5 kWh/°C → 1 kWh raises progress by 2 °C.
    hours: [
      { startsAtMs: START_MS + HOUR_MS, plannedKWh: 1 },
      { startsAtMs: START_MS + 2 * HOUR_MS, plannedKWh: 1 },
    ],
    energyNeededKWh: 2,
    planStatus: 'on_track',
    rateMean: 0.5,
  },
  startProgressValue: 50,
  progressSamples: [
    { atMs: START_MS, value: 50 },
    { atMs: START_MS + HOUR_MS, value: 52 },
  ],
  ...overrides,
});

// The producer consumes the RESOLVED view; this wrapper resolves the fixture at
// the producer boundary exactly as the real UI payload assembler does.
const resolveChart = (
  plan: ActivePlanFixture,
  options?: { nowMs?: number; currentValue?: number | null },
) => resolveActivePlanChartData(resolveActivePlanFixture(plan), options);

describe('resolveActivePlanChartData', () => {
  test('anchors the planned staircase at the observed value where booked heating starts, capped at target', () => {
    const data = resolveChart(buildPlan());
    expect(data.mode).toBe('trajectory');
    expect(data.unit).toBe('°C');
    expect(data.windowStartMs).toBe(START_MS);
    expect(data.windowEndMs).toBe(DEADLINE_MS);
    expect(data.target).toBe(55);
    // First booked hour is START_MS + 1h; the device had measured 52 °C by then
    // (observed sample), so the line anchors at 52 there — not the 50 °C
    // task-start progress. Then +2 °C per booked hour, clamped at the 55 °C
    // target (the second riser would reach 56).
    expect(data.plannedOriginal).toEqual([
      { atMs: START_MS + HOUR_MS, value: 52 },
      { atMs: START_MS + 2 * HOUR_MS, value: 54 },
      { atMs: START_MS + 3 * HOUR_MS, value: 55 },
    ]);
    // Live charts never draw a revised line or a reached marker.
    expect(data.plannedFinal).toBeNull();
    expect(data.metAtMs).toBeNull();
    expect(data.metMarkerValue).toBeNull();
  });

  test('caps the planned staircase at the target (no overshoot past the goal)', () => {
    // 5 booked hours × 1 kWh ÷ 0.5 kWh/°C = +10 °C from start 50 → would reach
    // 60, but the target is 55, so the drawn plan must flatten at 55.
    const data = resolveChart(buildPlan({
      targetValue: 55,
      startProgressValue: 50,
      latest: {
        ...buildPlan().latest!,
        rateMean: 0.5,
        hours: [
          { startsAtMs: START_MS + HOUR_MS, plannedKWh: 1 },
          { startsAtMs: START_MS + 2 * HOUR_MS, plannedKWh: 1 },
          { startsAtMs: START_MS + 3 * HOUR_MS, plannedKWh: 1 },
          { startsAtMs: START_MS + 4 * HOUR_MS, plannedKWh: 1 },
          { startsAtMs: START_MS + 5 * HOUR_MS, plannedKWh: 1 },
        ],
      },
    }));
    const maxPlanned = Math.max(...data.plannedOriginal.map((p) => p.value));
    expect(maxPlanned).toBe(55);
  });

  test('appends the live now reading past the last sample', () => {
    const data = resolveChart(buildPlan(), {
      nowMs: START_MS + 2.5 * HOUR_MS,
      currentValue: 53,
    });
    const last = data.observed[data.observed.length - 1]!;
    expect(last).toEqual({ atMs: START_MS + 2.5 * HOUR_MS, value: 53 });
  });

  test('anchors the measured line at the run start when the first sample lands later', () => {
    const data = resolveChart(buildPlan({
      startProgressValue: 50,
      // First sample an hour into the run — without anchoring the line would
      // begin mid-chart.
      progressSamples: [
        { atMs: START_MS + HOUR_MS, value: 52 },
        { atMs: START_MS + 2 * HOUR_MS, value: 54 },
      ],
    }));
    expect(data.observed[0]).toEqual({ atMs: START_MS, value: 50 });
  });

  test('draws a cooling plan down to target from the observed value when booked work starts', () => {
    const coolingStart = START_MS + HOUR_MS;
    const data = resolveChart(buildPlan({
      targetValue: 40,
      startProgressValue: 65,
      latest: {
        ...buildPlan().latest!,
        progressDirection: 'decreasing',
        // 5 kWh each ÷ 0.5 kWh/°C changes the temperature by 10 °C.
        hours: [
          { startsAtMs: coolingStart, plannedKWh: 5 },
          { startsAtMs: coolingStart + HOUR_MS, plannedKWh: 5 },
          { startsAtMs: coolingStart + 2 * HOUR_MS, plannedKWh: 5 },
        ],
        rateMean: 0.5,
      },
      progressSamples: [
        { atMs: START_MS, value: 65 },
        { atMs: coolingStart, value: 55 },
        { atMs: coolingStart + HOUR_MS, value: 45 },
      ],
    }));
    expect(data.plannedOriginal[0]).toEqual({ atMs: coolingStart, value: 55 });
    const values = data.plannedOriginal.map((p) => p.value);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]!).toBeLessThanOrEqual(values[i - 1]!);
      expect(values[i]!).toBeGreaterThanOrEqual(40);
    }
    expect(values.at(-1)).toBe(40);
  });

  test('does not invent a planned direction when the live direction is unknown', () => {
    const data = resolveChart(buildPlan({
      latest: { ...buildPlan().latest!, progressDirection: 'unknown' },
    }));
    expect(data.mode).toBe('trajectory');
    expect(data.plannedOriginal).toEqual([]);
    expect(data.observed).toHaveLength(2);
  });

  test('renders the planned line from the live reading when the stitch gave no start/samples', () => {
    // Reproduces the on-device "on-going task has no chart" case: the in-progress
    // stitch delivered neither start progress nor samples (e.g. just after an app
    // restart), but the plan + rate are present and the device reports a live
    // value. The planned staircase must still render (anchored at the live value).
    const data = resolveChart(buildPlan({
      startProgressValue: null,
      progressSamples: undefined,
      targetValue: 65,
      latest: { ...buildPlan().latest!, rateMean: 0.5 },
    }), { nowMs: START_MS + HOUR_MS, currentValue: 30 });
    expect(data.mode).toBe('trajectory');
    expect(data.plannedOriginal.length).toBeGreaterThanOrEqual(2);
    // The "now" reading anchors the plan and shows the you-are-here dot.
    expect(data.observed.some((p) => p.value === 30)).toBe(true);
  });

  test('maps observed samples to the kind value and sorts ascending', () => {
    const data = resolveChart(buildPlan());
    expect(data.observed).toEqual([
      { atMs: START_MS, value: 50 },
      { atMs: START_MS + HOUR_MS, value: 52 },
    ]);
  });

  test('reads EV SoC progress + target in percent', () => {
    const data = resolveChart(buildPlan({
      objectiveKind: 'ev_soc',
      targetValue: 80,
      startProgressValue: 45,
      latest: { ...buildPlan().latest!, rateMean: 0.5 },
      progressSamples: [
        { atMs: START_MS, value: 45 },
        { atMs: START_MS + HOUR_MS, value: 52 },
      ],
    }));
    expect(data.unit).toBe('%');
    expect(data.target).toBe(80);
    expect(data.observed.map((p) => p.value)).toEqual([45, 52]);
  });

  test('falls back to the learned-profile rate when latest.rateMean is absent', () => {
    const data = resolveChart(buildPlan({
      latest: { ...buildPlan().latest!, rateMean: undefined },
      kwhPerUnitProvenance: {
        source: 'learned',
        kWhPerUnit: 0.5,
        acceptedSamples: 10,
        confidence: 'medium',
        lastAcceptedAtMs: START_MS,
      },
    }));
    expect(data.mode).toBe('trajectory');
    expect(data.plannedOriginal.length).toBeGreaterThan(0);
  });

  test('renders observed-only (no planned) when there is no usable rate but ≥2 samples', () => {
    const data = resolveChart(buildPlan({
      latest: { ...buildPlan().latest!, rateMean: 0 },
      kwhPerUnitProvenance: undefined,
    }));
    expect(data.mode).toBe('trajectory');
    expect(data.plannedOriginal).toEqual([]);
    expect(data.observed).toHaveLength(2);
  });

  test('falls back to a chartless payload when no rate AND fewer than two samples', () => {
    const data = resolveChart(buildPlan({
      latest: { ...buildPlan().latest!, rateMean: 0 },
      kwhPerUnitProvenance: undefined,
      progressSamples: [{ atMs: START_MS, value: 50 }],
    }));
    expect(data.mode).toBe('legacy_kwh');
    expect(data.plannedOriginal).toEqual([]);
    expect(data.observed).toEqual([]);
    // Target still surfaces so the caller can show it in the text lines.
    expect(data.target).toBe(55);
  });

  test('resolves merged scheduled-run bands from the live schedule\'s booked hours', () => {
    // The fixture books two contiguous hours (+1h and +2h) → one merged band.
    const data = resolveChart(buildPlan());
    expect(data.runBands).toEqual([
      { fromMs: START_MS + HOUR_MS, toMs: START_MS + 3 * HOUR_MS },
    ]);
  });

  test('keeps a gap between detached booked hours and skips zero-kWh hours', () => {
    const data = resolveChart(buildPlan({
      latest: {
        ...buildPlan().latest!,
        hours: [
          { startsAtMs: START_MS, plannedKWh: 1 },
          { startsAtMs: START_MS + HOUR_MS, plannedKWh: 0 },
          { startsAtMs: START_MS + 2 * HOUR_MS, plannedKWh: 1 },
        ],
      },
    }));
    expect(data.runBands).toEqual([
      { fromMs: START_MS, toMs: START_MS + HOUR_MS },
      { fromMs: START_MS + 2 * HOUR_MS, toMs: START_MS + 3 * HOUR_MS },
    ]);
  });

  test('still resolves bands when no usable rate suppresses the planned staircase', () => {
    // The booked WHEN is known independently of the rate-derived HOW MUCH.
    const data = resolveChart(buildPlan({
      latest: { ...buildPlan().latest!, rateMean: 0 },
      kwhPerUnitProvenance: undefined,
    }));
    expect(data.plannedOriginal).toEqual([]);
    expect(data.runBands).toEqual([
      { fromMs: START_MS + HOUR_MS, toMs: START_MS + 3 * HOUR_MS },
    ]);
  });

  test('emits no bands on the chartless fallback payload', () => {
    const data = resolveChart(buildPlan({
      latest: { ...buildPlan().latest!, rateMean: 0 },
      kwhPerUnitProvenance: undefined,
      progressSamples: [{ atMs: START_MS, value: 50 }],
    }));
    expect(data.mode).toBe('legacy_kwh');
    expect(data.runBands).toEqual([]);
  });

  test('drops non-finite / valueless samples', () => {
    const data = resolveChart(buildPlan({
      progressSamples: [
        { atMs: START_MS, value: 50 },
        { atMs: Number.NaN, value: 51 },
        { atMs: START_MS + HOUR_MS, value: null }, // no value in either column
        { atMs: START_MS + 2 * HOUR_MS, value: 53 },
      ],
    }));
    expect(data.observed).toEqual([
      { atMs: START_MS, value: 50 },
      { atMs: START_MS + 2 * HOUR_MS, value: 53 },
    ]);
  });
});
