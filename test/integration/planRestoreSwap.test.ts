import {
  buildSwapCandidates,
} from '../../lib/plan/swap';
import {
  buildInsufficientHeadroomUpdate,
  computeRestoreBufferKw,
  estimateRestorePower,
  resolveRestorePowerSource,
} from '../../lib/plan/restore/accounting';
import { buildRestoreHeadroomReason } from '../../lib/plan/planReasonStrings';
import { getHighestKnownPowerKw } from '../../lib/observer/observedPower';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import { buildPlanDevice, steppedPlanDevice } from '../utils/planTestUtils';
import { reasonText } from '../utils/deviceReasonTestUtils';

// Fixture shape: the shared output builders resolve the producer-owned `currentOn`
// (the on/off truth the restore path reads) from the fixture's `binaryControl`,
// mirroring `toPlanDevice`.
type BinaryFixture = DevicePlanDevice & { binaryControl?: { on: boolean } };

const binaryDevice = (
  overrides: Parameters<typeof buildPlanDevice>[0] = {},
): BinaryFixture => buildPlanDevice(overrides) as BinaryFixture;

describe('buildSwapCandidates', () => {
  it('excludes devices with equal or higher restore priority', () => {
    const result = buildSwapCandidates({
      dev: buildPlanDevice({ priority: 50 }),
      onDevices: [
        buildPlanDevice({ id: 'higher', name: 'Higher', priority: 40, measuredPowerKw: 2, expectedPowerKw: 2 }),
        buildPlanDevice({ id: 'equal', name: 'Equal', priority: 50, measuredPowerKw: 2, expectedPowerKw: 2 }),
      ],
      swappedOutFor: new Map(),
      availableHeadroom: 1,
      needed: 3,
      restoredThisCycle: new Set(),
    });

    expect(result.ready).toBe(false);
    expect(result.toShed).toHaveLength(0);
  });

  // Per-axis admission: a NON-exempt target's budget axis is invariant to an
  // exempt source turning off (measured exempt sum and total drop together), so
  // counting the exempt source's freed draw would pause a running exempt device
  // for a swap target that is re-rejected every cycle (strand + churn). An
  // exempt TARGET admits on the capacity axis, where freed draw is real.
  it('never counts a budget-exempt source toward a non-exempt target, but does for an exempt target', () => {
    const onDevices = [
      buildPlanDevice({ id: 'exempt-src', name: 'Exempt Heater', priority: 120, budgetExempt: true, measuredPowerKw: 2, expectedPowerKw: 2 }),
    ];
    const forNonExempt = buildSwapCandidates({
      dev: buildPlanDevice({ id: 'target', priority: 50 }),
      onDevices,
      swappedOutFor: new Map(),
      availableHeadroom: 0.3,
      needed: 1.2,
      restoredThisCycle: new Set(),
    });
    expect(forNonExempt.ready).toBe(false);
    expect(forNonExempt.toShed).toHaveLength(0);

    const forExempt = buildSwapCandidates({
      dev: buildPlanDevice({ id: 'target-exempt', priority: 50, budgetExempt: true }),
      onDevices,
      swappedOutFor: new Map(),
      availableHeadroom: 0.3,
      needed: 1.2,
      restoredThisCycle: new Set(),
    });
    expect(forExempt.toShed.map((device) => device.id)).toEqual(['exempt-src']);
  });

  it('defaults missing priorities to 100 when evaluating swap candidates', () => {
    const result = buildSwapCandidates({
      dev: buildPlanDevice({ priority: undefined }),
      onDevices: [
        buildPlanDevice({ id: 'equal-default', name: 'EqualDefault', priority: undefined, measuredPowerKw: 2, expectedPowerKw: 2 }),
        buildPlanDevice({ id: 'lower-priority', name: 'LowerPriority', priority: 120, measuredPowerKw: 2, expectedPowerKw: 2 }),
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
      buildPlanDevice({ id: 'shed', name: 'Shed', priority: 100, plannedState: 'shed', measuredPowerKw: 2, expectedPowerKw: 2 }),
      buildPlanDevice({ id: 'skip', name: 'Skip', priority: 90, plannedState: 'keep', measuredPowerKw: 2, expectedPowerKw: 2 }),
      buildPlanDevice({ id: 'restored', name: 'Restored', priority: 80, plannedState: 'keep', measuredPowerKw: 2, expectedPowerKw: 2 }),
      buildPlanDevice({ id: 'add1', name: 'Add1', priority: 70, plannedState: 'keep', measuredPowerKw: 2, expectedPowerKw: 2 }),
      // Declares 1 kW. It used to contribute that via the observer's generic
      // 1.0 kW fallback constant, which is deleted — a device nobody declared
      // anything about now draws 0 and offers no swap relief.
      buildPlanDevice({ id: 'add2', name: 'Add2', priority: 60, plannedState: 'keep', measuredPowerKw: 1, expectedPowerKw: 1 }),
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
      onDevices: [buildPlanDevice({ id: 'on', name: 'On', priority: 90, measuredPowerKw: 1, expectedPowerKw: 1 })],
      swappedOutFor: new Map(),
      availableHeadroom: 0,
      needed: 5,
      restoredThisCycle: new Set(),
    });

    expect(result.ready).toBe(false);
    expect(result.toShed).toHaveLength(1);
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

    // The numbers the rejection turns on, asserted as numbers. They used to be
    // read out of a formatted sentence, which meant this test passed or failed on
    // the wording as much as on the arithmetic.
    expect(result.ready).toBe(false);
    expect(result.displayEffectiveHeadroomKw).toBeCloseTo(1.30, 6);
    expect(result.displayPostReserveMarginKw).toBeCloseTo(0.05, 6);
    expect(result.reserveKw).toBeCloseTo(0.30, 6);
  });

  it('keeps swap restores blocked until the swap and admission reserves are both satisfied', () => {
    const result = buildSwapCandidates({
      dev: buildPlanDevice({ priority: 50 }),
      onDevices: [
        buildPlanDevice({
          id: 'candidate',
          name: 'Candidate',
          priority: 90,
          // Drawing its full load: shedding it frees 1.2 kW, which is the relief
          // the swap is priced on — `buildSwapCandidates` reads `currentDrawKw`,
          // so the measured draw is what makes this device a candidate at all.
          measuredPowerKw: 1.2,
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
    // Names the device being shed to make room, which is what the removed
    // `decisionText` sentence ("swapped out for ...") reported about this case.
    expect(result.shedNames).toBe('Candidate');
  });

  it('treats explicit zero expected or configured power as zero instead of falling back to 1kW', () => {
    const result = buildSwapCandidates({
      dev: buildPlanDevice({ priority: 50 }),
      onDevices: [
        buildPlanDevice({
          id: 'zero',
          name: 'Zero',
          priority: 90,
          measuredPowerKw: 0, expectedPowerKw: 0,
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
    expect(estimateRestorePower(buildPlanDevice({ expectedPowerKw: 2, measuredPowerKw: 5 }))).toBe(5);
    expect(estimateRestorePower(buildPlanDevice({ measuredPowerKw: 3, expectedPowerKw: 1 }))).toBe(3);
    expect(estimateRestorePower(buildPlanDevice({ currentDrawKw: 0, expectedPowerKw: 2 }))).toBe(2);
    expect(estimateRestorePower(buildPlanDevice({ currentDrawKw: 0 }))).toBe(1);
    expect(estimateRestorePower(buildPlanDevice({
      currentDrawKw: 0,
      binaryCapabilityId: 'evcharger_charging',
    }))).toBe(1.38);
  });

  it('uses lowest non-zero step for stepped devices at off-step', () => {
    // At off-step: planningPowerKw=0, measuredPowerKw=0 — should use lowest non-zero step (1.25kW)
    expect(estimateRestorePower(steppedPlanDevice({
      selectedStepId: 'off',
      planningPowerKw: 0,
      currentDrawKw: 0,
    }))).toBe(1.25);
    // At active step with positive planningPowerKw — should use planningPowerKw directly
    expect(estimateRestorePower(steppedPlanDevice({
      selectedStepId: 'medium',
      currentDrawKw: 2, planningPowerKw: 2,
    }))).toBe(2);
    // Device is off (currentState: 'off'), but selectedStepId is 'medium'.
    // planningPowerKw is 2.0 (retained from medium step).
    // Should use 1.25 (low step) because it's starting from off.
    expect(estimateRestorePower(steppedPlanDevice({
      currentState: 'off',
      selectedStepId: 'medium',
      planningPowerKw: 2,
      currentDrawKw: 0,
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

  it('estimateRestorePower takes the highest of the live and expected draw', () => {
    // `expectedPowerKw: 0` used to be reachable misconfiguration that had to be
    // skipped so the device did not admit a restore against a 0 kW need. The
    // producer no longer emits it: the ladder ends on a positive default, so the
    // skip has nothing left to skip and the only question is which known source
    // is highest.
    expect(estimateRestorePower(buildPlanDevice({ measuredPowerKw: 0, expectedPowerKw: 2 }))).toBe(2);
    expect(estimateRestorePower(buildPlanDevice({ expectedPowerKw: 2, measuredPowerKw: 3 }))).toBe(3);
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
      currentDrawKw: 0,
    }))).toBe('stepped');
  });

  it('returns planning when planningPowerKw > 0', () => {
    expect(resolveRestorePowerSource(buildPlanDevice({ currentDrawKw: 0, planningPowerKw: 2 }))).toBe('planning');
  });

  it('returns the source with the highest known restore estimate', () => {
    expect(resolveRestorePowerSource(buildPlanDevice({
      planningPowerKw: 2,
      expectedPowerKw: 3,
      measuredPowerKw: 4,
    }))).toBe('measured');
  });

  it('returns expected when expectedPowerKw > 0 and it is the strongest source', () => {
    expect(resolveRestorePowerSource(buildPlanDevice({ currentDrawKw: 0, expectedPowerKw: 1.5 }))).toBe('expected');
  });

  it('reports expected when the expected draw is the only positive source', () => {
    // Was two cases: `'configured'` (the label for the deleted `powerKw`) and a
    // `'fallback'` arm for `expectedPowerKw: 0`. Both concepts are gone — the
    // number now arrives on the expected rung, which is the only place it ever
    // came from.
    expect(resolveRestorePowerSource(buildPlanDevice({ currentDrawKw: 0, expectedPowerKw: 2 }))).toBe('expected');
  });

  it('returns measured when only measuredPowerKw > 0 is available', () => {
    expect(resolveRestorePowerSource(buildPlanDevice({ measuredPowerKw: 2 }))).toBe('measured');
  });

  it('returns expected when the expected draw is set and no other source', () => {
    expect(resolveRestorePowerSource(buildPlanDevice({ currentDrawKw: 0, expectedPowerKw: 1.5 }))).toBe('expected');
  });

  it('ignores NaN power candidates and falls through to finite values', () => {
    expect(resolveRestorePowerSource(buildPlanDevice({
      currentDrawKw: 0,
      planningPowerKw: Number.NaN,
      expectedPowerKw: 1.5,
    }))).toBe('expected');
  });

  // The `'fallback'` source is gone. A device with no declared power still gets a
  // positive expected draw from the producer's last rung — 1 kW, or the EV
  // typical start for a charger — so it arrives labelled `'expected'` and the
  // "no source carried a positive number" state cannot occur.
  it('labels the producer default as expected, for both generic and EV devices', () => {
    expect(resolveRestorePowerSource(buildPlanDevice({ currentDrawKw: 0 }))).toBe('expected');
    expect(resolveRestorePowerSource(buildPlanDevice({
      currentDrawKw: 0,
      binaryCapabilityId: 'evcharger_charging',
    }))).toBe('expected');
  });

  it('keeps stepped restore power aligned with the stepped restore helper', () => {
    const stepped = steppedPlanDevice({
      currentState: 'off',
      selectedStepId: 'off',
      planningPowerKw: 0,
      currentDrawKw: 0,
    });

    expect(resolveRestorePowerSource(stepped)).toBe('stepped');
    expect(estimateRestorePower(stepped)).toBe(1.25);
  });
});

describe('observed power boundary — current draw vs restore draw', () => {
  it('keeps shed-candidate current draw aligned with restore admission for an active device', () => {
    // A device drawing 3kW with configured 1kW: shedding frees the observed 3kW,
    // restore admission would also reserve 3kW (the highest known demand).
    const device = binaryDevice({
      currentState: 'on',
      binaryControl: { on: true },
      measuredPowerKw: 3,
    });
    expect(device.currentDrawKw).toBe(3);
    expect(estimateRestorePower(device)).toBe(3);
  });

  it('reports current draw as zero for an off device while restore admission keeps the stable configured demand', () => {
    const offDevice = binaryDevice({
      currentState: 'off',
      binaryControl: { on: false },
      measuredPowerKw: 0,
      expectedPowerKw: 2.5,
    });
    // Shedding an already-off device gives no immediate relief.
    expect(offDevice.currentDrawKw).toBe(0);
    // Restore admission reserves the device's configured peak (TODO #43 — the
    // configured load stays the stable expected demand even when measured is 0).
    expect(getHighestKnownPowerKw(offDevice).kw).toBe(2.5);
    expect(estimateRestorePower(offDevice)).toBe(2.5);
  });
});
