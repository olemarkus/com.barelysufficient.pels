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

  it('drops the "of Y" denominator when delivery met or exceeded the scheduled total', () => {
    // The denominator is the energy the plan *scheduled*, not the energy needed
    // to reach the target. A heat run that lost heat faster than planned can
    // deliver more than the scheduled total and still miss — "Delivered 14.2 of
    // 9.9 kWh · short ≈ 49 min" reads as a >100% contradiction. When delivery
    // meets/exceeds the schedule, energy wasn't the limiter: show the bare figure.
    const line = formatPlanHistoryShortfallChip(buildEntry({
      outcome: 'missed',
      finalProgressPercent: 60,
      deliveredKWh: 14.2,
      finalPlan: buildSnapshot({
        hours: [
          { startsAtMs: DEADLINE_MS - 2 * HOUR_MS, plannedKWh: 5 },
          { startsAtMs: DEADLINE_MS - HOUR_MS, plannedKWh: 4.9 },
        ],
      }),
    }));
    expect(line).toMatch(/Delivered 14\.2 kWh/);
    expect(line).not.toMatch(/of 9\.9 kWh/);
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
  // "Now" = Sat 16 May 2026 12:00 UTC — same ISO week (20) as the canonical
  // DEADLINE_MS, with the previous week being ISO 19 (Mon 4 May–Sun 10 May).
  // Older entries fall back to "Week of <day month>" copy.
  const NOW_MS = Date.UTC(2026, 4, 16, 12, 0, 0);

  it('uses chip-vocabulary outcome counts and surfaces misses + abandons (PR-11)', () => {
    // Mixed week: 2 succeeded, 1 missed, 1 abandoned, 1 replaced. The
    // divider should surface the non-zero outcome counts and roll abandoned
    // + replaced into a single `abandoned` figure per ui-terminology.md.
    const entries = [
      buildEntry({ id: 'a', outcome: 'met', deadlineAtMs: DEADLINE_MS, totalCost: 10 }),
      buildEntry({ id: 'b', outcome: 'met', deadlineAtMs: DEADLINE_MS - HOUR_MS, totalCost: 8 }),
      buildEntry({ id: 'c', outcome: 'missed', deadlineAtMs: DEADLINE_MS - 2 * HOUR_MS, totalCost: 5 }),
      buildEntry({ id: 'd', outcome: 'abandoned', deadlineAtMs: DEADLINE_MS - 3 * HOUR_MS, totalCost: 2 }),
      buildEntry({ id: 'e', outcome: 'replaced', deadlineAtMs: DEADLINE_MS - 4 * HOUR_MS, totalCost: 1 }),
    ];
    const groups = groupPlanHistoryByIsoWeek(entries, 'UTC', 'kr', NOW_MS);
    expect(groups).toHaveLength(1);
    const heading = groups[0]!.heading;
    expect(heading).toContain('2 succeeded');
    expect(heading).toContain('1 missed');
    // abandoned + replaced both collapse into the `abandoned` chip noun.
    expect(heading).toContain('2 abandoned');
    // Engineer-facing "Week 20" copy is gone — relative phrasing leads.
    expect(heading).not.toMatch(/Week \d/);
    // Chip vocabulary, not the legacy verb "N deadlines met".
    expect(heading).not.toContain('deadlines met');
    expect(heading.endsWith('.')).toBe(false);
  });

  it('shows missed/abandoned counts even when nothing succeeded that week', () => {
    // Zero succeeded; previous version dropped this week's outcomes entirely
    // and rendered a bare "Week 19" — PR-11 surfaces the misses/abandons.
    const entries = [
      buildEntry({ id: 'a', outcome: 'missed', deadlineAtMs: DEADLINE_MS - 6 * 24 * HOUR_MS, totalCost: 5 }),
      buildEntry({ id: 'b', outcome: 'abandoned', deadlineAtMs: DEADLINE_MS - 7 * 24 * HOUR_MS }),
    ];
    const groups = groupPlanHistoryByIsoWeek(entries, 'UTC', 'kr', NOW_MS);
    expect(groups).toHaveLength(1);
    const heading = groups[0]!.heading;
    expect(heading).toContain('1 missed');
    expect(heading).toContain('1 abandoned');
    expect(heading).not.toContain('succeeded');
  });

  it('renders "This week" for the current ISO week', () => {
    const groups = groupPlanHistoryByIsoWeek(
      [buildEntry({ outcome: 'met', deadlineAtMs: DEADLINE_MS, totalCost: 12 })],
      'UTC',
      'kr',
      NOW_MS,
    );
    expect(groups[0]!.heading.startsWith('This week')).toBe(true);
  });

  it('renders "Last week" for the immediately preceding ISO week', () => {
    // Mon 4 May 2026 12:00 UTC — ISO week 19 (one week before NOW_MS).
    const lastWeekMs = Date.UTC(2026, 4, 4, 12, 0, 0);
    const groups = groupPlanHistoryByIsoWeek(
      [buildEntry({ outcome: 'met', deadlineAtMs: lastWeekMs })],
      'UTC',
      '',
      NOW_MS,
    );
    expect(groups[0]!.heading.startsWith('Last week')).toBe(true);
  });

  it('renders "Week of <day month>" for older weeks', () => {
    // Wed 22 Apr 2026 — ISO week 17. Monday of that week is 20 Apr.
    const olderMs = Date.UTC(2026, 3, 22, 12, 0, 0);
    const groups = groupPlanHistoryByIsoWeek(
      [buildEntry({ outcome: 'met', deadlineAtMs: olderMs })],
      'UTC',
      '',
      NOW_MS,
    );
    // "Week of 20 Apr" — Intl short-month rendering in UTC. Tolerate
    // locale variation in the month spelling but pin the day + prefix.
    expect(groups[0]!.heading).toMatch(/^Week of 20 \w+/);
  });

  it('drops the cost half cleanly when the unit suffix is empty', () => {
    const groups = groupPlanHistoryByIsoWeek(
      [buildEntry({ outcome: 'met', totalCost: 12, deadlineAtMs: DEADLINE_MS })],
      'UTC',
      '',
      NOW_MS,
    );
    expect(groups[0]!.heading).toContain('This week');
    expect(groups[0]!.heading).not.toContain('kr');
  });

  it('returns an empty array on empty input', () => {
    expect(groupPlanHistoryByIsoWeek([], 'UTC', 'kr', NOW_MS)).toEqual([]);
  });

  // Regression: in time zones west of UTC, an earlier revision of
  // `formatRelativeWeekLabel` anchored the "previous Monday" instant at
  // 00:00 UTC of the current Monday's local date. In America/New_York
  // (UTC-4 in May) that midnight-UTC instant is actually Sunday evening
  // *local time*, so `getWeekStartInTimeZone` bucketed it two weeks back.
  // The result: "Last week" rows were mislabeled "Week of …" and the week
  // before that wore the "Last week" tag. Stepping back 7×24h from `nowMs`
  // and re-bucketing through `getWeekStartInTimeZone` keeps the comparison
  // anchored on a real wall-clock instant in the target zone.
  describe('relative week labels in non-UTC time zones', () => {
    const NY_TZ = 'America/New_York';
    // Mon 11 May 2026 09:00 New York time = 13:00 UTC. ISO week 20 locally.
    const NY_NOW_MS = Date.UTC(2026, 4, 11, 13, 0, 0);

    it('labels the immediately preceding week as "Last week" in America/New_York', () => {
      // Wed 6 May 2026 12:00 NY = 16:00 UTC — ISO week 19 locally.
      const lastWeekMs = Date.UTC(2026, 4, 6, 16, 0, 0);
      const groups = groupPlanHistoryByIsoWeek(
        [buildEntry({ outcome: 'met', deadlineAtMs: lastWeekMs })],
        NY_TZ,
        '',
        NY_NOW_MS,
      );
      expect(groups).toHaveLength(1);
      expect(groups[0]!.heading.startsWith('Last week')).toBe(true);
    });

    it('does not mislabel two-weeks-back as "Last week" in America/New_York', () => {
      // Tue 28 Apr 2026 12:00 NY = 16:00 UTC — ISO week 18 locally
      // (two weeks before NY_NOW_MS).
      const twoWeeksBackMs = Date.UTC(2026, 3, 28, 16, 0, 0);
      const groups = groupPlanHistoryByIsoWeek(
        [buildEntry({ outcome: 'met', deadlineAtMs: twoWeeksBackMs })],
        NY_TZ,
        '',
        NY_NOW_MS,
      );
      expect(groups).toHaveLength(1);
      expect(groups[0]!.heading.startsWith('Last week')).toBe(false);
      expect(groups[0]!.heading).toMatch(/^Week of /);
    });
  });
});
