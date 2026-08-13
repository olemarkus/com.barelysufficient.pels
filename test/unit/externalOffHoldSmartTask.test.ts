import { describe, expect, it } from 'vitest';
import { applyDeferredAdmissionToInput } from '../../lib/objectives/deferredObjectives/admission';
import { resolveDiagnosticReasonCode } from '../../lib/objectives/deferredObjectives/activePlanDiagnosticReason';
import { resolveFloorShortfallCause } from '../../lib/objectives/deferredObjectives/floorShortfallCause';
import {
  resolveEffectivePlanStatus,
  resolveSmartTaskListStatus,
  resolveSmartTaskWidgetDetailCopy,
} from '../../packages/shared-domain/src/deadlineLabels';
import { withBinaryDiscriminant, type PlanInputDevice } from '../../lib/plan/planTypes';
import type { DeferredAdmissionDecision } from '../../lib/objectives/deferredObjectives/admission';
import type { DeferredObjectiveDiagnostic } from '../../lib/objectives/deferredObjectives';

// An explicit off action beats a smart task, but the deadline consequence has to
// stay visible: the task reports risk with a reason naming the device, rather
// than claiming it is on track because future hours are still scheduled.

describe('external-off hold — smart-task cause and copy', () => {
  it('never disturbs the frozen shortfall cause', () => {
    // The hold is transient — the user can turn the device on at any moment —
    // and this value is frozen into a committed revision. The overlay therefore
    // travels on its OWN field and leaves the planner's verdict, and the cause
    // derived from it, completely alone.
    expect(resolveFloorShortfallCause('limited_by_daily_budget')).toBe('budget');
    expect(resolveFloorShortfallCause('objective_device_left_off')).toBe('none');
  });

  it('leaves the existing shortfall causes untouched', () => {
    expect(resolveFloorShortfallCause('limited_by_daily_budget')).toBe('budget');
    expect(resolveFloorShortfallCause('target_cannot_be_met')).toBe('time_capacity');
    expect(resolveFloorShortfallCause(null)).toBe('none');
  });

  it('names the device rather than the budget or the clock', () => {
    const copy = resolveSmartTaskWidgetDetailCopy({
      statusId: 'at_risk',
      diagnosticReasonCode: 'objective_device_left_off',
    });
    expect(copy.whyLabel).toBe('Device is staying off until turned on again.');
    // No recourse hint: the fix is turning the device on, which the reason
    // already says — a budget/cap hint here would send the user the wrong way.
    expect(copy.recourseHint).toBeNull();
  });

  it('still disambiguates budget vs time when the device is not held', () => {
    expect(resolveSmartTaskWidgetDetailCopy({
      statusId: 'at_risk',
      floorShortfallCause: 'budget',
    }).whyLabel).toContain('daily budget');
    expect(resolveSmartTaskWidgetDetailCopy({
      statusId: 'at_risk',
      floorShortfallCause: 'time_capacity',
    }).whyLabel).toContain('Limited time');
  });
});

// The status downgrade reaches only the LIVE diagnostic. Everything the user
// actually looks at — the settings list, the widget — reads the PERSISTED active
// plan, whose `planStatus` is not rewritten until the next `:58` settle. Without
// the per-cycle reason code the chip would keep saying "On track" for most of an
// hour, then keep saying "At risk" for most of an hour after the device is
// turned back on.
describe('external-off hold — the persisted plan, not just the live diagnostic', () => {
  const cachedOnTrackPlan = {
    pending: false,
    pendingReason: undefined,
    planStatus: 'on_track' as const,
    firstActionAtMs: null,
    nowMs: 1_000_000,
  };

  it('routes the cause onto the plan every cycle', () => {
    expect(resolveDiagnosticReasonCode({
      externalOffHoldActive: true,
    } as DeferredObjectiveDiagnostic)).toBe('objective_device_left_off');
  });

  it('names the cause even when the reported status does not change', () => {
    // A budget-bound at-risk task whose device is then switched off must stop
    // blaming the budget: the status stays At risk, but the recourse changes
    // completely, and admission has already dropped its rescue claims.
    expect(resolveEffectivePlanStatus('at_risk', 'objective_device_left_off')).toBe('at_risk');
    expect(resolveSmartTaskWidgetDetailCopy({
      statusId: 'at_risk',
      diagnosticReasonCode: 'objective_device_left_off',
      floorShortfallCause: 'budget',
    }).whyLabel).toBe('Device is staying off until turned on again.');
  });

  it('keeps the committed verdict itself untouched, so nothing outlives the hold', () => {
    // `resolveEffectivePlanStatus` overlays; it never rewrites. The persisted
    // `planStatus` stays the trajectory truth, which is what makes recovery
    // immediate instead of stranded until the next settle.
    expect(resolveEffectivePlanStatus('on_track', 'objective_device_left_off')).toBe('at_risk');
    expect(resolveEffectivePlanStatus('on_track', undefined)).toBe('on_track');
    expect(resolveEffectivePlanStatus('satisfied', 'objective_device_left_off')).toBe('satisfied');
    expect(resolveEffectivePlanStatus('cannot_meet', 'objective_device_left_off')).toBe('cannot_meet');
  });

  it('overrides a cached on-track verdict rather than waiting for the settle', () => {
    expect(resolveSmartTaskListStatus({
      ...cachedOnTrackPlan,
      diagnosticReasonCode: 'objective_device_left_off',
    })).toBe('at_risk');
  });

  it('returns to on track the moment the device is turned on again', () => {
    // The recorder clears the code on the same per-cycle refresh, so the chip
    // recovers without waiting for a replan.
    expect(resolveSmartTaskListStatus({
      ...cachedOnTrackPlan,
      diagnosticReasonCode: undefined,
    })).toBe('on_track');
  });

  it('leaves a finished or already-failed task alone', () => {
    expect(resolveSmartTaskListStatus({
      ...cachedOnTrackPlan,
      planStatus: 'satisfied',
      diagnosticReasonCode: 'objective_device_left_off',
    })).toBe('satisfied');
    expect(resolveSmartTaskListStatus({
      ...cachedOnTrackPlan,
      planStatus: 'cannot_meet',
      diagnosticReasonCode: 'objective_device_left_off',
    })).toBe('cannot_meet');
  });

  it('keeps unplugged as the more immediate state for an EV', () => {
    expect(resolveSmartTaskListStatus({
      ...cachedOnTrackPlan,
      diagnosticReasonCode: 'objective_invalid_session',
    })).toBe('paused_unplugged');
  });

  it('explains the risk with the device, not the budget or the clock', () => {
    // Reached via the live code alone: `floorShortfallCause` is settle-time and
    // is still `budget`/undefined at this point.
    expect(resolveSmartTaskWidgetDetailCopy({
      statusId: 'at_risk',
      diagnosticReasonCode: 'objective_device_left_off',
      dailyBudgetExhaustedBucketCount: 3,
    })).toEqual({
      whyLabel: 'Device is staying off until turned on again.',
      recourseHint: null,
    });
  });
});

// A held device will not start, so anything claimed on its behalf is spent on a
// device that cannot use it — and every one of those claims costs OTHER devices.
describe('external-off hold — no rescue claims for a device that will not start', () => {
  const buildDevice = (overrides: Partial<PlanInputDevice> = {}): PlanInputDevice => (
    withBinaryDiscriminant({
      id: 'heater-1',
      name: 'Water heater',
      targets: [],
      binaryCapabilityId: 'onoff',
      binaryControl: { on: false },
      controllable: false,
      managed: true,
      ...overrides,
    }) as PlanInputDevice
  );

  const plannedRescue: DeferredAdmissionDecision = {
    kind: 'planned',
    expectedStepId: 'low',
    budgetExempt: true,
    engageBoost: true,
    reservesStartupPower: true,
  };

  const admit = (device: PlanInputDevice): PlanInputDevice => (
    applyDeferredAdmissionToInput([device], new Map([[device.id, plannedRescue]])).devices[0]!
  );

  it('drops every claim while the hold is active', () => {
    const device = admit(buildDevice({ externalOffHoldActive: true }));
    // `reservesStartupPower` is the costly one: it holds available power out of every
    // lower-priority device's reach on behalf of a device that will not run.
    expect(device.reservesStartupPower).toBeUndefined();
    expect(device.forceBoostActive).toBeUndefined();
    expect(device.budgetExempt).toBeUndefined();
    expect(device.controllable).toBe(false);
  });

  it('control case: the same task still claims what it needs when nothing is held', () => {
    const device = admit(buildDevice());
    expect(device.reservesStartupPower).toBe(true);
    expect(device.forceBoostActive).toBe(true);
    expect(device.budgetExempt).toBe(true);
    expect(device.controllable).toBe(true);
  });
});
