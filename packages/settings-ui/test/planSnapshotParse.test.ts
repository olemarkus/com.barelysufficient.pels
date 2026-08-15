// Boundary coverage for the plan-snapshot guard: the target-name half, and the
// three atomic facets (temperature, stepped cluster, EV plug-state pair).
//
// The seam exists because this payload crosses a real JSON transport and the
// consumers inward of it are written to trust what they get: the formatters
// interpolate `targetName` with no fallback, `resolveTemperatureLine` calls
// `.toFixed()` on the trio, and `formatStepDisplayLabel` calls `.trim()` on a
// step id. Rejecting or dropping here is what lets all of them stay total.
//
// `swap_pending` is deliberately exempt from the target-name rule; its `null` is
// a real unresolved-target state the formatter renders on purpose.

import { describe, expect, it } from 'vitest';
import { parsePlanSnapshot } from '../src/ui/planSnapshotParse.ts';

const deviceWith = (reason: unknown): unknown => ({
  devices: [{ id: 'dev-1', name: 'Water heater', controllable: true, available: true, reason }],
});

describe('parsePlanSnapshot target-name guard', () => {
  it('accepts a required target name that can actually be shown', () => {
    for (const code of ['swapped_out', 'reserved_for_start']) {
      expect(parsePlanSnapshot(deviceWith({ code, targetName: 'Bathroom' }))).not.toBeNull();
    }
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace-only', '   '],
    ['a non-string', 42],
  ])('rejects a %s target name on a code that must name its holder', (_label, targetName) => {
    for (const code of ['swapped_out', 'reserved_for_start']) {
      expect(parsePlanSnapshot(deviceWith({ code, targetName }))).toBeNull();
    }
  });

  it('leaves swap_pending alone — its null target is a real unresolved state', () => {
    expect(parsePlanSnapshot(deviceWith({ code: 'swap_pending', targetName: null }))).not.toBeNull();
    expect(parsePlanSnapshot(deviceWith({ code: 'swap_pending' }))).not.toBeNull();
  });

  it('does not require a target name from codes that never render one', () => {
    expect(parsePlanSnapshot(deviceWith({ code: 'capacity' }))).not.toBeNull();
    expect(parsePlanSnapshot(deviceWith({ code: 'cooldown_restore', remainingSec: 42 }))).not.toBeNull();
  });
});

describe('parsePlanSnapshot resolved boolean guard', () => {
  it.each([
    ['controllable', undefined],
    ['controllable', 'true'],
    ['available', undefined],
    ['available', 1],
  ])('rejects a non-boolean or absent %s field', (field, fieldValue) => {
    const device = {
      id: 'dev-1',
      name: 'Water heater',
      controllable: true,
      available: true,
      reason: { code: 'capacity' },
      [field]: fieldValue,
    };

    expect(parsePlanSnapshot({ devices: [device] })).toBeNull();
  });

  it('preserves explicit false values', () => {
    expect(parsePlanSnapshot({
      devices: [{
        id: 'dev-1',
        name: 'Water heater',
        controllable: false,
        available: false,
        reason: { code: 'capacity' },
      }],
    })).not.toBeNull();
  });
});

describe('parsePlanSnapshot temperature facet guard', () => {
  const device = (temperature?: unknown) => ({
    id: 'dev-1',
    name: 'Water heater',
    controllable: true,
    available: true,
    reason: { code: 'capacity' },
    ...(temperature !== undefined ? { temperature } : {}),
  });

  it('passes a clean payload through identity-preserving (byte-identical reads rely on it)', () => {
    const payload = { devices: [device({ currentTarget: 21, currentTemperature: 20.4, plannedTarget: 22 })] };
    expect(parsePlanSnapshot(payload)).toBe(payload);
  });

  it('drops a partial or non-finite facet WHOLLY - never a nullable field inward', () => {
    for (const junk of [
      { currentTarget: 21 },
      { currentTarget: 21, currentTemperature: 20.4 },
      { currentTarget: Number.NaN, currentTemperature: 20.4, plannedTarget: 22 },
      { currentTarget: 21, currentTemperature: Number.POSITIVE_INFINITY, plannedTarget: 22 },
      { currentTarget: 21, currentTemperature: 20.4, plannedTarget: null },
      'junk',
    ]) {
      const parsed = parsePlanSnapshot({ devices: [device(junk)] });
      expect(parsed).not.toBeNull();
      expect((parsed?.devices?.[0] as { temperature?: unknown }).temperature).toBeUndefined();
    }
  });

  it('keeps facet-less devices untouched', () => {
    const parsed = parsePlanSnapshot({ devices: [device()] });
    expect((parsed?.devices?.[0] as { temperature?: unknown }).temperature).toBeUndefined();
  });
});

describe('parsePlanSnapshot stepped cluster guard', () => {
  const device = (steppedLoad?: unknown) => ({
    id: 'dev-1',
    name: 'Panel heater',
    controllable: true,
    available: true,
    reason: { code: 'capacity' },
    ...(steppedLoad !== undefined ? { steppedLoad } : {}),
  });

  const validCluster = {
    profile: { steps: [{ id: 'low' }, { id: 'high' }] },
    reportedStepId: 'low',
    targetStepId: 'high',
    selectedStepId: 'low',
    planningPowerKw: 1,
    commandPending: false,
  };

  it('passes a clean cluster through identity-preserving', () => {
    const payload = { devices: [device(validCluster)] };
    expect(parsePlanSnapshot(payload)).toBe(payload);
  });

  it('keeps null step ids — they are a real "nothing reported / no target" state', () => {
    const payload = {
      devices: [device({ ...validCluster, reportedStepId: null, targetStepId: null })],
    };
    expect(parsePlanSnapshot(payload)).toBe(payload);
  });

  it('drops a malformed cluster WHOLLY, so the device renders as non-stepped', () => {
    for (const junk of [
      // Truthy non-objects: presence of the key is the stepped discriminant, so
      // these used to route a device into the stepped card.
      1,
      'stepped',
      // A step id of the wrong type reaches `formatStepDisplayLabel`, which
      // calls `.trim()` on it.
      { ...validCluster, reportedStepId: 7 },
      { ...validCluster, targetStepId: {} },
      // The two REQUIRED members. Missing `selectedStepId` would make an off
      // device read "Resuming" (`undefined !== targetStepId`); a non-finite
      // `planningPowerKw` reaches the power text, which now reads it with no
      // fallback.
      { ...validCluster, selectedStepId: undefined },
      { ...validCluster, selectedStepId: 7 },
      { ...validCluster, planningPowerKw: undefined },
      { ...validCluster, planningPowerKw: Number.NaN },
      { ...validCluster, planningPowerKw: '1' },
      // Structural gaps.
      { ...validCluster, profile: undefined },
      { ...validCluster, profile: { steps: 'low,high' } },
      { ...validCluster, commandPending: undefined },
    ]) {
      const parsed = parsePlanSnapshot({ devices: [device(junk)] });
      expect(parsed).not.toBeNull();
      expect((parsed?.devices?.[0] as { steppedLoad?: unknown }).steppedLoad).toBeUndefined();
    }
  });
});

describe('parsePlanSnapshot EV plug-state guard', () => {
  const device = (fields: Record<string, unknown>) => ({
    id: 'dev-1',
    name: 'Garage charger',
    controllable: true,
    available: true,
    reason: { code: 'capacity' },
    ...fields,
  });

  it('passes every member of the closed union through identity-preserving', () => {
    for (const state of [
      'plugged_in_charging',
      'plugged_in',
      'plugged_in_paused',
      'plugged_out',
      'plugged_in_discharging',
    ]) {
      const payload = { devices: [device({ evChargingState: state, carChargingState: state })] };
      expect(parsePlanSnapshot(payload)).toBe(payload);
    }
  });

  it.each([
    ['a non-member string', 'charging'],
    ['a number', 6],
    ['an object', {}],
    ['null', null],
  ])('drops %s rather than letting it reach a .trim() in the card text', (_label, junk) => {
    const parsed = parsePlanSnapshot({ devices: [device({ evChargingState: junk })] });
    expect(parsed).not.toBeNull();
    expect((parsed?.devices?.[0] as { evChargingState?: unknown }).evChargingState).toBeUndefined();
  });

  it('drops the two states independently — one being junk says nothing about the other', () => {
    const parsed = parsePlanSnapshot({
      devices: [device({ evChargingState: 'plugged_in_charging', carChargingState: 'nonsense' })],
    });
    const dev = parsed?.devices?.[0] as { evChargingState?: unknown; carChargingState?: unknown };
    expect(dev.evChargingState).toBe('plugged_in_charging');
    expect(dev.carChargingState).toBeUndefined();
  });
});

describe('parsePlanSnapshot facet independence', () => {
  it('drops only the malformed facets and keeps the sound ones on the same device', () => {
    const parsed = parsePlanSnapshot({
      devices: [{
        id: 'dev-1',
        name: 'Everything device',
        controllable: true,
        available: true,
        reason: { code: 'capacity' },
        temperature: { currentTarget: 21, currentTemperature: 20.4, plannedTarget: 22 },
        steppedLoad: 'junk',
        evChargingState: 'plugged_in',
        carChargingState: 99,
      }],
    });
    const dev = parsed?.devices?.[0] as Record<string, unknown>;
    expect(dev.temperature).toEqual({ currentTarget: 21, currentTemperature: 20.4, plannedTarget: 22 });
    expect(dev.evChargingState).toBe('plugged_in');
    expect(dev.steppedLoad).toBeUndefined();
    expect(dev.carChargingState).toBeUndefined();
  });
});

describe('parsePlanSnapshot meta guard', () => {
  const validMeta = {
    totalKw: 4.2,
    softLimitKw: 9.5,
    capacitySoftLimitKw: 9.5,
    budgetPaceKw: null,
    projectedExemptKw: null,
    softLimitSource: 'capacity',
    headroomKw: 5.3,
    powerFreshnessState: 'fresh',
    hardCapLimitKw: 12,
    usedKWh: 1.2,
    hourBudgetKWh: 9.5,
    minutesRemaining: 30,
    controlledKw: 2,
    uncontrolledKw: 2.2,
  };

  it('passes a complete meta through identity-preserving', () => {
    const payload = { meta: validMeta, devices: [] };
    expect(parsePlanSnapshot(payload)).toBe(payload);
  });

  it('keeps the nullable four as null — real states, not absence', () => {
    // `totalKw`/`uncontrolledKw` null = no meter reading this cycle;
    // the pace pair null = no daily-budget axis.
    const payload = {
      meta: { ...validMeta, totalKw: null, uncontrolledKw: null },
      devices: [],
    };
    expect(parsePlanSnapshot(payload)).toBe(payload);
  });

  it.each([
    ['a missing required number', { hardCapLimitKw: undefined }],
    ['a null where null is not a value', { softLimitKw: null }],
    ['NaN', { headroomKw: Number.NaN }],
    ['Infinity', { usedKWh: Number.POSITIVE_INFINITY }],
    ['a non-number', { minutesRemaining: '30' }],
    ['a non-member softLimitSource', { softLimitSource: 'both' }],
    ['a non-member freshness state', { powerFreshnessState: 'stale' }],
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

  it('leaves a payload with no meta alone', () => {
    const payload = { devices: [] };
    expect(parsePlanSnapshot(payload)).toBe(payload);
  });
});
