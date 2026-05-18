// Unit tests for the v2.7.3 "history loveable" producers (receipt timeline,
// shortfall chip, cost narrative, abandoned <details> body, ISO-week archive
// grouping). Each test pins one branch of the helper so the asymmetric hero
// shapes can rely on flat producer outputs without re-deriving in the view.
import {
  formatPlanHistoryAbandonedDetails,
  formatPlanHistoryCostNarrative,
  formatPlanHistoryReceiptTimeline,
  formatPlanHistoryShortfallChip,
  groupPlanHistoryByIsoWeek,
} from '../packages/shared-domain/src/deferredPlanHistoryReceipt';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
} from '../packages/contracts/src/deferredObjectivePlanHistory';

const HOUR_MS = 60 * 60 * 1000;
const DEADLINE_MS = Date.UTC(2026, 4, 16, 7, 0, 0); // Sat 16 May 07:00 UTC

const buildSnapshot = (
  overrides: Partial<DeferredObjectivePlanHistoryRevisionSnapshot> = {},
): DeferredObjectivePlanHistoryRevisionSnapshot => ({
  hours: [
    { startsAtMs: DEADLINE_MS - 4 * HOUR_MS, plannedKWh: 1 },
    { startsAtMs: DEADLINE_MS - 3 * HOUR_MS, plannedKWh: 4 },
    { startsAtMs: DEADLINE_MS - 2 * HOUR_MS, plannedKWh: 2 },
  ],
  energyNeededKWh: 7,
  planStatus: 'on_track',
  revisedAtMs: DEADLINE_MS - 5 * HOUR_MS,
  ...overrides,
});

const buildEntry = (
  overrides: Partial<DeferredObjectivePlanHistoryEntry> = {},
): DeferredObjectivePlanHistoryEntry => ({
  id: 'entry-1',
  deviceId: 'dev-1',
  deviceName: 'Connected 300',
  objectiveKind: 'ev_soc',
  targetTemperatureC: null,
  targetPercent: 80,
  deadlineAtMs: DEADLINE_MS,
  startedAtMs: DEADLINE_MS - 8 * HOUR_MS,
  finalizedAtMs: DEADLINE_MS - HOUR_MS,
  startProgressC: null,
  startProgressPercent: 20,
  finalProgressC: null,
  finalProgressPercent: 80,
  initialEnergyNeededKWh: 24,
  outcome: 'met',
  metAtMs: DEADLINE_MS - 18 * 60 * 1000, // 18 min before deadline
  usedDeadlineReserve: false,
  usedPolicyAvoid: false,
  observedIntervals: [],
  discoveredFrom: 'observation',
  originalPlan: buildSnapshot(),
  finalPlan: buildSnapshot(),
  ...overrides,
});

describe('formatPlanHistoryReceiptTimeline (Succeeded)', () => {
  it('composes a 3-row Started → Largest planned hour → Ready timeline', () => {
    const rows = formatPlanHistoryReceiptTimeline(
      buildEntry({
        progressSamples: [
          { atMs: DEADLINE_MS - 8 * HOUR_MS, valueC: null, valuePercent: 20 },
          { atMs: DEADLINE_MS - 7 * HOUR_MS, valueC: null, valuePercent: 24 },
        ],
      }),
      'UTC',
    );
    expect(rows).not.toBeNull();
    expect(rows!.map((row) => row.label)).toEqual(['Started', 'Largest planned hour', 'Ready']);
    // Largest planned hour points at the 4 kWh peak hour (DEADLINE_MS - 3h = 04:00 UTC).
    const peak = rows!.find((row) => row.label === 'Largest planned hour');
    expect(peak?.time).toBe('04:00');
    expect(peak?.detail).toContain('4.0 kWh');
    const ready = rows!.find((row) => row.label === 'Ready');
    expect(ready?.detail).toMatch(/18 min before 07:00/);
  });

  it('returns null on Missed entries (the receipt is a Succeeded-only shape)', () => {
    expect(formatPlanHistoryReceiptTimeline(buildEntry({ outcome: 'missed' }), 'UTC')).toBeNull();
  });

  it('returns null when fewer than two rows can be composed (no plan, no metAtMs)', () => {
    const rows = formatPlanHistoryReceiptTimeline(buildEntry({
      originalPlan: null,
      finalPlan: null,
      metAtMs: null,
    }), 'UTC');
    expect(rows).toBeNull();
  });
});

describe('formatPlanHistoryShortfallChip (Missed)', () => {
  it('emits a blameless "Delivered X of Y · short ~Zm" string when both numbers exist', () => {
    const line = formatPlanHistoryShortfallChip(buildEntry({
      outcome: 'missed',
      finalProgressPercent: 60,
      deliveredKWh: 17,
      finalPlan: buildSnapshot({
        hours: [
          { startsAtMs: DEADLINE_MS - 4 * HOUR_MS, plannedKWh: 8 },
          { startsAtMs: DEADLINE_MS - 3 * HOUR_MS, plannedKWh: 8 },
          { startsAtMs: DEADLINE_MS - 2 * HOUR_MS, plannedKWh: 8 },
        ],
      }),
    }));
    expect(line).toMatch(/Delivered 17\.0 of 24\.0 kWh/);
    // v2.7.3 — NBSP between glyph and value so the chip never wraps mid-figure.
    expect(line).toMatch(/short ≈\u00a0/);
    // v2.7.3 — chip strings drop trailing periods (P2 fold-in).
    expect(line!.endsWith('.')).toBe(false);
  });

  it('returns null on Succeeded entries', () => {
    expect(formatPlanHistoryShortfallChip(buildEntry({ outcome: 'met' }))).toBeNull();
  });

  it('returns null when neither delivery nor shortfall is available', () => {
    expect(formatPlanHistoryShortfallChip(buildEntry({
      outcome: 'missed',
      deliveredKWh: undefined,
      finalProgressPercent: 80,
      finalPlan: null,
      originalPlan: null,
    }))).toBeNull();
  });
});

describe('formatPlanHistoryCostNarrative', () => {
  it('formats whole kroner with non-breaking spaces and no trailing period', () => {
    // v2.7.3 — chip uses NBSP between glyph + value + unit so it never
    // wraps mid-figure at 320 px; per-kWh average dropped pending
    // PR12-hourly-contributions per-hour spot prices.
    const line = formatPlanHistoryCostNarrative(
      buildEntry({ totalCost: 12.37, deliveredKWh: 10 }),
      'kr',
    );
    expect(line).toBe('≈ 12 kr');
    // No per-kWh half — spec deferred until per-hour spot prices land.
    expect(line).not.toContain('kr/kWh');
  });

  it('still renders the chip when delivery is missing', () => {
    const line = formatPlanHistoryCostNarrative(
      buildEntry({ totalCost: 7, deliveredKWh: undefined }),
      'kr',
    );
    expect(line).toBe('≈ 7 kr');
  });

  it('returns null on Abandoned and when the cost unit is empty', () => {
    expect(formatPlanHistoryCostNarrative(
      buildEntry({ outcome: 'abandoned', totalCost: 5 }),
      'kr',
    )).toBeNull();
    expect(formatPlanHistoryCostNarrative(buildEntry({ totalCost: 5 }), '')).toBeNull();
  });
});

describe('formatPlanHistoryAbandonedDetails', () => {
  it('emits a finalized clock and delivered-kWh line for partial-delivery entries', () => {
    const details = formatPlanHistoryAbandonedDetails(buildEntry({
      outcome: 'abandoned',
      deliveredKWh: 0.4,
      finalizedAtMs: DEADLINE_MS - 3 * HOUR_MS,
    }), 'UTC');
    expect(details).not.toBeNull();
    expect(details!.finalizedClock).toBe('04:00');
    expect(details!.lines.some((line) => line.includes('0.4 kWh delivered'))).toBe(true);
  });

  it('returns null for Succeeded entries', () => {
    expect(formatPlanHistoryAbandonedDetails(buildEntry({ outcome: 'met' }), 'UTC')).toBeNull();
  });

  it('returns null when neither delivery nor a usable last-state survives', () => {
    expect(formatPlanHistoryAbandonedDetails(buildEntry({
      outcome: 'abandoned',
      deliveredKWh: undefined,
      finalPlan: null,
      originalPlan: null,
    }), 'UTC')).toBeNull();
  });
});

describe('groupPlanHistoryByIsoWeek', () => {
  it('groups entries by ISO week and renders quiet "Week N · M deadlines met" headings', () => {
    // Three entries: two in ISO week 20 (Sat 16 May 2026, Thu 14 May), one in week 19 (Sun 10 May).
    const entries = [
      buildEntry({ id: 'a', outcome: 'met', deadlineAtMs: DEADLINE_MS, totalCost: 10 }),
      buildEntry({ id: 'b', outcome: 'met', deadlineAtMs: DEADLINE_MS - 2 * 24 * HOUR_MS, totalCost: 8 }),
      buildEntry({ id: 'c', outcome: 'missed', deadlineAtMs: DEADLINE_MS - 6 * 24 * HOUR_MS, totalCost: 5 }),
    ];
    const groups = groupPlanHistoryByIsoWeek(entries, 'UTC', 'kr');
    expect(groups).toHaveLength(2);
    expect(groups[0]!.weekKey).toBe('2026-W20');
    expect(groups[0]!.heading).toContain('Week 20');
    expect(groups[0]!.heading).toContain('2 deadlines met');
    expect(groups[0]!.heading).toContain('18 kr');
    // v2.7.3 P2 — section headings drop the trailing period.
    expect(groups[0]!.heading.endsWith('.')).toBe(false);
    expect(groups[1]!.weekKey).toBe('2026-W19');
    // v2.7.3 P2 — zero-met weeks render as just "Week N" (no cold fallback
    // "1 task" / "N tasks" count). Per-row chips still carry the outcome.
    expect(groups[1]!.heading).toContain('Week 19');
    expect(groups[1]!.heading).not.toContain('task');
  });

  it('drops the cost half cleanly when the unit suffix is empty', () => {
    const groups = groupPlanHistoryByIsoWeek(
      [buildEntry({ outcome: 'met', totalCost: 12 })],
      'UTC',
      '',
    );
    expect(groups[0]!.heading).toContain('Week');
    expect(groups[0]!.heading).not.toContain('kr');
  });

  it('returns an empty array on empty input', () => {
    expect(groupPlanHistoryByIsoWeek([], 'UTC', 'kr')).toEqual([]);
  });
});
