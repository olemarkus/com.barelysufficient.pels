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
  resolvePlanHistory7DayHitRateStrip,
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
    // "Week of 20 Apr" (en-GB) or "Week of Apr 20" (en-US) — Intl
    // short-month rendering depends on the runtime locale, which the
    // formatter inherits via `toLocaleDateString([], ...)` (see
    // `formatDateInTimeZone`). Tolerate both day-first and month-first
    // orderings while pinning the prefix + the day "20".
    expect(groups[0]!.heading).toMatch(/^Week of (?:20 \w+|\w+ 20)\b/);
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
  // before that wore the "Last week" tag. The fix steps back one local
  // calendar day from the current week's Monday and re-buckets through
  // `getWeekStartInTimeZone`, keeping the comparison anchored on the local
  // calendar rather than UTC midnight. (The DST-transition suite below
  // pins the related 23h/25h-week defect.)
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

  // Regression for the DST defect Codex flagged on merged PR #1243. The
  // "Last week" comparison used to step back a fixed 7×24h from `nowMs`
  // before re-bucketing. That offset is wrong on weeks that straddle a DST
  // transition: a spring-forward week is only 23h on its short day, so the
  // subtraction undershoots and stays inside the *current* week (mislabels
  // the prior week "Week of …"); a fall-back week is 25h on its long day,
  // so the subtraction overshoots and lands *two* weeks back (the prior
  // week never wins "Last week"). The fix steps back one local calendar day
  // from the current week's Monday and re-buckets, so the comparison is
  // pure calendar arithmetic and immune to 23h/25h weeks. Europe/Oslo:
  // spring-forward Sun 29 Mar 2026 (02:00→03:00), fall-back Sun 25 Oct 2026
  // (03:00→02:00).
  describe('relative week labels across DST transitions (Europe/Oslo)', () => {
    const OSLO_TZ = 'Europe/Oslo';

    it('labels the 23h spring-forward week as "Last week"', () => {
      // The DST week is Mon 23 Mar–Sun 29 Mar 2026 (loses an hour Sun). "Now"
      // is Mon 30 Mar 00:30 local (= 22:30 UTC Sun 29), just into the next
      // week. nowMs − 7×24h lands inside the current week (the short DST week
      // ate the boundary), so the old code dropped "Last week" entirely.
      const nowMs = Date.UTC(2026, 2, 29, 22, 30, 0); // Mon 30 Mar 00:30 Oslo
      const dstWeekEntryMs = Date.UTC(2026, 2, 25, 9, 0, 0); // Wed 25 Mar 10:00 Oslo
      const groups = groupPlanHistoryByIsoWeek(
        [buildEntry({ outcome: 'met', deadlineAtMs: dstWeekEntryMs })],
        OSLO_TZ,
        '',
        nowMs,
      );
      expect(groups).toHaveLength(1);
      expect(groups[0]!.heading.startsWith('Last week')).toBe(true);
    });

    it('labels the week before the 25h fall-back week as "Last week"', () => {
      // "Now" is Sun 25 Oct 2026 23:30 local (= 22:30 UTC, already CET), the
      // tail of the 25h fall-back week (Mon 19–Sun 25 Oct). The immediately
      // preceding week is Mon 12–Sun 18 Oct. nowMs − 7×24h overshoots past
      // that week's Monday — the extra fall-back hour pushed a calendar week
      // beyond 168h — so the old code mislabeled it "Week of …".
      const nowMs = Date.UTC(2026, 9, 25, 22, 30, 0); // Sun 25 Oct 23:30 Oslo
      const priorWeekEntryMs = Date.UTC(2026, 9, 14, 8, 0, 0); // Wed 14 Oct 10:00 Oslo
      const groups = groupPlanHistoryByIsoWeek(
        [buildEntry({ outcome: 'met', deadlineAtMs: priorWeekEntryMs })],
        OSLO_TZ,
        '',
        nowMs,
      );
      expect(groups).toHaveLength(1);
      expect(groups[0]!.heading.startsWith('Last week')).toBe(true);
    });
  });
});

// PR-10 — 7-day hit-rate strip rendered above the past-tasks weekly archive.
// First-impression aggregate for the recovering-from-mistake persona. The
// hit-rate denominator excludes abandoned/replaced/unknown entries so a
// blameless abort doesn't penalise the user's planner success rate.
describe('resolvePlanHistory7DayHitRateStrip', () => {
  // Anchor inside the canonical DEADLINE_MS week so the entries built with
  // `buildEntry` (finalizedAtMs = DEADLINE_MS - 1h) land in-window by default.
  const NOW_MS = Date.UTC(2026, 4, 16, 12, 0, 0);

  it('returns null on empty entry lists so the view hides the strip', () => {
    expect(resolvePlanHistory7DayHitRateStrip([], NOW_MS, 'UTC')).toBeNull();
  });

  it('returns null when every entry falls outside the 7-day window', () => {
    // Push every entry's finalizedAtMs two weeks back — both the deadline
    // and the finalised stamp must land outside the window.
    const twoWeeksBackMs = NOW_MS - 14 * 24 * HOUR_MS;
    const strip = resolvePlanHistory7DayHitRateStrip(
      [
        buildEntry({
          outcome: 'met',
          deadlineAtMs: twoWeeksBackMs,
          finalizedAtMs: twoWeeksBackMs,
        }),
      ],
      NOW_MS,
      'UTC',
    );
    expect(strip).toBeNull();
  });

  it('renders 100% hit rate when every in-window entry succeeded', () => {
    const strip = resolvePlanHistory7DayHitRateStrip(
      [
        buildEntry({ id: 'a', outcome: 'met' }),
        buildEntry({ id: 'b', outcome: 'met' }),
        buildEntry({ id: 'c', outcome: 'met' }),
      ],
      NOW_MS,
      'UTC',
    );
    expect(strip).not.toBeNull();
    expect(strip!.succeeded).toBe(3);
    expect(strip!.missed).toBe(0);
    expect(strip!.abandoned).toBe(0);
    expect(strip!.hitRatePercent).toBe(100);
    expect(strip!.text).toBe('Last 7 days, all devices · 3 succeeded · 100% of 3 finished');
  });

  it('renders 0% hit rate when every in-window entry missed', () => {
    const strip = resolvePlanHistory7DayHitRateStrip(
      [
        buildEntry({ id: 'a', outcome: 'missed' }),
        buildEntry({ id: 'b', outcome: 'missed' }),
      ],
      NOW_MS,
      'UTC',
    );
    expect(strip).not.toBeNull();
    expect(strip!.succeeded).toBe(0);
    expect(strip!.missed).toBe(2);
    expect(strip!.hitRatePercent).toBe(0);
    expect(strip!.text).toBe('Last 7 days, all devices · 2 missed · 0% of 2 finished');
  });

  it('mixes succeeded/missed/abandoned with chip vocabulary and rounded percent', () => {
    // 8 succeeded + 3 missed + 1 abandoned: hit rate = 8 / 11 ≈ 72.7% → 73%.
    // The abandoned entry surfaces in the strip but is excluded from the
    // denominator so blameless aborts don't move the rate — the "of 11
    // finished" fragment makes that denominator legible (11 = 8 + 3, not 12).
    const entries = [
      ...Array.from({ length: 8 }, (_, i) => buildEntry({ id: `m${i}`, outcome: 'met' as const })),
      ...Array.from({ length: 3 }, (_, i) => buildEntry({ id: `x${i}`, outcome: 'missed' as const })),
      buildEntry({ id: 'a', outcome: 'abandoned' }),
    ];
    const strip = resolvePlanHistory7DayHitRateStrip(entries, NOW_MS, 'UTC');
    expect(strip).not.toBeNull();
    expect(strip!.succeeded).toBe(8);
    expect(strip!.missed).toBe(3);
    expect(strip!.abandoned).toBe(1);
    expect(strip!.hitRatePercent).toBe(73);
    expect(strip!.text).toBe('Last 7 days, all devices · 8 succeeded · 3 missed · 1 abandoned · 73% of 11 finished');
  });

  it('collapses replaced into abandoned for the chip count', () => {
    // `replaced` is the user-swapped path; it should fold into the same
    // chip-vocabulary `abandoned` bucket as the week-divider grouping does.
    const strip = resolvePlanHistory7DayHitRateStrip(
      [
        buildEntry({ id: 'a', outcome: 'met' }),
        buildEntry({ id: 'b', outcome: 'abandoned' }),
        buildEntry({ id: 'c', outcome: 'replaced' }),
      ],
      NOW_MS,
      'UTC',
    );
    expect(strip).not.toBeNull();
    expect(strip!.abandoned).toBe(2);
    expect(strip!.succeeded).toBe(1);
    expect(strip!.text).toContain('2 abandoned');
  });

  it('returns a null hit rate when only abandoned entries land in the window', () => {
    // No Succeeded + Missed entries → the percent half is suppressed entirely
    // rather than fabricating a "0% hit rate" off blameless aborts.
    const strip = resolvePlanHistory7DayHitRateStrip(
      [
        buildEntry({ id: 'a', outcome: 'abandoned' }),
        buildEntry({ id: 'b', outcome: 'replaced' }),
      ],
      NOW_MS,
      'UTC',
    );
    expect(strip).not.toBeNull();
    expect(strip!.hitRatePercent).toBeNull();
    expect(strip!.text).toBe('Last 7 days, all devices · 2 abandoned');
  });

  it('includes entries on the 7-day boundary and excludes those just outside it', () => {
    // The window is exactly 7 local date buckets — today plus the 6 preceding
    // ones — so the cutoff is 6 local midnights before NOW_MS's local day-start.
    // In UTC that is 2026-05-10 00:00 (NOW_MS = 2026-05-16 12:00, local midnight
    // 05-16 00:00, minus 6 days). Entry exactly on the cutoff → included; one
    // millisecond older → excluded.
    const cutoffMs = Date.UTC(2026, 4, 10, 0, 0, 0);
    const strip = resolvePlanHistory7DayHitRateStrip(
      [
        buildEntry({
          id: 'on-boundary',
          outcome: 'met',
          deadlineAtMs: cutoffMs,
          finalizedAtMs: cutoffMs,
        }),
        buildEntry({
          id: 'just-outside',
          outcome: 'missed',
          deadlineAtMs: cutoffMs - 1,
          finalizedAtMs: cutoffMs - 1,
        }),
      ],
      NOW_MS,
      'UTC',
    );
    expect(strip).not.toBeNull();
    expect(strip!.succeeded).toBe(1);
    expect(strip!.missed).toBe(0);
    expect(strip!.hitRatePercent).toBe(100);
  });

  it('keeps the window to exactly 7 local date buckets (no 8th-day bleed)', () => {
    // Codex's exact example (PR #1264 P2): at 2026-05-16 23:00 UTC the old
    // cutoff stepped back 7 local midnights from today's start-of-day, landing
    // at 2026-05-09 00:00 — so entries from the first 23h of May 9 leaked into
    // the "Last 7 days" rate even though they predate a true 7-day span. The
    // fix steps back only 6 midnights: the window is today (May 16) plus the 6
    // preceding dates (May 10–15) = 7 buckets, cutoff 2026-05-10 00:00. A May 9
    // entry must NOT count; a May 10 00:00 entry must.
    const nowMs = Date.UTC(2026, 4, 16, 23, 0, 0); // 2026-05-16 23:00 UTC
    const newCutoffMs = Date.UTC(2026, 4, 10, 0, 0, 0); // first in-window bucket
    const eighthDayMs = Date.UTC(2026, 4, 9, 12, 0, 0); // mid-May 9 — the bleed
    const strip = resolvePlanHistory7DayHitRateStrip(
      [
        buildEntry({
          id: 'eighth-day-ago',
          outcome: 'met',
          deadlineAtMs: eighthDayMs,
          finalizedAtMs: eighthDayMs,
        }),
        buildEntry({
          id: 'first-bucket',
          outcome: 'missed',
          deadlineAtMs: newCutoffMs,
          finalizedAtMs: newCutoffMs,
        }),
      ],
      nowMs,
      'UTC',
    );
    expect(strip).not.toBeNull();
    // Only the May 10 entry is in-window; the May 9 entry is excluded.
    expect(strip!.succeeded).toBe(0);
    expect(strip!.missed).toBe(1);
    expect(strip!.hitRatePercent).toBe(0);
  });

  // Regression for the DST defect Codex's pels-runtime-reality flagged: the
  // cutoff used to be `nowMs − N×24h`, a fixed millisecond offset. On a window
  // that straddles a DST transition that offset drifts the cutoff by the lost
  // or gained hour, so an early-morning entry on the window's first local day
  // is silently dropped (spring-forward) or admitted (fall-back) when it
  // shouldn't be. The fix steps back 6 local calendar days from `nowMs`'s
  // local day-start (7 local date buckets total), anchoring the cutoff at local
  // midnight regardless of the 23h/25h day — same approach PR #1259 applied to
  // the "Last week" divider. Europe/Oslo: spring-forward Sun 29 Mar 2026
  // (02:00→03:00, 23h day), fall-back Sun 25 Oct 2026 (03:00→02:00, 25h day).
  // Each test places the DST Sunday as the window's first (oldest) bucket so the
  // fixed-offset drift would land the cutoff past the entry's wall-clock hour.
  describe('7-day window across DST transitions (Europe/Oslo)', () => {
    const OSLO_TZ = 'Europe/Oslo';

    it('includes a first-local-day entry across the 23h spring-forward day', () => {
      // "Now" is Sat 4 Apr 10:00 Oslo. The correct cutoff is Sun 29 Mar 00:00
      // Oslo (local midnight, 6 local days back; first of 7 buckets). The entry
      // is Sun 29 Mar 04:00 Oslo — inside the window. The buggy `nowMs − 6×24h`
      // cutoff lands at Sun 29 Mar 10:00 Oslo (the 23h DST day pulls the fixed
      // offset deeper into the day), which would wrongly exclude this 04:00
      // entry.
      const nowMs = Date.UTC(2026, 3, 4, 8, 0, 0); // Sat 4 Apr 10:00 Oslo
      const firstDayEntryMs = Date.UTC(2026, 2, 29, 2, 0, 0); // Sun 29 Mar 04:00 Oslo
      const strip = resolvePlanHistory7DayHitRateStrip(
        [
          buildEntry({
            id: 'spring',
            outcome: 'met',
            deadlineAtMs: firstDayEntryMs,
            finalizedAtMs: firstDayEntryMs,
          }),
        ],
        nowMs,
        OSLO_TZ,
      );
      expect(strip).not.toBeNull();
      expect(strip!.succeeded).toBe(1);
      expect(strip!.hitRatePercent).toBe(100);
    });

    it('includes a first-local-day entry across the 25h fall-back day', () => {
      // "Now" is Sat 31 Oct 10:00 Oslo. The correct cutoff is Sun 25 Oct 00:00
      // Oslo (6 local days back; first of 7 buckets). The entry is Sun 25 Oct
      // 01:00 Oslo — inside the window. The buggy `nowMs − 6×24h` cutoff lands
      // at Sun 25 Oct 10:00 Oslo (the 25h DST day pushes the fixed offset later
      // in the day), which would wrongly exclude this 01:00 entry.
      const nowMs = Date.UTC(2026, 9, 31, 9, 0, 0); // Sat 31 Oct 10:00 Oslo
      const firstDayEntryMs = Date.UTC(2026, 9, 24, 23, 0, 0); // Sun 25 Oct 01:00 Oslo
      const strip = resolvePlanHistory7DayHitRateStrip(
        [
          buildEntry({
            id: 'fall',
            outcome: 'met',
            deadlineAtMs: firstDayEntryMs,
            finalizedAtMs: firstDayEntryMs,
          }),
        ],
        nowMs,
        OSLO_TZ,
      );
      expect(strip).not.toBeNull();
      expect(strip!.succeeded).toBe(1);
      expect(strip!.hitRatePercent).toBe(100);
    });
  });
});
