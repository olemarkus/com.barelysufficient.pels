// Unit tests for the smart-task history-detail postmortem resolver (v2.7.2 PR 3).
// Six outcome-shaped variants split across `met` / `missed` / `abandoned`
// + `unknown` fallback. Each test constructs a minimal entry and asserts
// the resolved variant slug + sentence shape so the asymmetric history hero
// can rely on `lead.sentence` without re-checking outcome.
//
// v2.7.2 PR 6 extends coverage to two list-level helpers added in the same
// train: `formatPlanHistoryOvershootLine` (Succeeded entries that overshot
// by > 5 °C / > 10 %) and `formatMissStreakAggregateLine` (recovering-from-
// mistake aggregate on the past-tasks landing surface).
import {
  formatMissStreakAggregateLine,
  formatPlanHistoryMissedReason,
  formatPlanHistoryOvershootLine,
  formatPlanHistoryPostmortem,
  formatPlanHistoryProgressLine,
  formatPlanHistoryUsageDayLinkLabel,
} from '../packages/shared-domain/src/deferredPlanHistory';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
} from '../packages/contracts/src/deferredObjectivePlanHistory';

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
): DeferredObjectivePlanHistoryEntry => ({
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
  usedPolicyAvoid: false,
  observedIntervals: [],
  discoveredFrom: 'observation',
  originalPlan: null,
  finalPlan: null,
  ...overrides,
});

describe('formatPlanHistoryPostmortem', () => {
  describe('met outcome', () => {
    it('resolves met-with-margin when the run reached the target well before the deadline', () => {
      // Reached the target 4h 3m before the deadline (16:00) → margin variant.
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
      expect(result.sentence).toMatch(/4h 3m/);
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
      expect(result.sentence).toMatch(/2m before/);
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
      expect(result.sentence).toMatch(/^Hit .* at .*, before .*\.$/);
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

    it('resolves met-by-device-cap when classifier promoted via capped_idle', () => {
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
    it('resolves missed-by-budget-exhaustion when the final snapshot reports budget cap collapse', () => {
      const entry = buildEntry({
        outcome: 'missed',
        finalProgressC: 38,
        finalPlan: buildSnapshot({
          planStatus: 'cannot_meet',
          dailyBudgetExhaustedBucketCount: 4,
        }),
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('missed-by-budget-exhaustion');
      expect(result.sentence).toContain('daily energy budget');
      expect(result.sentence).toContain('16:00');
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

  describe('unknown outcome', () => {
    it('resolves unknown variant for backfill-discovered entries', () => {
      const entry = buildEntry({
        outcome: 'unknown',
        discoveredFrom: 'backfill',
        finalProgressC: null,
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('unknown');
      expect(result.sentence).toContain('reconstructed from settings');
    });

    it('returns a non-null sentence for unknown outcomes that are not backfill-derived', () => {
      const entry = buildEntry({
        outcome: 'unknown',
        discoveredFrom: 'observation',
        finalProgressC: null,
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('unknown');
      expect(result.sentence.length).toBeGreaterThan(0);
    });

    // PR #1074 follow-up: hero re-shows the collapsed chart card when a plan
    // was recorded, so the postmortem sentence must bridge to the "View
    // details" affordance rather than stop at the bare "could not determine"
    // fallback. The no-plan branch keeps the original wording so the
    // single-sentence hero shape stays byte-identical.
    it('keeps the bare "could not determine" sentence when no plan was recorded', () => {
      const entry = buildEntry({
        outcome: 'unknown',
        discoveredFrom: 'observation',
        finalProgressC: null,
        originalPlan: null,
        finalPlan: null,
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('unknown');
      expect(result.sentence).toBe('PELS could not determine how this smart task finished.');
    });

    it('previews the recorded plan in the sentence when originalPlan or finalPlan is present', () => {
      const entry = buildEntry({
        outcome: 'unknown',
        discoveredFrom: 'observation',
        finalProgressC: null,
        originalPlan: buildSnapshot(),
        finalPlan: null,
      });
      const result = formatPlanHistoryPostmortem(entry, 'UTC');
      expect(result.variant).toBe('unknown');
      expect(result.sentence).toBe(
        "PELS made a plan for this smart task but couldn't observe how it finished.",
      );
    });
  });
});

describe('formatPlanHistoryMissedReason (v2.7.3 blameless rewrite)', () => {
  it('returns a daily-budget-pointing sentence when the final snapshot reports budget exhaustion', () => {
    const entry = buildEntry({
      outcome: 'missed',
      finalPlan: buildSnapshot({
        planStatus: 'cannot_meet',
        dailyBudgetExhaustedBucketCount: 3,
      }),
    });
    const result = formatPlanHistoryMissedReason(entry);
    expect(result).not.toBeNull();
    expect(result).toContain('Daily budget');
  });

  it('blameless rewrite — does not recommend lowering the target or moving the deadline', () => {
    // Recourse copy lives on the recourse button; the Why line must not
    // duplicate it. Per `feedback_hard_cap_is_physical.md` no branch
    // suggests raising the cap either.
    const budgetEntry = buildEntry({
      outcome: 'missed',
      finalPlan: buildSnapshot({
        planStatus: 'cannot_meet',
        dailyBudgetExhaustedBucketCount: 3,
      }),
    });
    const cannotEntry = buildEntry({
      outcome: 'missed',
      finalPlan: buildSnapshot({ planStatus: 'cannot_meet' }),
    });
    for (const result of [
      formatPlanHistoryMissedReason(budgetEntry),
      formatPlanHistoryMissedReason(cannotEntry),
    ]) {
      expect(result).not.toBeNull();
      expect(result!.toLowerCase()).not.toContain('try lowering');
      expect(result!.toLowerCase()).not.toContain('moving the deadline');
      expect(result!.toLowerCase()).not.toContain('hard cap');
      expect(result!.toLowerCase()).not.toContain('raising');
    }
  });

  it('keeps the cannot_meet fallback sentence when no budget exhaustion is recorded', () => {
    const entry = buildEntry({
      outcome: 'missed',
      finalPlan: buildSnapshot({
        planStatus: 'cannot_meet',
        // No `dailyBudgetExhaustedBucketCount` → cannot_meet fallback branch.
      }),
    });
    const result = formatPlanHistoryMissedReason(entry);
    expect(result).toBe("Couldn't reserve enough cheap hours in time.");
  });

  it('returns null for non-missed outcomes', () => {
    expect(formatPlanHistoryMissedReason(buildEntry({ outcome: 'met' }))).toBeNull();
    expect(formatPlanHistoryMissedReason(buildEntry({ outcome: 'abandoned' }))).toBeNull();
  });

  // v2.7.4 — plan-time miss attribution (Session A) refines the Why line for
  // the two causes the planStatus alone can't tell apart.
  it('names the still-learning estimate ahead of the cannot_meet fallback', () => {
    const entry = buildEntry({
      outcome: 'missed',
      deliveredKWh: 2.5,
      finalPlan: buildSnapshot({
        planStatus: 'cannot_meet',
        rateConfidence: 'low',
        acceptedSamples: 3,
      }),
    });
    expect(formatPlanHistoryMissedReason(entry)).toBe(
      "Still learning this device's energy use (3 readings).",
    );
  });

  it('names an energy underestimate when delivery met the planned floor but missed', () => {
    const entry = buildEntry({
      outcome: 'missed',
      deliveredKWh: 2.5, // ≥ planned 2.0 → power was available.
      finalPlan: buildSnapshot({
        planStatus: 'cannot_meet',
        rateConfidence: 'high',
        acceptedSamples: 12,
      }),
    });
    expect(formatPlanHistoryMissedReason(entry)).toBe(
      'Target needed more energy than estimated.',
    );
  });

  it('budget exhaustion still outranks the attribution refinement', () => {
    const entry = buildEntry({
      outcome: 'missed',
      deliveredKWh: 2.5,
      finalPlan: buildSnapshot({
        planStatus: 'cannot_meet',
        dailyBudgetExhaustedBucketCount: 2,
        rateConfidence: 'low',
        acceptedSamples: 3,
      }),
    });
    expect(formatPlanHistoryMissedReason(entry)).toContain('Daily budget');
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
  const buildMissed = (id: string): DeferredObjectivePlanHistoryEntry => (
    buildEntry({ id, deviceId: 'dev-1', outcome: 'missed' })
  );
  const buildMet = (id: string): DeferredObjectivePlanHistoryEntry => (
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
