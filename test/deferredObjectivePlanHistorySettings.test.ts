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
