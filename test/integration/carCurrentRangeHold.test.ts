import { describe, expect, it } from 'vitest';
import {
  isCarCurrentRangeHeldDevice,
  isCarCurrentRangeHoldShed,
  resolveCarCurrentRangeHold,
} from '../../lib/plan/shedding/carCurrentRangeHold';
import { buildBasePlanDevice } from '../../lib/plan/planDevicesBase';
import { applyOffStateReason } from '../../lib/plan/planOffStateReason';
import { buildExecutableDeviceIntent } from '../../lib/plan/planExecutionProjection';
import { finalizePlanDevices } from '../../lib/plan/planReasonsValidation';
import { isRestoreLiveEligibleDevice } from '../../lib/plan/restore/devices';
import { NO_SHEDDING_OUTCOME } from '../../lib/plan/planState';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type { SheddingPlan } from '../../lib/plan/shedding/types';
import { PLAN_REASON_CODES, formatDeviceReasonUserFacing } from '../../packages/shared-domain/src/planReasonSemantics';
import { inputDevice } from '../utils/planConvergenceFixtures';

const charger = (currentOn = true): PlanInputDevice => inputDevice({
  id: 'charger', name: 'Charger', isEvCharger: true,
  managed: true, commandAuthority: true, controllable: true, commandableNow: true,
  currentState: currentOn ? 'on' : 'off', currentOn, binaryCapabilityId: 'evcharger_charging',
  currentDrawKw: currentOn ? 3.68 : 0, expectedPowerKw: 3.68, expectedPowerSource: 'default',
  priority: 1, carCurrentRangeUnavailable: true,
  chargeTargetHold: { kind: 'no_target' },
  // A planned smart task may lift the other postures, never an incompatible range.
  startPolicyHoldLifted: true, chargeTargetHoldLifted: true,
  steppedLoadProfile: { steps: [
    { id: 'off', planningPowerW: 0, planningCurrentA: 0 },
    { id: '6a', planningPowerW: 1380, planningCurrentA: 6 },
    { id: '16a', planningPowerW: 3680, planningCurrentA: 16 },
  ] },
  selectedStepId: currentOn ? '16a' : 'off', reportedStepId: currentOn ? '16a' : 'off',
  planningPowerKw: currentOn ? 3.68 : 0,
});

const buildHeld = (device: PlanInputDevice) => {
  const hold = resolveCarCurrentRangeHold([device]);
  const sheddingPlan: SheddingPlan = {
    unrelievedPhase: null, phaseExportExcessKw: 0, exportPhase: null, shedSet: hold.holdIds, shedReasons: hold.reasonById, shedStepTargets: new Map(), storageSetpoints: new Map(),
    sheddingActive: false, guardInShortfall: false, outcome: NO_SHEDDING_OUTCOME, recoveredAtMs: null,
  };
  const built = buildBasePlanDevice({
    dev: device, recentlyRestored: false, binaryCommandPending: false, plannedTarget: undefined,
    shedBehavior: { action: 'set_step' }, sheddingPlan, fairnessLimited: false, boostActive: false,
    surplusHoldShed: false, surplusAbsorbActive: false, priceTargetShift: { kind: 'none' },
    surplusCeilingStepId: undefined,
  });
  return finalizePlanDevices([built], new Map(), new Set()).planDevices[0]!;
};

describe('car current range hold', () => {
  it('pauses a running charger instead of charging below the car minimum at the configured floor', () => {
    const held = buildHeld(charger());
    expect(held).toMatchObject({
      plannedState: 'shed', desiredStepId: 'off', shedAction: 'turn_off',
      carCurrentRangeHeld: true, nonCapacityHoldShed: true,
      reason: { code: PLAN_REASON_CODES.carCurrentRangeUnavailable },
    });
    expect(buildExecutableDeviceIntent(held)).toMatchObject({
      steppedLoad: { desired: { plannedStepId: 'off' } },
    });
    expect(isRestoreLiveEligibleDevice(held)).toBe(false);
  });

  it('keeps an already paused charger inactive with the car-range reason', () => {
    const held = applyOffStateReason(buildHeld(charger(false)), false);
    expect(held.plannedState).toBe('inactive');
    expect(formatDeviceReasonUserFacing(held.reason))
      .toBe('No charging level is available within the current limits.');
    expect(isRestoreLiveEligibleDevice(held)).toBe(false);
  });

  it('does not grant command authority to a charger PELS only watches', () => {
    const device = inputDevice({ ...charger(), control: { managed: true, commandAuthority: false } });
    expect(isCarCurrentRangeHeldDevice(device)).toBe(false);
    expect(resolveCarCurrentRangeHold([device]).holdIds.size).toBe(0);
  });

  it('does not treat an overlapping fresh capacity cut as posture-only pressure', () => {
    expect(isCarCurrentRangeHoldShed(charger(), new Map([
      ['charger', { code: PLAN_REASON_CODES.capacity }],
    ]))).toBe(false);
  });

  it('releases the posture when the producer resolves a usable car range', () => {
    const { carCurrentRangeUnavailable: _unavailable, ...usable } = charger();
    expect(resolveCarCurrentRangeHold([usable]).holdIds.size).toBe(0);
  });
});
