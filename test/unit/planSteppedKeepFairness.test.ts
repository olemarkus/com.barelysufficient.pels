import { describe, expect, it } from 'vitest';
import { reconcileSteppedKeepFairness } from '../../lib/plan/planSteppedKeepFairness';
import { ShedDecisions } from '../../lib/plan/shedDecisions';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import { buildPlanDevice, steppedPlanDevice } from '../utils/planTestUtils';

const charger = (overrides: Parameters<typeof steppedPlanDevice>[0] = {}) => steppedPlanDevice({
  id: 'charger', priority: 1, plannedState: 'keep', currentState: 'on',
  selectedStepId: 'medium', desiredStepId: 'medium',
  reason: { code: PLAN_REASON_CODES.keep, detail: null },
  ...overrides,
});
const heldPeer = (overrides: Parameters<typeof buildPlanDevice>[0] = {}) => buildPlanDevice({
  id: 'peer', priority: 3, plannedState: 'shed', currentState: 'off',
  reason: { code: PLAN_REASON_CODES.capacity }, ...overrides,
});
const chargingAfter = (charging: DevicePlanDevice, peer: DevicePlanDevice, decisions = new ShedDecisions()) => (
  reconcileSteppedKeepFairness([charging, peer], decisions).find((device) => device.id === 'charger')
);

describe('final stepped keep fairness', () => {
  it('does not lower for an admitted prior-held peer or a newly added peer kept this cycle', () => {
    for (const priorHeld of [true, false]) {
      const decisions = new ShedDecisions();
      decisions.lastPlannedDeviceIds = new Set(['charger']);
      if (priorHeld) decisions.lastPlannedShedIds = new Set(['peer']);
      const charging = charger();
      const admitted = heldPeer({ plannedState: 'keep', reason: {
        code: PLAN_REASON_CODES.restoreNeed, fromTarget: 'off', toTarget: 'on', needKw: 2,
      } });
      expect(decisions.wasShedOrUnplanned('peer')).toBe(true);
      expect(chargingAfter(charging, admitted, decisions)).toBe(charging);
    }
  });

  it('does not lower for a running stepped peer held at its own floor', () => {
    const charging = charger();
    const peer = steppedPlanDevice({ id: 'peer', plannedState: 'keep', currentState: 'on',
      selectedStepId: 'low', desiredStepId: 'low',
      reason: { code: PLAN_REASON_CODES.cooldownRestore, remainingSec: 30 } });
    expect(chargingAfter(charging, peer)).toBe(charging);
  });

  it.each([
    { code: PLAN_REASON_CODES.cooldownRestore, remainingSec: 30 },
    { code: PLAN_REASON_CODES.cooldownShedding, remainingSec: 30 },
    { code: PLAN_REASON_CODES.meterSettling },
    { code: PLAN_REASON_CODES.restorePending, remainingSec: 30 },
    { code: PLAN_REASON_CODES.restoreThrottled },
    { code: PLAN_REASON_CODES.waitingForOtherDevices },
    { code: PLAN_REASON_CODES.activationBackoff, remainingSec: 30 },
    { code: PLAN_REASON_CODES.neutralStartupHold },
  ] as const)('does not lower for a peer waiting only on $code', (reason) => {
    const charging = charger();
    expect(chargingAfter(charging, heldPeer({ reason }))).toBe(charging);
  });

  it.each([
    { code: PLAN_REASON_CODES.insufficientHeadroom, needKw: 2, availableKw: 0.1,
      admissionMarginKw: 0, penaltyExtraKw: null, swapReserveKw: null, effectiveAvailableKw: 0.1 },
    { code: PLAN_REASON_CODES.shortfall },
  ] as const)('lowers for a peer held for power by $code', (reason) => {
    expect(chargingAfter(charger(), heldPeer({ reason }))?.desiredStepId).toBe('low');
  });

  it.each([
    { name: 'it is observed off', device: charger({ currentState: 'off' }) },
    { name: 'it is inactive', device: charger({ plannedState: 'inactive' }) },
    { name: 'it lacks command authority', device: charger({ commandAuthority: false }) },
    { name: 'it is already at its floor', device: charger({ desiredStepId: 'low' }) },
    { name: 'it is already planned off', device: charger({ desiredStepId: 'off' }) },
    { name: 'its new rung was just admitted', device: charger({ reason: {
      code: PLAN_REASON_CODES.restoreNeed, fromTarget: 'low', toTarget: 'medium', needKw: 0.75,
    } }) },
  ])('leaves the device unchanged when $name', ({ device }) => {
    expect(chargingAfter(device, heldPeer())).toBe(device);
  });

  it.each([
    { name: 'owner posture', peer: heldPeer({ nonCapacityHoldShed: true }) },
    { name: 'no command authority', peer: heldPeer({ commandAuthority: false }) },
  ])('ignores a held peer with $name', ({ peer }) => {
    const charging = charger();
    expect(chargingAfter(charging, peer)).toBe(charging);
  });

  it('reclassifies a further solar-ceiling reduction without changing measurements or command history', () => {
    const charging = charger({ surplusTracking: true, nonCapacityHoldShed: true,
      selectedStepId: 'max', desiredStepId: 'medium', lastDesiredStepId: 'medium', stepCommandPending: true });
    const limited = chargingAfter(charging, heldPeer());
    expect(limited?.desiredStepId).toBe('low');
    expect(limited?.nonCapacityHoldShed).toBeUndefined();
    expect(limited).toMatchObject({
      currentDrawKw: charging.currentDrawKw, expectedPowerKw: charging.expectedPowerKw,
      selectedStepId: charging.selectedStepId, lastDesiredStepId: charging.lastDesiredStepId,
      stepCommandPending: true, plannedState: charging.plannedState, reason: charging.reason,
    });
    expect(charging.nonCapacityHoldShed).toBe(true);
  });

  it('keeps a solar-only reduction at the floor classified as non-capacity when fairness adds no cut', () => {
    const charging = charger({ surplusTracking: true, nonCapacityHoldShed: true, desiredStepId: 'low' });
    expect(chargingAfter(charging, heldPeer())).toBe(charging);
  });

  it('allows a downward limit during startup without changing the startup hold reason', () => {
    const reason = { code: PLAN_REASON_CODES.startupStabilization } as const;
    const limited = chargingAfter(charger({ reason }), heldPeer({ reason }));
    expect(limited).toMatchObject({ desiredStepId: 'low', plannedState: 'keep', reason });
  });
});
