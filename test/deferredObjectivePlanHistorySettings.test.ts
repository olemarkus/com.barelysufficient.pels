import {
  DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION,
  normalizeDeferredObjectivePlanHistory,
} from '../lib/plan/deferredObjectives/planHistorySettings';

const HOUR_MS = 60 * 60 * 1000;

const v2Entry = {
  deviceId: 'dev',
  deviceName: 'Water Heater',
  objectiveKind: 'temperature',
  targetTemperatureC: 65,
  targetPercent: null,
  deadlineAtMs: HOUR_MS,
  startedAtMs: 0,
  finalizedAtMs: HOUR_MS,
  startProgressC: 50,
  startProgressPercent: null,
  finalProgressC: 65,
  finalProgressPercent: null,
  initialEnergyNeededKWh: 22.5,
  outcome: 'met',
  metAtMs: HOUR_MS - 1,
  usedDeadlineReserve: false,
  usedPolicyAvoid: false,
  observedIntervals: [{ fromMs: 0, toMs: HOUR_MS }],
  discoveredFrom: 'observation',
};

describe('normalizeDeferredObjectivePlanHistory v2 → v3 migration', () => {
  it('synthesizes a uuid and null plan snapshots for legacy v2 entries', () => {
    const result = normalizeDeferredObjectivePlanHistory({
      version: 2,
      entries: [v2Entry],
    });
    expect(result.version).toBe(DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION);
    expect(result.entries).toHaveLength(1);
    const migrated = result.entries[0]!;
    expect(typeof migrated.id).toBe('string');
    expect(migrated.id.length).toBeGreaterThan(10);
    expect(migrated.originalPlan).toBeNull();
    expect(migrated.finalPlan).toBeNull();
    // Pre-existing fields are preserved.
    expect(migrated.outcome).toBe('met');
    expect(migrated.finalizedAtMs).toBe(HOUR_MS);
  });

  it('assigns distinct uuids when migrating multiple v2 entries in one read', () => {
    const result = normalizeDeferredObjectivePlanHistory({
      version: 2,
      entries: [v2Entry, { ...v2Entry, deviceId: 'dev-b' }],
    });
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.id).not.toBe(result.entries[1]!.id);
  });

  it('rejects v3 entries that are missing the id field', () => {
    const result = normalizeDeferredObjectivePlanHistory({
      version: 3,
      entries: [{ ...v2Entry, originalPlan: null, finalPlan: null }],
    });
    // Entry without `id` is dropped by the v3 validator.
    expect(result.entries).toHaveLength(0);
  });

  it('accepts well-formed v3 entries unchanged', () => {
    const v3Entry = {
      ...v2Entry,
      id: 'fixed-id-1',
      originalPlan: null,
      finalPlan: null,
    };
    const result = normalizeDeferredObjectivePlanHistory({
      version: 3,
      entries: [v3Entry],
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.id).toBe('fixed-id-1');
  });
});

describe('normalizeDeferredObjectivePlanHistory v3 → v4 migration', () => {
  const v3Entry = {
    ...v2Entry,
    id: 'v3-entry-1',
    originalPlan: null,
    finalPlan: null,
  };

  it('reads v3 entries with new v4 fields absent — graceful degrade', () => {
    const result = normalizeDeferredObjectivePlanHistory({
      version: 3,
      entries: [v3Entry],
    });
    // Schema is upgraded to v4 in-place; entry shape is preserved.
    expect(result.version).toBe(DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION);
    expect(result.version).toBe(4);
    expect(result.entries).toHaveLength(1);
    const migrated = result.entries[0]!;
    expect(migrated.id).toBe('v3-entry-1');
    // The four v4-only fields read undefined on legacy v3 entries.
    expect(migrated.progressSamples).toBeUndefined();
    expect(migrated.deliveredKWh).toBeUndefined();
    expect(migrated.totalCost).toBeUndefined();
    expect(migrated.revisions).toBeUndefined();
  });

  it('accepts well-formed v4 entries unchanged (round-trip)', () => {
    const v4Entry = {
      ...v3Entry,
      id: 'v4-entry-1',
      progressSamples: [
        { atMs: 0, valueC: 50, valuePercent: null },
        { atMs: HOUR_MS, valueC: 60, valuePercent: null },
      ],
      deliveredKWh: 4.2,
      totalCost: 5.1,
      revisions: [
        { atMs: HOUR_MS / 2, reasonId: 'prices_revised', hoursAdded: 1, hoursRemoved: 0 },
      ],
    };
    const result = normalizeDeferredObjectivePlanHistory({
      version: 4,
      entries: [v4Entry],
    });
    expect(result.entries).toHaveLength(1);
    const round = result.entries[0]!;
    expect(round.progressSamples).toEqual(v4Entry.progressSamples);
    expect(round.deliveredKWh).toBeCloseTo(4.2);
    expect(round.totalCost).toBeCloseTo(5.1);
    expect(round.revisions).toEqual(v4Entry.revisions);
  });

  it('drops entries with malformed v4 extensions but keeps siblings', () => {
    const goodEntry = {
      ...v3Entry,
      id: 'v4-good',
      deliveredKWh: 1.5,
      totalCost: 2.0,
    };
    const badProgressSamples = {
      ...v3Entry,
      id: 'v4-bad-samples',
      // Not an array — should drop.
      progressSamples: 'not-an-array',
    };
    const badRevision = {
      ...v3Entry,
      id: 'v4-bad-revisions',
      revisions: [{ atMs: 'not-a-number', reasonId: 'x', hoursAdded: 0, hoursRemoved: 0 }],
    };
    const badDelivered = {
      ...v3Entry,
      id: 'v4-bad-delivered',
      // Negative kWh — caught by `deliveredKWh < 0` check.
      deliveredKWh: -1,
    };
    const result = normalizeDeferredObjectivePlanHistory({
      version: 4,
      entries: [goodEntry, badProgressSamples, badRevision, badDelivered],
    });
    expect(result.entries.map((e) => e.id)).toEqual(['v4-good']);
  });

  it('accepts a revision snapshot with kwhPerUnitMean present', () => {
    const snapshot = {
      hours: [{ startsAtMs: 0, plannedKWh: 1.5 }],
      energyNeededKWh: 1.5,
      planStatus: 'on_track',
      revisedAtMs: 0,
      kwhPerUnitMean: 0.59,
    };
    const result = normalizeDeferredObjectivePlanHistory({
      version: 4,
      entries: [{ ...v3Entry, id: 'kwh-1', originalPlan: snapshot, finalPlan: snapshot }],
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.originalPlan?.kwhPerUnitMean).toBeCloseTo(0.59);
    expect(result.entries[0]!.finalPlan?.kwhPerUnitMean).toBeCloseTo(0.59);
  });

  it('drops a revision snapshot whose kwhPerUnitMean is non-positive', () => {
    const snapshot = {
      hours: [{ startsAtMs: 0, plannedKWh: 1.5 }],
      energyNeededKWh: 1.5,
      planStatus: 'on_track',
      revisedAtMs: 0,
      kwhPerUnitMean: 0, // illegal — must be > 0 to be a real rate.
    };
    const result = normalizeDeferredObjectivePlanHistory({
      version: 4,
      entries: [{ ...v3Entry, id: 'kwh-bad', originalPlan: snapshot, finalPlan: null }],
    });
    expect(result.entries).toHaveLength(0);
  });

  // v2.7.2 PR 3 added `dailyBudgetExhaustedBucketCount` on the snapshot so
  // the history-detail postmortem can branch on budget exhaustion. The
  // validator accepts the field on read, drops it on negative values, and
  // accepts zero (the recorder writes positive counts only — but legacy
  // tools that round-trip persisted history might write zero, so the
  // validator stays lenient).
  it('accepts a revision snapshot with dailyBudgetExhaustedBucketCount present', () => {
    const snapshot = {
      hours: [{ startsAtMs: 0, plannedKWh: 1.5 }],
      energyNeededKWh: 1.5,
      planStatus: 'cannot_meet',
      revisedAtMs: 0,
      dailyBudgetExhaustedBucketCount: 3,
    };
    const result = normalizeDeferredObjectivePlanHistory({
      version: 4,
      entries: [{ ...v3Entry, id: 'budget-1', originalPlan: snapshot, finalPlan: snapshot }],
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.finalPlan?.dailyBudgetExhaustedBucketCount).toBe(3);
  });

  it('drops a revision snapshot whose dailyBudgetExhaustedBucketCount is negative', () => {
    const snapshot = {
      hours: [{ startsAtMs: 0, plannedKWh: 1.5 }],
      energyNeededKWh: 1.5,
      planStatus: 'cannot_meet',
      revisedAtMs: 0,
      dailyBudgetExhaustedBucketCount: -1,
    };
    const result = normalizeDeferredObjectivePlanHistory({
      version: 4,
      entries: [{ ...v3Entry, id: 'budget-bad', originalPlan: snapshot, finalPlan: null }],
    });
    expect(result.entries).toHaveLength(0);
  });

  it('accepts metReason:"stalled" on met entries (optional field, byte-stable upgrade)', () => {
    const stalledEntry = {
      ...v3Entry,
      id: 'stalled-1',
      outcome: 'met',
      metReason: 'stalled',
      metAtMs: HOUR_MS,
      finalProgressC: 61.8,
    };
    const result = normalizeDeferredObjectivePlanHistory({
      version: 4,
      entries: [stalledEntry],
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.metReason).toBe('stalled');
  });

  it('drops an entry with metReason on a non-met outcome (contract violation)', () => {
    // The recorder is responsible for not writing metReason on missed/
    // replaced/abandoned/unknown; the validator enforces it on read-back
    // so a hand-edited / corrupted persisted payload doesn't surface
    // "stalled but missed" to the UI.
    const malformed = {
      ...v3Entry,
      id: 'malformed-1',
      outcome: 'missed',
      metReason: 'stalled',
      metAtMs: null,
    };
    const result = normalizeDeferredObjectivePlanHistory({
      version: 4,
      entries: [malformed],
    });
    expect(result.entries).toHaveLength(0);
  });

  it('drops an entry whose metReason is an unknown string', () => {
    const malformed = {
      ...v3Entry,
      id: 'malformed-2',
      outcome: 'met',
      metReason: 'bogus',
      metAtMs: HOUR_MS,
    };
    const result = normalizeDeferredObjectivePlanHistory({
      version: 4,
      entries: [malformed],
    });
    expect(result.entries).toHaveLength(0);
  });
});
