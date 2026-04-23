import {
  buildSwapCandidates,
} from '../lib/plan/planRestoreSwap';
import {
  buildInsufficientHeadroomUpdate,
  computePendingRestorePowerKw,
  computeRestoreBufferKw,
  estimateRestorePower,
  resolveRestorePowerSource,
} from '../lib/plan/planRestoreAccounting';
import { buildRestoreHeadroomReason } from '../lib/plan/planReasonStrings';
import { resolveCandidatePower } from '../lib/plan/planCandidatePower';
import { PENDING_RESTORE_WINDOW_MS } from '../lib/plan/planConstants';
import { PLAN_REASON_CODES } from '../packages/shared-domain/src/planReasonSemantics';
import { buildPlanDevice, steppedPlanDevice } from './utils/planTestUtils';
import { reasonText } from './utils/deviceReasonTestUtils';

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
      availableHeadroom: 0.8,
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
      availableHeadroom: 0.8,
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
    expect(result.reason.code).toBe(PLAN_REASON_CODES.other);
    expect(reasonText(result.reason)).toContain('insufficient headroom');
  });

  it('explains swap failures caused by post-reserve margin after swap reserve', () => {
    const result = buildSwapCandidates({
      dev: buildPlanDevice({ id: 'dev-off', name: 'Off Heater', priority: 50 }),
      onDevices: [
        buildPlanDevice({
          id: 'candidate',
          name: 'Candidate',
          priority: 90,
          measuredPowerKw: 1.2,
        }),
      ],
      swappedOutFor: new Map(),
      availableHeadroom: 0.4,
      needed: 1.0,
      restoredThisCycle: new Set(),
    });

    expect(result.ready).toBe(false);
    expect(result.reason.code).toBe(PLAN_REASON_CODES.other);
    expect(reasonText(result.reason)).toContain('insufficient headroom to swap for Off Heater after reserves');
    expect(reasonText(result.reason)).toContain('effective 1.30kW after 0.30kW swap reserve');
    expect(reasonText(result.reason)).toContain('post-reserve margin 0.050kW < 0.250kW');
  });

  it('keeps swap restores blocked until the swap and admission reserves are both satisfied', () => {
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

    expect(result.ready).toBe(false);
    expect(result.toShed.map((device) => device.id)).toEqual(['candidate']);
    expect(result.potentialHeadroom).toBeCloseTo(1.4, 6); // 0.2 headroom + 1.2 expectedPowerKw
    expect(result.effectiveHeadroom).toBeCloseTo(1.1, 6); // swap reserve applied before approval
    expect(result.shedPower).toBe('1.20');
  });

  it('requires extra reserve before admitting a swap restore', () => {
    const result = buildSwapCandidates({
      dev: buildPlanDevice({ priority: 50 }),
      onDevices: [
        buildPlanDevice({
          id: 'candidate',
          name: 'Candidate',
          priority: 90,
          measuredPowerKw: 1.2,
        }),
      ],
      swappedOutFor: new Map(),
      availableHeadroom: 0.4,
      needed: 0.8,
      restoredThisCycle: new Set(),
    });

    expect(result.potentialHeadroom).toBeCloseTo(1.6, 6);
    expect(result.effectiveHeadroom).toBeCloseTo(1.3, 6);
    expect(result.ready).toBe(true);
    expect(result.reason.code).toBe(PLAN_REASON_CODES.swappedOut);
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
  });
});

describe('restore swap helpers', () => {
  it('returns a shed update when headroom is insufficient', () => {
    const update = buildInsufficientHeadroomUpdate({
      neededKw: 2,
      availableKw: 1,
      postReserveMarginKw: -1.25,
      minimumRequiredPostReserveMarginKw: 0.25,
    });
    expect(update.plannedState).toBe('shed');
    expect(reasonText(update.reason)).toContain('need 2.00kW');
  });

  it('mentions effective need when activation penalties increase the restore requirement', () => {
    const update = buildInsufficientHeadroomUpdate({
      neededKw: 4.6,
      availableKw: 3,
      postReserveMarginKw: -1.85,
      minimumRequiredPostReserveMarginKw: 0.25,
      penaltyExtraKw: 2.3,
    });

    expect(reasonText(update.reason)).toContain('effective need 4.60kW');
    expect(reasonText(update.reason)).toContain('base 2.30kW + penalty 2.30kW');
    expect(reasonText(update.reason)).toContain('available 3.00kW');
  });

  it('preserves negative half-step rounding when formatting reserve deficits', () => {
    const reason = buildRestoreHeadroomReason({
      neededKw: 1,
      availableKw: 1.5,
      postReserveMarginKw: -0.0005,
      minimumRequiredPostReserveMarginKw: 0.25,
    });

    expect(reasonText(reason)).toContain('post-reserve margin -0.001kW < 0.250kW');
  });

  it('uses potential swap headroom in reserve-limited swap rejection summaries', () => {
    const update = buildInsufficientHeadroomUpdate({
      neededKw: 1.0,
      availableKw: 1.6,
      postReserveMarginKw: 0.05,
      minimumRequiredPostReserveMarginKw: 0.25,
      swapReserveKw: 0.3,
      effectiveAvailableKw: 1.3,
    });

    expect(reasonText(update.reason)).toContain('available 1.60kW');
    expect(reasonText(update.reason)).toContain('effective 1.30kW after 0.30kW swap reserve');
    expect(reasonText(update.reason)).toContain('post-reserve margin 0.050kW < 0.250kW');
  });

  it('estimates restore power from expected, measured, or fallback values', () => {
    expect(estimateRestorePower(buildPlanDevice({ expectedPowerKw: 2, measuredPowerKw: 5, powerKw: 1 }))).toBe(5);
    expect(estimateRestorePower(buildPlanDevice({ measuredPowerKw: 3, powerKw: 1 }))).toBe(3);
    expect(estimateRestorePower(buildPlanDevice({ powerKw: 2 }))).toBe(2);
    expect(estimateRestorePower(buildPlanDevice())).toBe(1);
    expect(estimateRestorePower(buildPlanDevice({ controlCapabilityId: 'evcharger_charging' }))).toBe(1.38);
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

  it('uses the highest known power source for estimateRestorePower', () => {
    expect(estimateRestorePower(buildPlanDevice({
      planningPowerKw: 3,
      expectedPowerKw: 4,
      measuredPowerKw: 5,
    }))).toBe(5);
  });

  it('estimateRestorePower skips expectedPowerKw=0 and falls through to the next source', () => {
    // H1 fix: expectedPowerKw=0 is almost certainly misconfiguration — a device that draws
    // 0kW needs no capacity management. Treating it as 0 makes needed=0.2kW (buffer only),
    // admitting the restore regardless of actual draw, and reserving no pending headroom.
    // The fix: treat 0 the same as absent — fall through to measuredPowerKw or powerKw.
    expect(estimateRestorePower(buildPlanDevice({ expectedPowerKw: 0, powerKw: 2 }))).toBe(2);
    expect(estimateRestorePower(buildPlanDevice({ expectedPowerKw: 0, measuredPowerKw: 3, powerKw: 2 }))).toBe(3);
    expect(estimateRestorePower(buildPlanDevice({ expectedPowerKw: 0 }))).toBe(1); // fallback
  });
});

describe('resolveRestorePowerSource', () => {
  it('returns planning for active stepped-load devices', () => {
    expect(resolveRestorePowerSource(steppedPlanDevice({}))).toBe('planning');
  });

  it('returns stepped for off-step stepped-load devices', () => {
    expect(resolveRestorePowerSource(steppedPlanDevice({
      selectedStepId: 'off',
      planningPowerKw: 0,
      measuredPowerKw: 0,
    }))).toBe('stepped');
  });

  it('returns planning when planningPowerKw > 0', () => {
    expect(resolveRestorePowerSource(buildPlanDevice({ planningPowerKw: 2 }))).toBe('planning');
  });

  it('returns the source with the highest known restore estimate', () => {
    expect(resolveRestorePowerSource(buildPlanDevice({
      planningPowerKw: 2,
      expectedPowerKw: 3,
      measuredPowerKw: 4,
    }))).toBe('measured');
  });

  it('returns expected when expectedPowerKw > 0 and it is the strongest source', () => {
    expect(resolveRestorePowerSource(buildPlanDevice({ expectedPowerKw: 1.5 }))).toBe('expected');
  });

  it('skips expectedPowerKw=0 and falls through to next source', () => {
    expect(resolveRestorePowerSource(buildPlanDevice({ expectedPowerKw: 0, powerKw: 2 }))).toBe('configured');
    expect(resolveRestorePowerSource(buildPlanDevice({ expectedPowerKw: 0 }))).toBe('fallback');
  });

  it('returns measured when only measuredPowerKw > 0 is available', () => {
    expect(resolveRestorePowerSource(buildPlanDevice({ measuredPowerKw: 2 }))).toBe('measured');
  });

  it('returns configured when powerKw is set and no other source', () => {
    expect(resolveRestorePowerSource(buildPlanDevice({ powerKw: 1.5 }))).toBe('configured');
  });

  it('ignores NaN power candidates and falls through to finite values', () => {
    expect(resolveRestorePowerSource(buildPlanDevice({
      planningPowerKw: Number.NaN,
      expectedPowerKw: 1.5,
    }))).toBe('expected');
  });

  it('returns fallback when no power fields are set', () => {
    expect(resolveRestorePowerSource(buildPlanDevice({}))).toBe('fallback');
    expect(resolveRestorePowerSource(buildPlanDevice({ controlCapabilityId: 'evcharger_charging' }))).toBe('fallback');
  });

  it('keeps stepped restore power aligned with the stepped restore helper', () => {
    const stepped = steppedPlanDevice({
      currentState: 'off',
      selectedStepId: 'off',
      planningPowerKw: 0,
      measuredPowerKw: 0,
    });

    expect(resolveRestorePowerSource(stepped)).toBe('stepped');
    expect(estimateRestorePower(stepped)).toBe(1.25);
  });
});

describe('estimateRestorePower and resolveCandidatePower alignment', () => {
  it('keeps active-device candidate power aligned with restore admission and leaves off-device demand to live-usage logic', () => {
    // A device drawing 3kW but configured for 1kW expected:
    // shedding still frees the observed 3kW, while restore admission also holds the line at 3kW
    // because admission now uses the highest known demand rather than a priority-ordered fallback.
    const device = buildPlanDevice({
      currentState: 'on',
      measuredPowerKw: 3,
      expectedPowerKw: 1,
    });
    expect(resolveCandidatePower(device)).toBe(3);     // shedding sees 3kW
    expect(estimateRestorePower(device)).toBe(3);      // restore admission keeps the higher known draw

    // Conversely, a device with accurate expected but zero measured (it is off):
    const offDevice = buildPlanDevice({
      currentState: 'off',
      measuredPowerKw: 0,
      expectedPowerKw: 2,
      powerKw: 2.5,
    });
    expect(resolveCandidatePower(offDevice)).toBe(0);     // raw candidate power remains state-agnostic
    expect(estimateRestorePower(offDevice)).toBe(2.5);    // restore admission keeps the higher known demand
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

  it('reserves full low-step headroom for an off-path stepped restore while awaiting confirmation', () => {
    const dev = steppedPlanDevice({
      id: 'therm',
      currentOn: false,
      currentState: 'off',
      selectedStepId: 'off',
      desiredStepId: 'low',
      lastDesiredStepId: 'low',
      stepCommandPending: true,
      stepCommandStatus: 'pending',
      lastStepCommandIssuedAt: recentMs,
      measuredPowerKw: 0,
    });
    const result = computePendingRestorePowerKw([dev], { therm: recentMs }, now);
    expect(result.deviceIds).toEqual(['therm']);
    expect(result.pendingKw).toBeCloseTo(1.25, 5);
  });

  it('keeps off-path low-step headroom reserved after confirmation until a fresh whole-home sample arrives', () => {
    const dev = steppedPlanDevice({
      id: 'therm',
      currentOn: false,
      currentState: 'off',
      selectedStepId: 'low',
      desiredStepId: 'low',
      lastDesiredStepId: 'low',
      stepCommandPending: false,
      stepCommandStatus: 'success',
      measuredPowerKw: 0,
      planningPowerKw: 0,
    });
    const result = computePendingRestorePowerKw([dev], { therm: recentMs }, now);
    expect(result.deviceIds).toEqual(['therm']);
    expect(result.pendingKw).toBeCloseTo(1.25, 5);
  });

  it('releases off-path low-step headroom after a fresh whole-home sample arrives post-confirmation', () => {
    const dev = steppedPlanDevice({
      id: 'therm',
      currentOn: false,
      currentState: 'off',
      selectedStepId: 'low',
      desiredStepId: 'low',
      lastDesiredStepId: 'low',
      stepCommandPending: false,
      stepCommandStatus: 'success',
      measuredPowerKw: 0,
      planningPowerKw: 0,
    });
    const result = computePendingRestorePowerKw([dev], { therm: recentMs }, now, recentMs + 1);
    expect(result.pendingKw).toBe(0);
    expect(result.deviceIds).toHaveLength(0);
  });

  it('releases off-path low-step reservation once the stepped restore has fallen into retry backoff', () => {
    const dev = steppedPlanDevice({
      id: 'therm',
      currentOn: false,
      currentState: 'off',
      selectedStepId: 'low',
      desiredStepId: 'low',
      lastDesiredStepId: 'low',
      stepCommandPending: false,
      stepCommandStatus: 'stale',
      nextStepCommandRetryAtMs: now + 30_000,
      measuredPowerKw: 0,
      planningPowerKw: 0,
    });
    const result = computePendingRestorePowerKw([dev], { therm: recentMs }, now);
    expect(result.pendingKw).toBe(0);
    expect(result.deviceIds).toHaveLength(0);
  });

  it('reserves only the incremental gap for stepped restore while awaiting step confirmation', () => {
    const dev = steppedPlanDevice({
      id: 'therm',
      currentOn: true,
      selectedStepId: 'low',
      previousStepId: 'low',
      desiredStepId: 'medium',
      lastDesiredStepId: 'medium',
      stepCommandPending: true,
      stepCommandStatus: 'pending',
      lastStepCommandIssuedAt: recentMs,
      measuredPowerKw: 1.25,
      planningPowerKw: 1.25,
    });
    const result = computePendingRestorePowerKw([dev], { therm: recentMs }, now);
    expect(result.deviceIds).toEqual(['therm']);
    expect(result.pendingKw).toBeCloseTo(0.75, 5);
  });

  it('keeps stepped pending restore headroom reserved after step confirmation until a fresh whole-home sample arrives', () => {
    const dev = steppedPlanDevice({
      id: 'therm',
      currentOn: true,
      selectedStepId: 'medium',
      previousStepId: 'low',
      desiredStepId: 'medium',
      lastDesiredStepId: 'medium',
      stepCommandPending: false,
      stepCommandStatus: 'success',
      measuredPowerKw: 1.25,
      planningPowerKw: 2,
    });
    const result = computePendingRestorePowerKw([dev], { therm: recentMs }, now);
    expect(result.deviceIds).toEqual(['therm']);
    expect(result.pendingKw).toBeCloseTo(0.75, 5);
  });

  it('keeps stepped pending restore headroom reserved after 60 seconds if no fresh whole-home sample has arrived', () => {
    const dev = steppedPlanDevice({
      id: 'therm',
      currentOn: true,
      selectedStepId: 'medium',
      previousStepId: 'low',
      desiredStepId: 'medium',
      lastDesiredStepId: 'medium',
      stepCommandPending: false,
      stepCommandStatus: 'success',
      measuredPowerKw: 1.25,
      planningPowerKw: 2,
    });
    const result = computePendingRestorePowerKw([dev], { therm: recentMs }, recentMs + 61_000);
    expect(result.deviceIds).toEqual(['therm']);
    expect(result.pendingKw).toBeCloseTo(0.75, 5);
  });

  it('releases stepped pending restore headroom after a fresh whole-home sample arrives post-confirmation', () => {
    const dev = steppedPlanDevice({
      id: 'therm',
      currentOn: true,
      selectedStepId: 'medium',
      previousStepId: 'low',
      desiredStepId: 'medium',
      lastDesiredStepId: 'medium',
      stepCommandPending: false,
      stepCommandStatus: 'success',
      measuredPowerKw: 1.25,
      planningPowerKw: 2,
    });
    const result = computePendingRestorePowerKw([dev], { therm: recentMs }, now, recentMs + 1);
    expect(result.pendingKw).toBe(0);
    expect(result.deviceIds).toHaveLength(0);
  });

  it('does not treat configured powerKw as settled stepped power without measure_power', () => {
    const dev = steppedPlanDevice({
      id: 'therm',
      currentOn: true,
      selectedStepId: 'medium',
      previousStepId: 'low',
      desiredStepId: 'medium',
      lastDesiredStepId: 'medium',
      stepCommandPending: false,
      stepCommandStatus: 'success',
      measuredPowerKw: undefined,
      powerKw: 2,
      planningPowerKw: 2,
    });
    const result = computePendingRestorePowerKw([dev], { therm: recentMs }, now);
    expect(result.deviceIds).toEqual(['therm']);
    expect(result.pendingKw).toBeCloseTo(0.75, 5);
  });

  it('releases stepped pending restore headroom once the attempt has fallen into retry backoff', () => {
    const dev = steppedPlanDevice({
      id: 'therm',
      currentOn: true,
      selectedStepId: 'low',
      desiredStepId: 'medium',
      lastDesiredStepId: 'medium',
      stepCommandPending: false,
      stepCommandStatus: 'stale',
      lastStepCommandIssuedAt: recentMs,
      nextStepCommandRetryAtMs: now + 30_000,
      measuredPowerKw: 1.25,
      planningPowerKw: 1.25,
    });
    const result = computePendingRestorePowerKw([dev], { therm: recentMs }, now);
    expect(result.pendingKw).toBe(0);
    expect(result.deviceIds).toHaveLength(0);
  });

  it('skips ordinary (non-stepped) device that is off within the window', () => {
    // Restore command may not have taken effect, or device was turned back off — no latent load.
    const dev = buildPlanDevice({ id: 'therm', currentOn: false, expectedPowerKw: 2, measuredPowerKw: 0 });
    const result = computePendingRestorePowerKw([dev], { therm: recentMs }, now);
    expect(result.pendingKw).toBe(0);
    expect(result.deviceIds).toHaveLength(0);
  });

  it('uses powerKw as observed draw fallback when measuredPowerKw is absent', () => {
    // Installations without live power only populate powerKw. Treat it as actual draw so
    // a device already drawing via powerKw is not double-reserved for the full expected load.
    const dev = buildPlanDevice({ id: 'therm', currentOn: true, expectedPowerKw: 3, powerKw: 1 });
    const result = computePendingRestorePowerKw([dev], { therm: recentMs }, now);
    expect(result.pendingKw).toBeCloseTo(2, 5); // gap: 3 - 1 (1 < 3*0.5 — not yet confirmed)
  });

  it('uses the same conservative restore estimate for pending restore reservation', () => {
    // If a device has recently shown a higher draw than its current planning target, keep
    // reserving against that higher draw until confirmation catches up.
    const dev = buildPlanDevice({
      id: 'stepper',
      currentOn: true,
      currentState: 'on',
      planningPowerKw: 1.5,
      measuredPowerKw: 3,
    });
    const result = computePendingRestorePowerKw([dev], { stepper: recentMs }, now);
    expect(estimateRestorePower(dev)).toBe(3);
    expect(result.pendingKw).toBeCloseTo(0, 5); // already confirmed against the conservative estimate
  });

  it('considers powerKw-only device confirmed when powerKw meets threshold', () => {
    // powerKw=1.2 meets the 50% threshold of expectedPowerKw=2 — device is confirmed, no reservation.
    const dev = buildPlanDevice({ id: 'therm', currentOn: true, expectedPowerKw: 2, powerKw: 1.2 });
    const result = computePendingRestorePowerKw([dev], { therm: recentMs }, now);
    expect(result.pendingKw).toBe(0);
    expect(result.deviceIds).toHaveLength(0);
  });

  it('skips device already planned to be shed this cycle', () => {
    // Re-shed device keeps its recent restore timestamp but must not block unrelated restores.
    const dev = buildPlanDevice({ id: 'therm', currentOn: true, plannedState: 'shed', expectedPowerKw: 2, measuredPowerKw: 0 });
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
