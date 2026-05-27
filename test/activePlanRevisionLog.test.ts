// Unit tests for `buildActivePlanRevisionLog` — the producer-side helper
// that resolves the smart-task detail page's inline revision panel rows
// from the live active plan's `latest` + `history`.
import {
  buildActivePlanRevisionLog,
} from '../packages/shared-domain/src/activePlanRevisionLog';
import type {
  DeferredObjectiveActivePlanRevisionV1,
} from '../packages/contracts/src/deferredObjectiveActivePlans';

const HOUR_MS = 60 * 60 * 1000;
const TZ = 'Europe/Oslo';

const revision = (
  overrides: Partial<DeferredObjectiveActivePlanRevisionV1> = {},
): DeferredObjectiveActivePlanRevisionV1 => ({
  revision: 1,
  revisedAtMs: HOUR_MS,
  computedFromPricesUpTo: 6 * HOUR_MS,
  reason: 'flow_card',
  hours: [{ startsAtMs: 2 * HOUR_MS, plannedKWh: 1.5 }],
  energyNeededKWh: 1.5,
  planStatus: 'on_track',
  ...overrides,
});

describe('buildActivePlanRevisionLog', () => {
  it('returns an empty array when there is no latest revision', () => {
    const rows = buildActivePlanRevisionLog({
      latest: null,
      history: undefined,
      timeZone: TZ,
      kind: 'temperature',
    });
    expect(rows).toEqual([]);
  });

  it('returns a single row when only the latest revision exists (no history)', () => {
    const rows = buildActivePlanRevisionLog({
      latest: revision({ revision: 1, reason: 'flow_card' }),
      history: undefined,
      timeZone: TZ,
      kind: 'temperature',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      revision: 1,
      reason: 'Updated by a Flow card',
      hourDiff: null,
    });
  });

  it('lists revisions most-recent first with latest at the head', () => {
    const rows = buildActivePlanRevisionLog({
      latest: revision({ revision: 3, reason: 'schedule_revised', revisedAtMs: 3 * HOUR_MS }),
      history: [
        revision({ revision: 2, reason: 'prices_arrived', revisedAtMs: 2 * HOUR_MS }),
        revision({ revision: 1, reason: 'flow_card', revisedAtMs: HOUR_MS }),
      ],
      timeZone: TZ,
      kind: 'temperature',
    });
    expect(rows.map((r) => r.revision)).toEqual([3, 2, 1]);
    expect(rows.map((r) => r.reason)).toEqual([
      'Schedule revised',
      'Prices arrived',
      'Updated by a Flow card',
    ]);
  });

  it('renders an hour-diff string comparing each row against the prior revision', () => {
    // Latest adds hour 5 on top of revision 2 (which had hours 2, 3).
    // Revision 2 removed hour 1 from revision 1 (which had hours 1, 2, 3).
    const rows = buildActivePlanRevisionLog({
      latest: revision({
        revision: 3,
        reason: 'schedule_revised',
        revisedAtMs: 3 * HOUR_MS,
        hours: [
          { startsAtMs: 2 * HOUR_MS, plannedKWh: 1 },
          { startsAtMs: 3 * HOUR_MS, plannedKWh: 1 },
          { startsAtMs: 5 * HOUR_MS, plannedKWh: 1 },
        ],
      }),
      history: [
        revision({
          revision: 2,
          reason: 'schedule_revised',
          revisedAtMs: 2 * HOUR_MS,
          hours: [
            { startsAtMs: 2 * HOUR_MS, plannedKWh: 1 },
            { startsAtMs: 3 * HOUR_MS, plannedKWh: 1 },
          ],
        }),
        revision({
          revision: 1,
          reason: 'flow_card',
          revisedAtMs: HOUR_MS,
          hours: [
            { startsAtMs: HOUR_MS, plannedKWh: 1 },
            { startsAtMs: 2 * HOUR_MS, plannedKWh: 1 },
            { startsAtMs: 3 * HOUR_MS, plannedKWh: 1 },
          ],
        }),
      ],
      timeZone: TZ,
      kind: 'temperature',
    });
    expect(rows[0]?.hourDiff).toBe('+1h');
    expect(rows[1]?.hourDiff).toBe('−1h');
    expect(rows[2]?.hourDiff).toBeNull();
  });

  it('renders null hourDiff when a revision only redistributed kWh across the same hours', () => {
    const rows = buildActivePlanRevisionLog({
      latest: revision({
        revision: 2,
        revisedAtMs: 2 * HOUR_MS,
        reason: 'rate_refined',
        hours: [
          { startsAtMs: HOUR_MS, plannedKWh: 1.0 },
          { startsAtMs: 2 * HOUR_MS, plannedKWh: 0.5 },
        ],
      }),
      history: [
        revision({
          revision: 1,
          reason: 'flow_card',
          hours: [
            { startsAtMs: HOUR_MS, plannedKWh: 0.7 },
            { startsAtMs: 2 * HOUR_MS, plannedKWh: 0.8 },
          ],
        }),
      ],
      timeZone: TZ,
      kind: 'temperature',
    });
    expect(rows[0]?.hourDiff).toBeNull();
  });

  it('falls back to "—" timeLabel when revisedAtMs is non-finite (defensive against corrupt persistence)', () => {
    const rows = buildActivePlanRevisionLog({
      latest: revision({ revision: 1, revisedAtMs: Number.NaN }),
      history: undefined,
      timeZone: TZ,
      kind: 'temperature',
    });
    expect(rows[0]?.timeLabel).toBe('—');
  });

  it('marks isFallback=false on rows with known reason codes', () => {
    const rows = buildActivePlanRevisionLog({
      latest: revision({ revision: 1, reason: 'flow_card' }),
      history: undefined,
      timeZone: TZ,
      kind: 'temperature',
    });
    expect(rows[0]?.isFallback).toBe(false);
  });

  it('marks isFallback=true when the recorder ships an unknown reason code', () => {
    // Cast through unknown — the contract type is a union, but the resolver
    // intentionally accepts string so persisted plans with a recorder code
    // newer than the running settings UI don't drop rows.
    const rows = buildActivePlanRevisionLog({
      latest: revision({ revision: 1, reason: 'newly_added_recorder_code' as never }),
      history: undefined,
      timeZone: TZ,
      kind: 'temperature',
    });
    expect(rows[0]?.isFallback).toBe(true);
    expect(rows[0]?.reason).toBe('Plan refreshed');
  });
});

describe('buildActivePlanRevisionLog schedule_revised disambiguation', () => {
  // All disambiguation paths share the same fixture shape — two revisions
  // where the latest is `schedule_revised` and only the disambiguation
  // signals vary. Keeps each test focused on which signal drives which label.
  const priorRev = revision({
    revision: 1,
    reason: 'flow_card',
    revisedAtMs: HOUR_MS,
    planStatus: 'on_track',
    hours: [{ startsAtMs: 2 * HOUR_MS, plannedKWh: 1 }],
  });

  it('emits "daily budget shifted" when dailyBudgetExhaustedBucketCount > 0', () => {
    const rows = buildActivePlanRevisionLog({
      latest: revision({
        revision: 2,
        reason: 'schedule_revised',
        revisedAtMs: 2 * HOUR_MS,
        hours: [{ startsAtMs: 2 * HOUR_MS, plannedKWh: 1 }],
        dailyBudgetExhaustedBucketCount: 3,
      }),
      history: [priorRev],
      timeZone: TZ,
      kind: 'temperature',
    });
    expect(rows[0]?.reason).toBe('Schedule revised — daily budget shifted');
  });

  it('emits "daily budget shifted" when floorShortfallCause is "budget" even with zero exhausted buckets (per-bucket squeeze case)', () => {
    const rows = buildActivePlanRevisionLog({
      latest: revision({
        revision: 2,
        reason: 'schedule_revised',
        revisedAtMs: 2 * HOUR_MS,
        hours: [{ startsAtMs: 2 * HOUR_MS, plannedKWh: 1 }],
        dailyBudgetExhaustedBucketCount: 0,
        floorShortfallCause: 'budget',
      }),
      history: [priorRev],
      timeZone: TZ,
      kind: 'temperature',
    });
    expect(rows[0]?.reason).toBe('Schedule revised — daily budget shifted');
  });

  it('emits "risk changed" when planStatus transitioned and no budget signal is set', () => {
    const rows = buildActivePlanRevisionLog({
      latest: revision({
        revision: 2,
        reason: 'schedule_revised',
        revisedAtMs: 2 * HOUR_MS,
        planStatus: 'at_risk',
        hours: [{ startsAtMs: 2 * HOUR_MS, plannedKWh: 1 }],
      }),
      history: [priorRev], // priorRev.planStatus === 'on_track'
      timeZone: TZ,
      kind: 'temperature',
    });
    expect(rows[0]?.reason).toBe('Schedule revised — risk changed');
  });

  it('emits "cheaper hour opened" when hours grew with no budget pressure and no risk transition', () => {
    const rows = buildActivePlanRevisionLog({
      latest: revision({
        revision: 2,
        reason: 'schedule_revised',
        revisedAtMs: 2 * HOUR_MS,
        planStatus: 'on_track',
        hours: [
          { startsAtMs: 2 * HOUR_MS, plannedKWh: 1 },
          { startsAtMs: 3 * HOUR_MS, plannedKWh: 1 },
        ],
      }),
      history: [priorRev], // priorRev has only the [2*HOUR_MS] bucket
      timeZone: TZ,
      kind: 'temperature',
    });
    expect(rows[0]?.reason).toBe('Schedule revised — cheaper hour opened');
  });

  it('falls through to bare "Schedule revised" when no disambiguation signal is conclusive', () => {
    // Same hours, same planStatus, no budget pressure — recorder fired the
    // reason but the signals we carry don't resolve to one of the variants.
    // Better to under-promise than mislabel.
    const rows = buildActivePlanRevisionLog({
      latest: revision({
        revision: 2,
        reason: 'schedule_revised',
        revisedAtMs: 2 * HOUR_MS,
        planStatus: 'on_track',
        hours: [{ startsAtMs: 2 * HOUR_MS, plannedKWh: 1 }],
      }),
      history: [priorRev],
      timeZone: TZ,
      kind: 'temperature',
    });
    expect(rows[0]?.reason).toBe('Schedule revised');
  });

  it('budget signal beats risk transition when both are present (most-actionable wins)', () => {
    const rows = buildActivePlanRevisionLog({
      latest: revision({
        revision: 2,
        reason: 'schedule_revised',
        revisedAtMs: 2 * HOUR_MS,
        planStatus: 'cannot_meet',
        dailyBudgetExhaustedBucketCount: 2,
        hours: [{ startsAtMs: 2 * HOUR_MS, plannedKWh: 1 }],
      }),
      history: [priorRev], // priorRev planStatus 'on_track' → risk transition
      timeZone: TZ,
      kind: 'temperature',
    });
    expect(rows[0]?.reason).toBe('Schedule revised — daily budget shifted');
  });

  it('falls through to bare label on a mixed-diff swap (1 hour added + 1 removed) — not unambiguously "cheaper hour opened"', () => {
    const rows = buildActivePlanRevisionLog({
      latest: revision({
        revision: 2,
        reason: 'schedule_revised',
        revisedAtMs: 2 * HOUR_MS,
        planStatus: 'on_track',
        hours: [{ startsAtMs: 3 * HOUR_MS, plannedKWh: 1 }], // swapped: dropped 2*, added 3*
      }),
      history: [priorRev], // priorRev has [2*HOUR_MS]
      timeZone: TZ,
      kind: 'temperature',
    });
    expect(rows[0]?.reason).toBe('Schedule revised');
  });

  it('does not disambiguate schedule_revised on the oldest row (no prior to compare against)', () => {
    // The recorder still emits the reason, but we can't compute planStatusChanged
    // without a prior — only budget signals can drive disambiguation here.
    const rows = buildActivePlanRevisionLog({
      latest: revision({
        revision: 1,
        reason: 'schedule_revised',
        planStatus: 'at_risk',
        hours: [{ startsAtMs: 2 * HOUR_MS, plannedKWh: 1 }],
      }),
      history: undefined,
      timeZone: TZ,
      kind: 'temperature',
    });
    expect(rows[0]?.reason).toBe('Schedule revised');
  });
});
