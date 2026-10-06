import { describe, expect, it } from 'vitest';
import { applyDeferredAdmissionToInput } from '../../lib/objectives/deferredObjectives/admission';
import {
  resolveEffectivePlanStatus,
  resolveSmartTaskListStatus,
  resolveSmartTaskLiveCause,
} from '../../packages/shared-domain/src/deadlineLabels';
import { withBinaryDiscriminant, type PlanInputDevice } from '../../lib/plan/planTypes';
import type { DeferredAdmissionDecision } from '../../lib/objectives/deferredObjectives/admission';
import { fixtureControlPosture, withFixtureResidualKw } from '../utils/planTestUtils';

// "Leave off until turned on again" against a smart task: the task wins (owner
// ruling, 2026-10-06). An hour the task books ends the hold; an hour it does not
// book leaves the hold alone, since both want the device off.
describe('external-off hold — a booked smart-task hour ends it', () => {
  const buildDevice = (overrides: Partial<PlanInputDevice> = {}): PlanInputDevice => (
    withBinaryDiscriminant(withFixtureResidualKw({
      id: 'heater-1',
      name: 'Water heater',
      targets: [],
      binaryCapabilityId: 'onoff',
      binaryControl: { on: false },
      control: fixtureControlPosture({ controllable: false, managed: true }),
      ...overrides,
    })) as PlanInputDevice
  );

  const plannedRescue: DeferredAdmissionDecision = {
    kind: 'planned',
    budgetExempt: true,
    engageBoost: true,
    reservesStartupPower: true,
  };
  const idle: DeferredAdmissionDecision = { kind: 'idle', budgetExempt: false };

  const admit = (device: PlanInputDevice, decision: DeferredAdmissionDecision) => (
    applyDeferredAdmissionToInput([device], new Map([[device.id, decision]]))
  );

  it('ends the hold and claims what the task needs in a booked hour', () => {
    const admission = admit(buildDevice({ externalOffHoldActive: true }), plannedRescue);
    const device = admission.devices[0]!;
    expect(admission.externalOffHoldLiftedDeviceIds).toEqual(new Set(['heater-1']));
    expect(device.externalOffHoldActive).toBeUndefined();
    expect(device.reservesStartupPower).toBe(true);
    expect(device.forceBoostActive).toBe(true);
    expect(device.budgetExempt).toBe(true);
    expect(device.control.commandAuthority).toBe(true);
  });

  it('claims the same for a device that was never held', () => {
    const admission = admit(buildDevice(), plannedRescue);
    const device = admission.devices[0]!;
    expect(admission.externalOffHoldLiftedDeviceIds.size).toBe(0);
    expect(device.reservesStartupPower).toBe(true);
    expect(device.forceBoostActive).toBe(true);
    expect(device.budgetExempt).toBe(true);
    expect(device.control.commandAuthority).toBe(true);
  });

  it('leaves the hold in place in an hour the task does not book', () => {
    const admission = admit(buildDevice({ externalOffHoldActive: true }), idle);
    const device = admission.devices[0]!;
    expect(admission.externalOffHoldLiftedDeviceIds.size).toBe(0);
    expect(device.externalOffHoldActive).toBe(true);
    // Already off by its owner's hand: the task lends no authority to release it.
    expect(device.control.commandAuthority).toBe(false);
    expect(admission.lentAuthorityDeviceIds.size).toBe(0);
  });
});

// Earlier builds persisted `objective_device_left_off` while the hold was on.
// A booked hour now ends the hold, so it is no risk to the task: the stored code
// is dropped on load (`deferredObjectiveActivePlan.test.ts`) and inert in every
// resolver a browser may reach first.
describe('external-off hold — the retired objective_device_left_off code', () => {
  const retired = 'objective_device_left_off' as never;
  const cachedOnTrackPlan = {
    pending: false,
    pendingReason: undefined,
    planStatus: 'on_track' as const,
    firstActionAtMs: null,
    nowMs: 1_000_000,
    carChargeLimit: null,
  };

  it('is ignored by every resolver', () => {
    expect(resolveSmartTaskListStatus({
      liveCompletion: { kind: 'unavailable' }, ...cachedOnTrackPlan, diagnosticReasonCode: retired,
    })).toBe('on_track');
    expect(resolveEffectivePlanStatus('on_track', {
      liveCompletion: { kind: 'unavailable' }, targetValue: 55, diagnosticReasonCode: retired,
    })).toBe('on_track');
    expect(resolveSmartTaskLiveCause(retired, null, 'none')).toBeNull();
  });
});
