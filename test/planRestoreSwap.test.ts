import {
  buildInsufficientHeadroomUpdate,
  buildSwapCandidates,
  computePendingRestorePowerKw,
  computeRestoreBufferKw,
  estimateRestorePower,
} from '../lib/plan/planRestoreSwap';
import { PENDING_RESTORE_WINDOW_MS } from '../lib/plan/planConstants';
import { buildPlanDevice, steppedPlanDevice } from './utils/planTestUtils';

describe('buildSwapCandidates', () => {
  it('excludes devices with equal or higher restore priority', () => {
    const result = buildSwapCandidates({
      dev: buildPlanDevice({ priority: 50 }),
      onDevices: [
        buildPlanDevice({ id: 'higher', name: 'Higher', priority: 40, powerKw: 2 }),
        buildPlanDevice({ id: 'equal', name: 'Equal', priority: 50, powerKw: 2 }),
      ],
      swappedOutFor: new Map(),
      availableHeadroom: 1,
      needed: 3,
      restoredThisCycle: new Set(),
    });

    expect(result.ready).toBe(false);
    expect(result.toShed).toHaveLength(0);
  });

  it('defaults missing priorities to 100 when evaluating swap candidates', () => {
    const result = buildSwapCandidates({
      dev: buildPlanDevice({ priority: undefined }),
      onDevices: [
        buildPlanDevice({ id: 'equal-default', name: 'EqualDefault', priority: undefined, powerKw: 2 }),
        buildPlanDevice({ id: 'lower-priority', name: 'LowerPriority', priority: 120, powerKw: 2 }),
      ],
      swappedOutFor: new Map(),
      availableHeadroom: 0,
      needed: 2,
      restoredThisCycle: new Set(),
    });

    expect(result.ready).toBe(true);
    expect(result.toShed.map((device) => device.id)).toEqual(['lower-priority']);
  });

  it('skips ineligible devices and returns ready when enough headroom is found', () => {
    const swappedOutFor = new Map<string, string>([['skip', 'target']]);
    const restoredThisCycle = new Set(['restored']);
    const onDevices = [
      buildPlanDevice({ id: 'shed', name: 'Shed', priority: 100, plannedState: 'shed', powerKw: 2 }),
      buildPlanDevice({ id: 'skip', name: 'Skip', priority: 90, plannedState: 'keep', powerKw: 2 }),
      buildPlanDevice({ id: 'restored', name: 'Restored', priority: 80, plannedState: 'keep', powerKw: 2 }),
      buildPlanDevice({ id: 'add1', name: 'Add1', priority: 70, plannedState: 'keep', powerKw: 2 }),
      buildPlanDevice({ id: 'add2', name: 'Add2', priority: 60, plannedState: 'keep' }),
    ];

    const result = buildSwapCandidates({
      dev: buildPlanDevice({ priority: 50 }),
      onDevices,
      swappedOutFor,
      availableHeadroom: 0,
      needed: 3,
      restoredThisCycle,
    });

    expect(result.ready).toBe(true);
    expect(result.toShed.map((device) => device.id)).toEqual(['add1', 'add2']);
    expect(result.shedNames).toBe('Add1, Add2');
    expect(result.shedPower).toBe('3.00');
  });

  it('returns not ready when potential headroom is still insufficient', () => {
    const result = buildSwapCandidates({
      dev: buildPlanDevice({ priority: 50 }),
      onDevices: [buildPlanDevice({ id: 'on', name: 'On', priority: 90, powerKw: 1 })],
      swappedOutFor: new Map(),
      availableHeadroom: 0,
      needed: 5,
      restoredThisCycle: new Set(),
    });

    expect(result.ready).toBe(false);
    expect(result.toShed).toHaveLength(1);
    expect(result.reason).toContain('insufficient headroom');
  });

  it('uses the same effective power estimate as shedding when evaluating swap candidates', () => {
    const result = buildSwapCandidates({
      dev: buildPlanDevice({ priority: 50 }),
      onDevices: [
        buildPlanDevice({
          id: 'candidate',
          name: 'Candidate',
          priority: 90,
          powerKw: 0.2,
          expectedPowerKw: 1.2,
        }),
      ],
      swappedOutFor: new Map(),
      availableHeadroom: 0.2,
      needed: 1.3,
      restoredThisCycle: new Set(),
    });

    expect(result.ready).toBe(true);
    expect(result.toShed.map((device) => device.id)).toEqual(['candidate']);
    expect(result.shedPowerByDeviceId.get('candidate')).toBeCloseTo(1.2, 6);
    expect(result.shedPower).toBe('1.20');
    expect(result.potentialHeadroom).toBeCloseTo(1.4, 6);
  });

  it('treats explicit zero expected or configured power as zero instead of falling back to 1kW', () => {
    const result = buildSwapCandidates({
      dev: buildPlanDevice({ priority: 50 }),
      onDevices: [
        buildPlanDevice({
          id: 'zero',
          name: 'Zero',
          priority: 90,
          expectedPowerKw: 0,
          powerKw: 0,
        }),
      ],
      swappedOutFor: new Map(),
      availableHeadroom: 0.2,
      needed: 0.3,
      restoredThisCycle: new Set(),
    });

    expect(result.ready).toBe(false);
    expect(result.toShed).toHaveLength(0);
    expect(result.shedPowerByDeviceId.size).toBe(0);
  });
});

describe('restore swap helpers', () => {
  it('returns a shed update when headroom is insufficient', () => {
    const update = buildInsufficientHeadroomUpdate(2, 1);
    expect(update.plannedState).toBe('shed');
    expect(update.reason).toContain('need 2.00kW');
  });

  it('estimates restore power from expected, measured, or fallback values', () => {
    expect(estimateRestorePower(buildPlanDevice({ expectedPowerKw: 2, measuredPowerKw: 5, powerKw: 1 }))).toBe(2);
    expect(estimateRestorePower(buildPlanDevice({ measuredPowerKw: 3, powerKw: 1 }))).toBe(3);
    expect(estimateRestorePower(buildPlanDevice({ powerKw: 2 }))).toBe(2);
    expect(estimateRestorePower(buildPlanDevice())).toBe(1);
  });

  it('uses lowest non-zero step for stepped devices at off-step', () => {
    // At off-step: planningPowerKw=0, measuredPowerKw=0 — should use lowest non-zero step (1.25kW)
    expect(estimateRestorePower(steppedPlanDevice({
      selectedStepId: 'off',
      planningPowerKw: 0,
      measuredPowerKw: 0,
    }))).toBe(1.25);
    // At active step with positive planningPowerKw — should use planningPowerKw directly
    expect(estimateRestorePower(steppedPlanDevice({
      selectedStepId: 'medium',
      planningPowerKw: 2,
    }))).toBe(2);
    // Device is off (currentState: 'off'), but selectedStepId is 'medium'.
    // planningPowerKw is 2.0 (retained from medium step).
    // Should use 1.25 (low step) because it's starting from off.
    expect(estimateRestorePower(steppedPlanDevice({
      currentState: 'off',
      selectedStepId: 'medium',
      planningPowerKw: 2,
      measuredPowerKw: 0,
    }))).toBe(1.25);
    // No planningPowerKw set, no measuredPower — should still use lowest non-zero step
    expect(estimateRestorePower(steppedPlanDevice({
      selectedStepId: 'off',
    }))).toBe(1.25);
  });

  it('computes restore buffer with bounds and scaling', () => {
    expect(computeRestoreBufferKw(-2)).toBeCloseTo(0.2, 5);
    expect(computeRestoreBufferKw(0)).toBeCloseTo(0.2, 5);
    expect(computeRestoreBufferKw(1)).toBeCloseTo(0.2, 5);
    expect(computeRestoreBufferKw(1.5)).toBeCloseTo(0.25, 5);
    expect(computeRestoreBufferKw(3)).toBeCloseTo(0.4, 5);
    expect(computeRestoreBufferKw(5)).toBeCloseTo(0.6, 5);
    expect(computeRestoreBufferKw(10)).toBeCloseTo(0.6, 5);
  });
});

describe('computePendingRestorePowerKw', () => {
  const now = Date.UTC(2025, 0, 1, 12, 0, 0);
  const recentMs = now - 30_000; // 30s ago — within window

  it('reserves gap for recently restored device whose element has not fired', () => {
    const dev = buildPlanDevice({ id: 'therm', currentOn: true, expectedPowerKw: 2, measuredPowerKw: 0 });
    const result = computePendingRestorePowerKw([dev], { therm: recentMs }, now);
    expect(result.deviceIds).toEqual(['therm']);
    expect(result.pendingKw).toBeCloseTo(2, 5); // full gap: expected 2, actual 0
  });

  it('reserves only the gap, not full expected power, when device is partially drawing', () => {
    const dev = buildPlanDevice({ id: 'therm', currentOn: true, expectedPowerKw: 3, measuredPowerKw: 0.5 });
    const result = computePendingRestorePowerKw([dev], { therm: recentMs }, now);
    expect(result.pendingKw).toBeCloseTo(2.5, 5); // gap: 3 - 0.5
  });

  it('skips device that has confirmed its draw (>=50% of expected)', () => {
    const dev = buildPlanDevice({ id: 'therm', currentOn: true, expectedPowerKw: 2, measuredPowerKw: 1.5 });
    const result = computePendingRestorePowerKw([dev], { therm: recentMs }, now);
    expect(result.pendingKw).toBe(0);
    expect(result.deviceIds).toHaveLength(0);
  });

  it('skips device restored outside the pending window', () => {
    const oldMs = now - PENDING_RESTORE_WINDOW_MS - 1000;
    const dev = buildPlanDevice({ id: 'therm', currentOn: true, expectedPowerKw: 2, measuredPowerKw: 0 });
    const result = computePendingRestorePowerKw([dev], { therm: oldMs }, now);
    expect(result.pendingKw).toBe(0);
  });

  it('reserves headroom for recently restored device not yet confirmed on (stepped-load case)', () => {
    // Stepped loads stay currentOn=false until snapshot confirms — must still reserve headroom.
    const dev = buildPlanDevice({ id: 'therm', currentOn: false, expectedPowerKw: 2, measuredPowerKw: 0 });
    const result = computePendingRestorePowerKw([dev], { therm: recentMs }, now);
    expect(result.deviceIds).toEqual(['therm']);
    expect(result.pendingKw).toBeCloseTo(2, 5);
  });

  it('uses powerKw as observed draw fallback when measuredPowerKw is absent', () => {
    // Installations without live power only populate powerKw. Treat it as actual draw so
    // a device already drawing via powerKw is not double-reserved for the full expected load.
    const dev = buildPlanDevice({ id: 'therm', currentOn: true, expectedPowerKw: 3, powerKw: 1 });
    const result = computePendingRestorePowerKw([dev], { therm: recentMs }, now);
    expect(result.pendingKw).toBeCloseTo(2, 5); // gap: 3 - 1 (1 < 3*0.5 — not yet confirmed)
  });

  it('considers powerKw-only device confirmed when powerKw meets threshold', () => {
    // powerKw=1.2 meets the 50% threshold of expectedPowerKw=2 — device is confirmed, no reservation.
    const dev = buildPlanDevice({ id: 'therm', currentOn: true, expectedPowerKw: 2, powerKw: 1.2 });
    const result = computePendingRestorePowerKw([dev], { therm: recentMs }, now);
    expect(result.pendingKw).toBe(0);
    expect(result.deviceIds).toHaveLength(0);
  });

  it('skips device with no restore timestamp in state', () => {
    const dev = buildPlanDevice({ id: 'therm', currentOn: true, expectedPowerKw: 2, measuredPowerKw: 0 });
    const result = computePendingRestorePowerKw([dev], {}, now);
    expect(result.pendingKw).toBe(0);
  });

  it('accumulates pending power across multiple qualifying devices', () => {
    const dev1 = buildPlanDevice({ id: 'd1', currentOn: true, expectedPowerKw: 2, measuredPowerKw: 0 });
    const dev2 = buildPlanDevice({ id: 'd2', currentOn: true, expectedPowerKw: 3, measuredPowerKw: 0 });
    const result = computePendingRestorePowerKw(
      [dev1, dev2],
      { d1: recentMs, d2: recentMs },
      now,
    );
    expect(result.pendingKw).toBeCloseTo(5, 5);
    expect(result.deviceIds).toEqual(['d1', 'd2']);
  });
});
