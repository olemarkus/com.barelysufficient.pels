import { describe, expect, it } from 'vitest';
import { parsePlanSnapshot } from '../src/ui/planSnapshotParse.ts';
import { uiDeviceFixture } from './helpers/deviceStatusFixture.ts';

const device = () => uiDeviceFixture({ currentState: 'off', plannedState: 'shed', reason: { code: 'capacity' } });

describe('parsePlanSnapshot resolved status boundary', () => {
  it('accepts a clean authoritative presentation without copying or resolving it', () => {
    const payload = { devices: [device()] };
    expect(parsePlanSnapshot(payload)).toBe(payload);
  });

  it('rejects absent or malformed status rather than reconstructing it from old axes', () => {
    for (const status of [undefined, null, {}, { ...device().status, kind: 'unknown' },
      { ...device().status, reason: { text: 42 } },
      { ...device().status, rail: { labels: [42], activeIndex: 'low' } },
      { ...device().status, reason: { text: 'Wait', countdown: { endsAtMs: NaN } } }]) {
      expect(parsePlanSnapshot({ devices: [{ ...device(), status, currentState: 'off', plannedState: 'shed' }] }))
        .toBeNull();
    }
  });

  it('drops retired state inputs before inward consumers can use them', () => {
    const status = device().status;
    const parsed = parsePlanSnapshot({ devices: [{ ...device(), status,
      currentState: 'on', plannedState: 'keep', reason: { code: 'keep' },
      temperature: { plannedTarget: 21 }, steppedLoad: { targetStepId: 'max' },
      binaryCommandPending: true, execution: { desiredBinary: 'on' },
    }] });
    const accepted = parsed?.devices?.[0];
    expect(accepted?.status).toBe(status);
    for (const key of ['currentState', 'plannedState', 'reason', 'temperature', 'steppedLoad',
      'binaryCommandPending', 'execution']) expect(accepted).not.toHaveProperty(key);
  });

  it.each(['available', 'controllable'])('requires a resolved %s boolean', (key) => {
    for (const value of [undefined, null, 1, 'true']) {
      expect(parsePlanSnapshot({ devices: [{ ...device(), [key]: value }] })).toBeNull();
    }
  });
});

describe('parsePlanSnapshot meta guard', () => {
  // The fields both variants carry; `validMeta` is the measured variant on top.
  const baseMeta = {
    totalKw: 4.2,
    softLimitKw: 9.5,
    capacitySoftLimitKw: 9.5,
    budgetPaceKw: null,
    projectedExemptKw: null,
    softLimitSource: 'capacity',
    hardCapLimitKw: 12,
    capacityPeriodMinutes: 60,
    capacityPeriodCoverageComplete: true,
    usedKWh: 1.2,
    hourBudgetKWh: 9.5,
    minutesRemaining: 30,
    lastPowerUpdateMs: 1_700_000_000_000,
  };
  const validMeta = {
    ...baseMeta,
    powerIsMeasured: true,
    controlledKw: 2,
    uncontrolledKw: 2.2,
  };

  it('passes a complete meta through identity-preserving', () => {
    const payload = { meta: validMeta, devices: [] };
    expect(parsePlanSnapshot(payload)).toBe(payload);
  });

  it('keeps the nullable pace pair as null, and rejects a null meter pair — a reading always exists', () => {
    // The pace pair's null = no daily-budget axis (a real state). The meter
    // pair is always numbers now: a snapshot exists only behind the
    // measurement gate, so "no reading" is not a plan-meta state any more.
    const paceNull = {
      meta: { ...validMeta, budgetPaceKw: null, projectedExemptKw: null },
      devices: [],
    };
    expect(parsePlanSnapshot(paceNull)).toBe(paceNull);
    expect(parsePlanSnapshot({
      meta: { ...validMeta, totalKw: null, uncontrolledKw: null },
      devices: [],
    })).toBeNull();
  });

  it.each([
    ['a missing required number', { hardCapLimitKw: undefined }],
    ['a null where null is not a value', { softLimitKw: null }],
    ['NaN', { controlledKw: Number.NaN }],
    ['Infinity', { usedKWh: Number.POSITIVE_INFINITY }],
    ['a non-number', { minutesRemaining: '30' }],
    ['a non-member softLimitSource', { softLimitSource: 'both' }],
    ['a missing capacity period', { capacityPeriodMinutes: undefined }],
    ['an unsupported capacity period', { capacityPeriodMinutes: 30 }],
    ['a missing capacity-period coverage verdict', { capacityPeriodCoverageComplete: undefined }],
  ])('rejects the whole payload for %s', (_label, patch) => {
    // Rejecting rather than repairing: there is no useful hero to draw from a
    // partial meta, and the hero reads these numbers without hedging — before
    // this guard, a missing `hardCapLimitKw` reached `.toFixed()` and threw.
    expect(parsePlanSnapshot({ meta: { ...validMeta, ...patch }, devices: [] })).toBeNull();
  });

  it.each([
    ['a reading but no background split', { totalKw: 4.2, uncontrolledKw: null }],
    ['a background split but no reading', { totalKw: null, uncontrolledKw: 2.2 }],
  ])('rejects %s — the meter pair is one fact', (_label, patch) => {
    // Accepting a mismatched pair is worse than a wrong number: the hero needs
    // both to build its input, so it would fall to the loading skeleton while
    // the accepted payload had already replaced the last good plan.
    expect(parsePlanSnapshot({ meta: { ...validMeta, ...patch }, devices: [] })).toBeNull();
  });

  it('accepts the unmeasured variant with no derived figures, and requires them on the measured one', () => {
    // The wire meta is a union on `powerIsMeasured`. Unmeasured carries the
    // bare signal — the hero draws nothing from it, so there is no headroom or
    // managed/background split to require. Measured requires all three.
    const unmeasured = { meta: { ...baseMeta, powerIsMeasured: false }, devices: [] };
    expect(parsePlanSnapshot(unmeasured)).toBe(unmeasured);
    expect(parsePlanSnapshot({ meta: { ...baseMeta, powerIsMeasured: true }, devices: [] })).toBeNull();
    expect(parsePlanSnapshot({ meta: { ...validMeta, uncontrolledKw: undefined }, devices: [] })).toBeNull();
  });

  it('rejects a meta that does not say whether it was measured', () => {
    expect(parsePlanSnapshot({ meta: { ...validMeta, powerIsMeasured: undefined }, devices: [] })).toBeNull();
    expect(parsePlanSnapshot({ meta: { ...validMeta, powerIsMeasured: 'yes' }, devices: [] })).toBeNull();
  });

  it('leaves a payload with no meta alone', () => {
    const payload = { devices: [] };
    expect(parsePlanSnapshot(payload)).toBe(payload);
  });
});
