import type { TaskDeliveryCause } from '../../packages/contracts/src/taskDelivery';
// Unit tests for the smart-task history-detail postmortem resolver (v2.7.2 PR 3).
// Outcome-shaped variants split across `met` / `missed` / `abandoned`.
// Each test constructs a minimal entry and asserts
// the resolved variant slug + sentence shape so the asymmetric history hero
// can rely on `lead.sentence` without re-checking outcome.
//
// v2.7.2 PR 6 extends coverage to two list-level helpers added in the same
// train: `formatPlanHistoryOvershootLine` (Succeeded entries that overshot
// by > 5 °C / > 10 %) and `formatMissStreakAggregateLine` (recovering-from-
// mistake aggregate on the past-tasks landing surface).
import {
  formatMissStreakAggregateLine,
  formatPlanHistoryCostAndDelivered,
  formatPlanHistoryMissedReason,
  formatPlanHistoryOvershootLine,
  formatPlanHistoryPostmortem,
  formatPlanHistoryProgressLine,
  formatPlanHistoryUsageDayLinkLabel,
} from '../../packages/shared-domain/src/deferredPlanHistory';
import {
  formatPlanHistoryListCostAndDelivered,
  groupPlanHistoryByIsoWeek,
} from '../../packages/shared-domain/src/deferredPlanHistoryReceipt';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
  ResolvedDeferredObjectivePlanHistoryEntry,
} from '../../packages/contracts/src/deferredObjectivePlanHistory';
import { toResolvedLegacyPlanHistoryEntry } from '../../packages/shared-domain/src/deferredPlanHistoryResolvedView';

const HOUR_MS = 60 * 60 * 1000;
const DEADLINE_MS = Date.UTC(2026, 4, 16, 16, 0, 0); // Sat 16 May 16:00 UTC

const buildSnapshot = (
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
): ResolvedDeferredObjectivePlanHistoryEntry => toResolvedLegacyPlanHistoryEntry({
  id: 'entry-1',
  deviceId: 'dev-1',
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
  metAtMs: null,
  usedDeadlineReserve: false,
  observedIntervals: [],
  discoveredFrom: 'observation',
  originalPlan: null,
  finalPlan: null,
  ...overrides,
});

describe('formatPlanHistoryPostmortem', () => {
  describe('met outcome', () => {
    it('resolves met-with-margin when the run reached the target well before the deadline', () => {
      // Reached the target 4 h 3 min before the deadline (16:00) → margin
      // variant. The duration uses the receipt trio's phrasing with NBSP
      // joins ("4 h 3 min", unbreakable) and the timing headline drops its
      // trailing period to match the period-less trio rows (one convention).
      const metAtMs = DEADLINE_MS - 4 * HOUR_MS - 3 * 60 * 1000;
      const entry = buildEntry({
        outcome: 'met',
        metAtMs,
        finalProgressC: 65,
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('met-with-margin');
      expect(result.sentence).toContain('65.0 °C');
      expect(result.sentence).toContain('16:00');
      expect(result.sentence).toMatch(/4\u00a0h\u00a03\u00a0min/);
      expect(result.sentence.endsWith('.')).toBe(false);
    });

    it('resolves met-at-buzzer when the run reached target inside the last hour', () => {
      // Reached 2 minutes before deadline → at-buzzer variant.
      const metAtMs = DEADLINE_MS - 2 * 60 * 1000;
      const entry = buildEntry({
        outcome: 'met',
        metAtMs,
        finalProgressC: 65,
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('met-at-buzzer');
      expect(result.sentence).toMatch(/2\u00a0min before/);
    });

    it('resolves met-with-overshoot when the final progress is > 5 °C above target', () => {
      const entry = buildEntry({
        outcome: 'met',
        metAtMs: DEADLINE_MS - 4 * HOUR_MS,
        // 12.7 °C overshoot — well above the 5 °C threshold.
        finalProgressC: 77.7,
        targetTemperatureC: 65,
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('met-with-overshoot');
      // The headline drops the "— overshot." tail so it does not contradict
      // the `Succeeded` chip; the muted `Overshoot N °C` subline (rendered
      // by `DeadlinePlanHistoryDetail.tsx`) carries the magnitude instead.
      expect(result.sentence).not.toContain('overshot');
      // Period-less like its met-with-margin sibling — one convention across
      // the "Hit …" timing headline family.
      expect(result.sentence).toMatch(/^Hit .* at .*, before [^.]*$/);
    });

    it('resolves met-with-overshoot for EV when > 10 % above target', () => {
      const entry = buildEntry({
        outcome: 'met',
        objectiveKind: 'ev_soc',
        targetTemperatureC: null,
        targetPercent: 80,
        startProgressC: null,
        startProgressPercent: 30,
        finalProgressC: null,
        finalProgressPercent: 95, // 15 % overshoot — above the 10 % threshold.
        metAtMs: DEADLINE_MS - 2 * HOUR_MS,
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('met-with-overshoot');
    });

    it('falls back to a plain confirmation when metAtMs is missing on a met entry', () => {
      const entry = buildEntry({
        outcome: 'met',
        metAtMs: null,
        finalProgressC: 65,
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('met-with-margin');
      expect(result.sentence).toContain('65.0 °C');
      expect(result.sentence).toContain('before the deadline');
    });

    it('resolves met-by-stall when the recorder promoted on idle-classifier near_target_idle', () => {
      // Connected 300 regression: tank plateaued at 61.8 °C against a
      // 65 °C target. The metReason='stalled' marker carries the truth
      // that PELS accepted the run as done without crossing target.
      const entry = buildEntry({
        outcome: 'met',
        metReason: 'stalled',
        metAtMs: DEADLINE_MS - 3 * HOUR_MS,
        finalProgressC: 61.8,
        targetTemperatureC: 65,
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('met-by-stall');
      expect(result.sentence).toContain('61.8 °C');
      expect(result.sentence).toContain('65.0 °C');
      // Met-by-stall must not borrow the timing copy of margin/buzzer —
      // the timing math is irrelevant when the reason is "settled below".
      expect(result.sentence).not.toMatch(/before/);
    });

    it('stall postmortem ignores buzzer-window timing — the plateau, not the deadline gap, drives the variant', () => {
      // metAtMs lands 2 minutes before the deadline (would be at-buzzer
      // under the timing-only branch) but the stall promotion takes
      // precedence so the user reads the right cause.
      const entry = buildEntry({
        outcome: 'met',
        metReason: 'stalled',
        metAtMs: DEADLINE_MS - 2 * 60 * 1000,
        finalProgressC: 61.8,
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('met-by-stall');
    });

    it('met-by-stall sentence drops to a generic fallback when finalProgress is missing', () => {
      // Defensive: a legacy entry hand-rewritten without finalProgressC
      // should still get a sentence rather than throwing.
      const entry = buildEntry({
        outcome: 'met',
        metReason: 'stalled',
        metAtMs: DEADLINE_MS - HOUR_MS,
        finalProgressC: null,
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('met-by-stall');
      expect(result.sentence).toMatch(/PELS counted/);
    });

    it('preserves the legacy met-by-device-cap result recorded for capped_idle', () => {
      // Connected 300 capped-internally regression: tank parked at 58 °C
      // (7 °C gap from a 65 °C target) while power cycled around the
      // device's own anti-cycle hysteresis. The
      // metReason='stalled_device_capped' marker carries the fact that
      // PELS hit the device's own setpoint cap, not the PELS hard cap.
      const entry = buildEntry({
        outcome: 'met',
        metReason: 'stalled_device_capped',
        metAtMs: DEADLINE_MS - 3 * HOUR_MS,
        finalProgressC: 58,
        targetTemperatureC: 65,
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('met-by-device-cap');
      expect(result.sentence).toContain('58.0 °C');
      expect(result.sentence).toContain('65.0 °C');
      // The recourse text must name the device's own setpoint cap, not
      // the PELS-canonical hard cap (per
      // `feedback_hard_cap_is_physical.md`).
      expect(result.sentence).toContain('setpoint cap');
      expect(result.sentence).not.toContain('hard cap');
    });

    it('preserves a legacy EV result recorded as met at its car\'s own charge limit', () => {
      // Production, 2026-09-26: an 80 % task on a Polestar set to stop at 70 %.
      // Older PELS versions recorded this run as met there. Migration preserves
      // that historical result; new runs must still meet the requested target.
      const entry = buildEntry({
        objectiveKind: 'ev_soc',
        targetTemperatureC: null,
        targetPercent: 80,
        startProgressC: null,
        startProgressPercent: 53,
        finalProgressC: null,
        finalProgressPercent: 70,
        outcome: 'met',
        metReason: 'observed_limit',
        metAtMs: DEADLINE_MS - 2 * HOUR_MS,
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('met-at-car-limit');
      expect(result.sentence).toBe(
        "Your car stopped at its own charge limit of 70 %, below this smart task's 80 % target."
        + ' PELS counted the run as done.',
      );
    });

    it('met-by-device-cap sentence drops to a generic fallback when finalProgress is missing', () => {
      // Defensive: a legacy entry hand-rewritten without finalProgressC
      // should still get a sentence that names the device cap rather
      // than throwing.
      const entry = buildEntry({
        outcome: 'met',
        metReason: 'stalled_device_capped',
        metAtMs: DEADLINE_MS - HOUR_MS,
        finalProgressC: null,
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('met-by-device-cap');
      expect(result.sentence).toContain('setpoint cap');
      expect(result.sentence).not.toContain('hard cap');
    });
  });

  describe('missed outcome', () => {
    it('resolves the budget postmortem from recorded delivery evidence without a plan snapshot', () => {
      const entry: ResolvedDeferredObjectivePlanHistoryEntry = {
        ...buildEntry({ outcome: 'missed', finalProgressC: 38 }),
        deliveryExplanation: {
          kind: 'recorded', primary: { kind: 'blocked', cause: 'budget_limited' },
          contributors: [], intervals: [],
        },
      };
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('missed-by-budget-exhaustion');
      expect(result.sentence).toBe('The daily budget held delivery back before 16:00.');
    });

    it('retains factual timing for legacy budget-shaped snapshots without claiming a budget cause', () => {
      const entry = buildEntry({
        outcome: 'missed', finalProgressC: 38,
        finalPlan: buildSnapshot({ planStatus: 'cannot_meet', dailyBudgetExhaustedBucketCount: 4 }),
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('missed-by-shortfall');
      expect(result.sentence).toContain('38.0 °C by 16:00');
      expect(result.sentence).not.toContain('budget');
    });

    it('does not promote an earlier budget contribution above the final device blocker', () => {
      const entry: ResolvedDeferredObjectivePlanHistoryEntry = {
        ...buildEntry({
          outcome: 'missed', finalProgressC: 38,
          finalPlan: buildSnapshot({ planStatus: 'cannot_meet', dailyBudgetExhaustedBucketCount: 4 }),
        }),
        deliveryExplanation: {
          kind: 'recorded', primary: { kind: 'blocked', cause: 'device_not_accepting' },
          contributors: ['budget_limited'], intervals: [],
        },
      };
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('missed-by-shortfall');
      expect(result.sentence).toContain('38.0 °C by 16:00');
    });

    it('resolves missed-by-shortfall when budget is fine but progress did not reach target', () => {
      const entry = buildEntry({
        outcome: 'missed',
        finalProgressC: 38,
        targetTemperatureC: 65,
        finalPlan: buildSnapshot({
          planStatus: 'cannot_meet',
          // No `dailyBudgetExhaustedBucketCount` → not the budget branch.
        }),
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('missed-by-shortfall');
      expect(result.sentence).toMatch(/Reached 38\.0 °C/);
      expect(result.sentence).toMatch(/27\.0 °C short of 65\.0 °C/);
      expect(result.sentence).toContain('16:00');
    });

    it('describes a cooling miss as remaining above the target', () => {
      const entry = buildEntry({
        outcome: 'missed',
        progressDirection: 'decreasing',
        startProgressC: 30,
        finalProgressC: 26,
        targetTemperatureC: 22,
        finalPlan: buildSnapshot({ planStatus: 'cannot_meet' }),
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('missed-by-shortfall');
      expect(result.sentence).toContain('4.0 °C above 22.0 °C');
    });

    it('falls through to a plain shortfall sentence when the figures are missing', () => {
      const entry = buildEntry({
        outcome: 'missed',
        finalProgressC: null,
        targetTemperatureC: null,
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('missed-by-shortfall');
      expect(result.sentence).toContain('Did not reach the target');
    });
  });

  describe('abandoned outcome', () => {
    it('resolves abandoned-by-clear for outcome=replaced (user-swapped target/deadline)', () => {
      const finalizedAtMs = DEADLINE_MS - 12 * HOUR_MS - 12 * 60 * 1000; // 04:12 the day before
      const entry = buildEntry({
        outcome: 'replaced',
        finalizedAtMs,
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('abandoned-by-clear');
      expect(result.sentence).toContain('replaced');
    });

    // `outcome === 'abandoned'` covers both the stale-diagnostic timeout path
    // and the user-clear path; the schema can't distinguish them so the copy
    // names a probable behaviour without claiming a specific cause.
    it('resolves abandoned-by-unplug for outcome=abandoned on EV kind (charger or clear)', () => {
      const finalizedAtMs = DEADLINE_MS - 13 * HOUR_MS - 15 * 60 * 1000; // 02:45
      const entry = buildEntry({
        outcome: 'abandoned',
        objectiveKind: 'ev_soc',
        targetTemperatureC: null,
        targetPercent: 80,
        startProgressC: null,
        startProgressPercent: 30,
        finalProgressC: null,
        finalProgressPercent: 45,
        finalizedAtMs,
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('abandoned-by-unplug');
      expect(result.sentence).toMatch(/stopped/);
      expect(result.sentence).toMatch(/charger|cleared/);
    });

    it('resolves abandoned-by-unplug for outcome=abandoned on thermal kind', () => {
      const entry = buildEntry({
        outcome: 'abandoned',
        objectiveKind: 'temperature',
        finalizedAtMs: DEADLINE_MS - 8 * HOUR_MS,
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('abandoned-by-unplug');
      expect(result.sentence).toMatch(/stopped/);
      expect(result.sentence).toMatch(/device|cleared/);
    });
  });

  describe('legacy unknown outcome', () => {
    it('normalizes it to abandoned before consumers receive it', () => {
      const entry = buildEntry({
        outcome: 'unknown',
        discoveredFrom: 'backfill',
        finalProgressC: null,
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(entry.outcome).toBe('abandoned');
      expect(result.variant).toBe('abandoned-by-unplug');
    });
  });
});

describe('formatPlanHistoryMissedReason (recorded delivery explanation)', () => {
  const withRecordedCause = (
    entry: ResolvedDeferredObjectivePlanHistoryEntry,
    cause: TaskDeliveryCause,
    contributors: TaskDeliveryCause[] = [],
  ): ResolvedDeferredObjectivePlanHistoryEntry => ({
    ...entry,
    deliveryExplanation: {
      kind: 'recorded', primary: { kind: 'blocked', cause }, contributors,
      intervals: [{ fromMs: DEADLINE_MS - HOUR_MS, toMs: DEADLINE_MS, cause }],
    },
  });
  const legacyCopy = 'Delivery blockers were not recorded for this earlier task.';

  it.each([
    { planStatus: 'cannot_meet' as const, dailyBudgetExhaustedBucketCount: 3 },
    { planStatus: 'cannot_meet' as const, floorShortfallCause: 'time_capacity' as const },
    { planStatus: 'cannot_meet' as const, rateConfidence: 'low' as const, acceptedSamples: 3 },
  ])('does not turn an older plan snapshot into delivery evidence: %j', (snapshot) => {
    const entry = buildEntry({ outcome: 'missed', finalPlan: buildSnapshot(snapshot) });
    expect(entry.deliveryExplanation).toEqual({ kind: 'legacy_unrecorded' });
    expect(formatPlanHistoryMissedReason(entry)).toBe(legacyCopy);
  });

  it.each([0.9, 2.5])('does not guess a legacy cause from %s kWh against a 2 kWh estimate', (deliveredKWh) => {
    const entry = buildEntry({
      outcome: 'missed', deliveredKWh, initialEnergyExpectedKWh: 2,
      originalPlan: buildSnapshot({ planStatus: 'cannot_meet' }),
      finalPlan: buildSnapshot({ planStatus: 'cannot_meet', rateConfidence: 'high', acceptedSamples: 12 }),
    });
    expect(formatPlanHistoryMissedReason(entry)).toBe(legacyCopy);
  });

  it.each([
    ['budget_limited', 'The daily budget held delivery back.'],
    ['capacity_limited', 'Not enough available power held delivery back.'],
    ['estimate_uncertain', 'The energy estimate could not establish a feasible schedule.'],
    ['device_not_accepting', 'The device stopped taking power before reaching the target.'],
    ['device_limit', 'The car stopped at its own charge limit, below this smart task’s target.'],
  ] as const)('names the recorded %s cause regardless of plan snapshot or energy ratio', (cause, copy) => {
    const entry = withRecordedCause(buildEntry({
      outcome: 'missed', deliveredKWh: 0.9, initialEnergyExpectedKWh: 2,
      finalPlan: buildSnapshot({ planStatus: 'cannot_meet', rateConfidence: 'low', dailyBudgetExhaustedBucketCount: 3 }),
    }), cause);
    expect(formatPlanHistoryMissedReason(entry)).toBe(copy);
  });

  it('keeps the final device blocker primary and names the longest earlier restriction', () => {
    const entry = withRecordedCause(buildEntry({
      outcome: 'missed', deliveredKWh: 2.5,
      finalPlan: buildSnapshot({ planStatus: 'cannot_meet', dailyBudgetExhaustedBucketCount: 2 }),
    }), 'device_not_accepting', ['budget_limited', 'capacity_limited']);
    expect(formatPlanHistoryMissedReason(entry)).toBe(
      'The device stopped taking power before reaching the target.'
      + ' Earlier: The daily budget held delivery back.',
    );
  });

  it('reports an unmet target under permitted delivery without inventing an estimate or capacity cause', () => {
    const entry: ResolvedDeferredObjectivePlanHistoryEntry = {
      ...buildEntry({ outcome: 'missed', deliveredKWh: 2.5, initialEnergyExpectedKWh: 2 }),
      deliveryExplanation: { kind: 'recorded', primary: { kind: 'clear' }, contributors: [], intervals: [] },
    };
    expect(formatPlanHistoryMissedReason(entry)).toBe('The requested target was not reached during permitted delivery.');
  });

  it('keeps reason lines factual without recommending target or deadline changes', () => {
    const entry = buildEntry({ outcome: 'missed' });
    for (const cause of ['budget_limited', 'capacity_limited', 'device_limit'] as const) {
      const result = formatPlanHistoryMissedReason(withRecordedCause(entry, cause));
      expect(result).not.toBeNull();
      expect(result!.toLowerCase()).not.toContain('try lowering');
      expect(result!.toLowerCase()).not.toContain('moving the deadline');
      expect(result!.toLowerCase()).not.toContain('hard cap');
      expect(result!.toLowerCase()).not.toContain('raising');
    }
  });

  it('returns null for non-missed outcomes', () => {
    expect(formatPlanHistoryMissedReason(buildEntry({ outcome: 'met' }))).toBeNull();
    expect(formatPlanHistoryMissedReason(buildEntry({ outcome: 'abandoned' }))).toBeNull();
  });
});

describe('formatPlanHistoryOvershootLine', () => {
  it('renders the canonical Connected 300 overshoot from notes/smart-task-ui', () => {
    // Lived-state regression: the Wed 13 May 16:00 entry from the 2026-05-16
    // walk progressed 29.3 °C → 77.7 °C with a 65 °C target — 12.7 °C overshoot.
    // The shared-domain helper must surface that exact value so the past-list
    // card and the history-detail hero both read identically.
    const entry = buildEntry({
      outcome: 'met',
      objectiveKind: 'temperature',
      startProgressC: 29.3,
      finalProgressC: 77.7,
      targetTemperatureC: 65,
    });
    expect(formatPlanHistoryOvershootLine(entry)).toBe('Overshoot 12.7 °C');
  });

  it('renders a cooling overshoot below the target', () => {
    const entry = buildEntry({
      outcome: 'met',
      progressDirection: 'decreasing',
      startProgressC: 30,
      finalProgressC: 10,
      targetTemperatureC: 22,
    });
    expect(formatPlanHistoryOvershootLine(entry)).toBe('Overshoot 12.0 °C');
    expect(formatPlanHistoryPostmortem({
      ...entry,
      metAtMs: DEADLINE_MS - 2 * HOUR_MS,
    }, 'UTC').variant).toBe('met-with-overshoot');
  });

  it('returns null when temperature delta is at or below the 5 °C threshold', () => {
    // Threshold is strict (`> 5`), so exactly 5 °C overshoot stays muted.
    expect(formatPlanHistoryOvershootLine(buildEntry({
      outcome: 'met',
      finalProgressC: 70,
      targetTemperatureC: 65,
    }))).toBeNull();
    expect(formatPlanHistoryOvershootLine(buildEntry({
      outcome: 'met',
      finalProgressC: 64,
      targetTemperatureC: 65,
    }))).toBeNull();
  });

  it('renders an EV overshoot line with percent precision', () => {
    const entry = buildEntry({
      outcome: 'met',
      objectiveKind: 'ev_soc',
      targetTemperatureC: null,
      targetPercent: 80,
      startProgressC: null,
      startProgressPercent: 20,
      finalProgressC: null,
      finalProgressPercent: 95,
    });
    expect(formatPlanHistoryOvershootLine(entry)).toBe('Overshoot 15 %');
  });

  it('returns null for non-met outcomes even when readings exceed target', () => {
    const overshootButMissed = buildEntry({
      outcome: 'missed',
      finalProgressC: 80,
      targetTemperatureC: 65,
    });
    expect(formatPlanHistoryOvershootLine(overshootButMissed)).toBeNull();
  });

  it('returns null when final or target readings are missing', () => {
    expect(formatPlanHistoryOvershootLine(buildEntry({
      outcome: 'met',
      finalProgressC: null,
      targetTemperatureC: 65,
    }))).toBeNull();
    expect(formatPlanHistoryOvershootLine(buildEntry({
      outcome: 'met',
      finalProgressC: 80,
      targetTemperatureC: null,
    }))).toBeNull();
  });
});

describe('formatMissStreakAggregateLine', () => {
  const buildMissed = (id: string): ResolvedDeferredObjectivePlanHistoryEntry => (
    buildEntry({ id, deviceId: 'dev-1', outcome: 'missed' })
  );
  const buildMet = (id: string): ResolvedDeferredObjectivePlanHistoryEntry => (
    buildEntry({ id, deviceId: 'dev-1', outcome: 'met' })
  );

  it('renders the canonical 3-of-4-missed Connected 300 aggregate', () => {
    // Lived-state walk: Connected 300 had 3 missed in its 4 most-recent entries.
    // The aggregate line surfaces the pattern without forcing the user to count
    // chips by hand.
    const entries = [
      buildMet('e0'),    // most recent — met
      buildMissed('e1'),
      buildMissed('e2'),
      buildMissed('e3'),
      buildMet('e4'),    // older entry that shouldn't influence the window
    ];
    expect(formatMissStreakAggregateLine(entries, 'dev-1')).toBe('3 of last 4 runs missed');
  });

  it('returns null when the device has fewer than 2 history entries', () => {
    expect(formatMissStreakAggregateLine([buildMissed('e1')], 'dev-1')).toBeNull();
  });

  it('returns null when the miss share is below the threshold', () => {
    // 1 missed of 4 = 25 %, below the 50 % threshold → suppressed.
    const entries = [buildMet('e0'), buildMet('e1'), buildMet('e2'), buildMissed('e3')];
    expect(formatMissStreakAggregateLine(entries, 'dev-1')).toBeNull();
  });

  it('returns null when the requested device has no matching entries', () => {
    const entries = [buildMissed('e1'), buildMissed('e2')];
    expect(formatMissStreakAggregateLine(entries, 'other-device')).toBeNull();
  });

  it('only looks at the device-id-filtered subset of the most-recent 4 entries', () => {
    // Other-device misses should not pollute the streak window for dev-1.
    const entries = [
      buildEntry({ id: 'a', deviceId: 'other', outcome: 'missed' }),
      buildEntry({ id: 'b', deviceId: 'other', outcome: 'missed' }),
      buildEntry({ id: 'c', deviceId: 'dev-1', outcome: 'missed' }),
      buildEntry({ id: 'd', deviceId: 'dev-1', outcome: 'met' }),
    ];
    // dev-1 has 1 missed + 1 met in the window → 50 % triggers the aggregate.
    expect(formatMissStreakAggregateLine(entries, 'dev-1')).toBe('1 of last 2 runs missed');
  });
});

describe('formatPlanHistoryUsageDayLinkLabel', () => {
  it('renders household usage link copy for the selected date', () => {
    expect(formatPlanHistoryUsageDayLinkLabel('Connected 300', '16 May'))
      .toBe('See household usage on 16 May →');
  });

  it('keeps the household label when device name is missing', () => {
    expect(formatPlanHistoryUsageDayLinkLabel(null, '16 May'))
      .toBe('See household usage on 16 May →');
    expect(formatPlanHistoryUsageDayLinkLabel('   ', '16 May'))
      .toBe('See household usage on 16 May →');
  });
});

// Regression: PR-8 of the v2.7.x smart-tasks polish train.
//
// `formatPlanHistoryProgressLine` historically rendered `start → final · target`
// on every outcome shape. On `'abandoned'` / `'replaced'` entries the persisted
// `finalProgressC` / `finalProgressPercent` is the reading at the moment the
// user cleared the smart task (or the diagnostic stream went stale) — not the
// result of any PELS-driven heating/charging. The arrow read as "we moved the
// needle from X to Y", which inverted the truth (no progress is attributable
// to PELS on those outcomes).
//
// The producer now suppresses the `→ final` segment on those two outcomes
// while keeping the start reading + target so the user still has context.
// Succeeded / Missed keep the arrow — the final reading is meaningful there.
describe('formatPlanHistoryProgressLine', () => {
  it('keeps the start → final · target arrow on Succeeded runs', () => {
    expect(formatPlanHistoryProgressLine(buildEntry({
      outcome: 'met',
      startProgressC: 50,
      finalProgressC: 65,
      targetTemperatureC: 65,
    }))).toBe('50.0 °C → 65.0 °C  ·  target 65.0 °C');
  });

  it('floors the displayed end at target on a met-then-cooled Succeeded run', () => {
    // Lived prod walk: a tank met its 06:00 deadline early (reached at 03:42)
    // then cooled to 39.2 °C by the window end. The raw `64.0 → 39.2 · target
    // 65.0` arrow read as a drop next to "Succeeded"; the run did reach target,
    // so the honest summary lifts the end to the target.
    expect(formatPlanHistoryProgressLine(buildEntry({
      outcome: 'met',
      startProgressC: 64,
      finalProgressC: 39.2,
      targetTemperatureC: 65,
    }))).toBe('64.0 °C → 65.0 °C  ·  target 65.0 °C');
  });

  it('floors the displayed end at target on a met cooling run that later warmed', () => {
    expect(formatPlanHistoryProgressLine(buildEntry({
      outcome: 'met',
      progressDirection: 'decreasing',
      startProgressC: 30,
      finalProgressC: 25,
      targetTemperatureC: 22,
    }))).toBe('30.0 °C → 22.0 °C  ·  target 22.0 °C');
  });

  it('does NOT floor a stall-promoted met (the plateau below target is intentional)', () => {
    // `metReason: 'stalled'` means the device plateaued below target and we
    // accepted it as met; the detail postmortem leads with that accepted
    // plateau, so flooring the list row to target would invent a reading the
    // device never hit. The real final is preserved.
    expect(formatPlanHistoryProgressLine(buildEntry({
      outcome: 'met',
      metReason: 'stalled',
      startProgressC: 50,
      finalProgressC: 61.8,
      targetTemperatureC: 65,
    }))).toBe('50.0 °C → 61.8 °C  ·  target 65.0 °C');
  });

  it('does NOT floor a device-capped met (setpoint cap plateau is intentional)', () => {
    expect(formatPlanHistoryProgressLine(buildEntry({
      outcome: 'met',
      metReason: 'stalled_device_capped',
      startProgressC: 50,
      finalProgressC: 58,
      targetTemperatureC: 65,
    }))).toBe('50.0 °C → 58.0 °C  ·  target 65.0 °C');
  });

  it('leaves an overshoot final untouched on Succeeded runs (only sub-target finals lift)', () => {
    // `final > target` is meaningful (the overshoot line surfaces the magnitude
    // separately), so the displayed end stays at the real reading.
    expect(formatPlanHistoryProgressLine(buildEntry({
      outcome: 'met',
      startProgressC: 29.3,
      finalProgressC: 77.7,
      targetTemperatureC: 65,
    }))).toBe('29.3 °C → 77.7 °C  ·  target 65.0 °C');
  });

  it('floors the displayed end at target on a met-then-discharged EV run', () => {
    expect(formatPlanHistoryProgressLine(buildEntry({
      outcome: 'met',
      objectiveKind: 'ev_soc',
      targetTemperatureC: null,
      targetPercent: 80,
      startProgressC: null,
      startProgressPercent: 60,
      finalProgressC: null,
      finalProgressPercent: 72,
    }))).toBe('60 % → 80 %  ·  target 80 %');
  });

  it('keeps the arrow on Missed runs (final reading is meaningful)', () => {
    expect(formatPlanHistoryProgressLine(buildEntry({
      outcome: 'missed',
      startProgressC: 50,
      finalProgressC: 58,
      targetTemperatureC: 65,
    }))).toBe('50.0 °C → 58.0 °C  ·  target 65.0 °C');
  });

  it('suppresses the → final segment on Abandoned temperature runs', () => {
    // Lived-state example: an Abandoned thermostat run that read 57.6 °C when
    // the user cleared the smart task, target 40 °C. Pre-fix the arrow read
    // "57.6 → 26.0 °C", implying PELS cooled the device — the cooling came
    // from ambient drift, not the planner.
    expect(formatPlanHistoryProgressLine(buildEntry({
      outcome: 'abandoned',
      startProgressC: 57.6,
      finalProgressC: 26.0,
      targetTemperatureC: 40,
    }))).toBe('57.6 °C  ·  target 40.0 °C');
  });

  it('suppresses the → final segment on Replaced temperature runs', () => {
    // `'replaced'` covers the user-swapped path (target / deadline changed
    // mid-run); same treatment as `'abandoned'` — no PELS-driven progress
    // happened on the previous configuration.
    expect(formatPlanHistoryProgressLine(buildEntry({
      outcome: 'replaced',
      startProgressC: 50,
      finalProgressC: 38,
      targetTemperatureC: 65,
    }))).toBe('50.0 °C  ·  target 65.0 °C');
  });

  it('suppresses the → final segment on Abandoned EV runs', () => {
    expect(formatPlanHistoryProgressLine(buildEntry({
      outcome: 'abandoned',
      objectiveKind: 'ev_soc',
      targetTemperatureC: null,
      targetPercent: 80,
      startProgressC: null,
      startProgressPercent: 35,
      finalProgressC: null,
      finalProgressPercent: 42,
    }))).toBe('35 %  ·  target 80 %');
  });

  it('returns null when start or target is missing (every outcome)', () => {
    expect(formatPlanHistoryProgressLine(buildEntry({
      outcome: 'abandoned',
      startProgressC: null,
      finalProgressC: 26,
      targetTemperatureC: 40,
    }))).toBeNull();
    expect(formatPlanHistoryProgressLine(buildEntry({
      outcome: 'met',
      startProgressC: 50,
      finalProgressC: 65,
      targetTemperatureC: null,
    }))).toBeNull();
  });
});

// List-row cost producer — WHOLE-kroner `Cost ≈ X kr · Y kWh delivered`. Renders
// at the same precision as the ISO-week divider roll-up (`Math.round`) and the
// detail cost chip, never the 2-decimal Missed-fallback form. The persisted
// `totalCost` is RAW minor-unit (øre for the default kr/100 scheme); the
// producer scales by the `CostDisplay.divisor` before rounding — without that
// scaling raw øre is labelled kr and reads ~100× too high. Branch matrix:
// cost+delivery, cost-only, delivery-only, empty-unit, neither (null), rounding,
// divisor scaling.
// All cost surfaces now scale + label from the entry's RECORDED `costDisplay`
// (legacy entries fall back to the recording-era øre/kr default), so the figure
// survives a later price-scheme switch and no live unit/divisor is threaded in.
const ORE_KR = { unit: 'kr', divisor: 100 } as const;
describe('formatPlanHistoryListCostAndDelivered', () => {
  it('renders cost in whole kroner joined with delivered kWh (øre scaled by recorded divisor 100)', () => {
    expect(
      formatPlanHistoryListCostAndDelivered(
        { totalCost: 1234, deliveredKWh: 18.2, costDisplay: ORE_KR },
      ),
    ).toBe('Cost ≈ 12 kr · 18.2 kWh delivered');
  });

  it('applies the recorded divisor — 150 øre @ divisor 100 reads "≈ 2 kr", not "≈ 150 kr"', () => {
    // The P1 money bug guard at the producer boundary: 150 øre / 100 = 1.5 →
    // Math.round → 2 kr. Dropping the divisor would render "≈ 150 kr".
    expect(
      formatPlanHistoryListCostAndDelivered(
        { totalCost: 150, deliveredKWh: 1.5, costDisplay: ORE_KR },
      ),
    ).toBe('Cost ≈ 2 kr · 1.5 kWh delivered');
  });

  it('falls back to the recording-era øre/kr default for a legacy entry with no costDisplay', () => {
    // The core fix: a legacy øre entry (no recorded display) must assume øre/kr,
    // NOT a live divisor. 150 øre → ≈ 2 kr.
    expect(
      formatPlanHistoryListCostAndDelivered(
        { totalCost: 150, deliveredKWh: 1.5 },
      ),
    ).toBe('Cost ≈ 2 kr · 1.5 kWh delivered');
  });

  it('honours a recorded Flow display (divisor 1) — 12 EUR reads "≈ 12 EUR", never scaled as øre', () => {
    expect(
      formatPlanHistoryListCostAndDelivered(
        { totalCost: 12, deliveredKWh: 4, costDisplay: { unit: 'EUR', divisor: 1 } },
      ),
    ).toBe('Cost ≈ 12 EUR · 4.0 kWh delivered');
  });

  it('rounds to whole kroner (matches the week-divider rounding)', () => {
    expect(
      formatPlanHistoryListCostAndDelivered(
        { totalCost: 1262, deliveredKWh: 4, costDisplay: ORE_KR },
      ),
    ).toBe('Cost ≈ 13 kr · 4.0 kWh delivered');
  });

  it('drops the cost clause when the recorded unit is empty but delivery is recorded', () => {
    expect(
      formatPlanHistoryListCostAndDelivered(
        { totalCost: 1234, deliveredKWh: 18.2, costDisplay: { unit: '', divisor: 1 } },
      ),
    ).toBe('18.2 kWh delivered');
  });

  it('renders cost-only when delivery is not recorded', () => {
    // 950 øre / 100 = 9.5 → Math.round → 10 kr.
    expect(
      formatPlanHistoryListCostAndDelivered(
        { totalCost: 950, deliveredKWh: undefined, costDisplay: ORE_KR },
      ),
    ).toBe('Cost ≈ 10 kr');
  });

  it('returns null when neither cost nor delivery was recorded', () => {
    expect(
      formatPlanHistoryListCostAndDelivered(
        { totalCost: undefined, deliveredKWh: undefined },
      ),
    ).toBeNull();
  });

  it('strips a rate-shaped recorded unit so a TOTAL reads "kr", not "kr/kWh"', () => {
    // Flow/Homey schemes record their raw price-RATE label (`kr/kWh`). A total
    // cost is an amount, so the row must drop the `/kWh` suffix — otherwise it
    // labels an amount as a per-kWh rate.
    const line = formatPlanHistoryListCostAndDelivered(
      { totalCost: 12, deliveredKWh: 4, costDisplay: { unit: 'kr/kWh', divisor: 1 } },
    );
    expect(line).toBe('Cost ≈ 12 kr · 4.0 kWh delivered');
    expect(line).not.toContain('kr/kWh');
  });

  it('tolerates whitespace in the recorded rate suffix (" NOK / kWh " → "NOK")', () => {
    const line = formatPlanHistoryListCostAndDelivered(
      { totalCost: 9, deliveredKWh: 3, costDisplay: { unit: ' NOK / kWh ', divisor: 1 } },
    );
    expect(line).toBe('Cost ≈ 9 NOK · 3.0 kWh delivered');
    expect(line).not.toContain('NOK /');
    expect(line).not.toContain('/ kWh');
  });
});

describe('formatPlanHistoryCostAndDelivered (hero 2-decimal total)', () => {
  it('scales by the recorded divisor — 1230 øre @ divisor 100 reads "≈ 12.30 kr"', () => {
    // The 2-decimal Missed-hero fallback must also honour the recorded display:
    // raw øre persisted under divisor 100 must divide to kr, not render raw.
    const line = formatPlanHistoryCostAndDelivered(
      { totalCost: 1230, deliveredKWh: 4, costDisplay: ORE_KR },
      '',
    );
    expect(line).toBe('Cost ≈ 12.30 kr · 4.0 kWh delivered');
  });

  it('strips a rate-shaped recorded unit so the TOTAL reads "kr", not "kr/kWh"', () => {
    const line = formatPlanHistoryCostAndDelivered(
      { totalCost: 12.3, deliveredKWh: 4, costDisplay: { unit: 'kr/kWh', divisor: 1 } },
      '',
    );
    expect(line).toBe('Cost ≈ 12.30 kr · 4.0 kWh delivered');
    expect(line).not.toContain('kr/kWh');
  });
});

// Row ↔ week-divider agreement: the same RAW øre money must read identically on
// the per-row cost line and the ISO-week roll-up heading once both scale by the
// entry's recorded divisor. A single entry isolates the scaling: a regression
// that scales one surface but not the other (the original P1 shape) diverges.
describe('list-row cost ↔ week-divider roll-up agreement (recorded display on both)', () => {
  const TZ = 'Europe/Oslo';
  const DEADLINE_MS = Date.UTC(2026, 4, 6, 6, 0, 0);

  const buildCostEntry = (
    totalCost: number,
    costDisplay?: DeferredObjectivePlanHistoryEntry['costDisplay'],
  ): ResolvedDeferredObjectivePlanHistoryEntry => toResolvedLegacyPlanHistoryEntry({
    id: `entry-${totalCost}`,
    originalPlan: null,
    finalPlan: null,
    deviceId: 'dev_cost',
    deviceName: 'Connected 300',
    objectiveKind: 'temperature',
    targetTemperatureC: 65,
    targetPercent: null,
    deadlineAtMs: DEADLINE_MS,
    startedAtMs: DEADLINE_MS - 6 * 3_600_000,
    finalizedAtMs: DEADLINE_MS,
    startProgressC: 50,
    startProgressPercent: null,
    finalProgressC: 65,
    finalProgressPercent: null,
    initialEnergyNeededKWh: 22.5,
    outcome: 'met',
    metAtMs: DEADLINE_MS,
    usedDeadlineReserve: false,
    observedIntervals: [],
    discoveredFrom: 'observation',
    totalCost,
    deliveredKWh: 1.5,
    ...(costDisplay ? { costDisplay } : {}),
  });

  it('row "≈ 2 kr" matches the single-entry week-divider "≈ 2 kr" for 150 øre @ recorded divisor 100', () => {
    const entry = buildCostEntry(150, ORE_KR);
    const rowCost = formatPlanHistoryListCostAndDelivered(entry);
    const [group] = groupPlanHistoryByIsoWeek([entry], TZ, DEADLINE_MS);
    expect(rowCost).toContain('≈ 2 kr');
    expect(group?.heading).toContain('≈ 2 kr');
    // Neither labels raw øre as kr.
    expect(rowCost).not.toContain('150 kr');
    expect(group?.heading).not.toContain('150 kr');
  });

  it('legacy entry (no recorded display) agrees on the øre/kr fallback for row + roll-up', () => {
    const entry = buildCostEntry(150);
    const rowCost = formatPlanHistoryListCostAndDelivered(entry);
    const [group] = groupPlanHistoryByIsoWeek([entry], TZ, DEADLINE_MS);
    expect(rowCost).toContain('≈ 2 kr');
    expect(group?.heading).toContain('≈ 2 kr');
  });

  it('strips a rate-shaped recorded unit from the week-divider roll-up too ("kr/kWh" → "kr")', () => {
    // Flow/Homey total: divisor 1, recorded rate label `kr/kWh`. The heading
    // total is an amount, so it must read `≈ 12 kr`, never `≈ 12 kr/kWh`.
    const entry = buildCostEntry(12, { unit: 'kr/kWh', divisor: 1 });
    const [group] = groupPlanHistoryByIsoWeek([entry], TZ, DEADLINE_MS);
    expect(group?.heading).toContain('≈ 12 kr');
    expect(group?.heading).not.toContain('kr/kWh');
  });

  it('rolls up a mixed-scheme week by scaling each entry with its own recorded divisor', () => {
    // One øre/÷100 run (150 øre → 2 kr) + one Flow/÷1 run (3 kr → 3 kr) in the
    // same week. Summing the RAW totals (153) under a single divisor would
    // mislabel the roll-up; per-entry scaling gives the honest 2 + 3 = 5 kr.
    const oreEntry = buildCostEntry(150, ORE_KR);
    const flowEntry = { ...buildCostEntry(3, { unit: 'kr', divisor: 1 }), id: 'entry-flow' };
    const [group] = groupPlanHistoryByIsoWeek([oreEntry, flowEntry], TZ, DEADLINE_MS);
    expect(group?.heading).toContain('≈ 5 kr');
  });
});
