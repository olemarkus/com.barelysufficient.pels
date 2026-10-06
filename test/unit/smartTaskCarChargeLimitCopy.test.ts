import { describe, expect, it } from 'vitest';
import {
  resolveCarChargeLimitOverlay,
  withCarChargeLimit,
} from '../../lib/objectives/deferredObjectives/activePlanDiagnosticReason';
import type { DeferredObjectiveDiagnostic } from '../../lib/objectives/deferredObjectives';
import type { DeferredObjectiveActivePlanV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';
import {
  formatSmartTaskCarLimitListLine,
  formatSmartTaskCarLimitReason,
  formatSmartTaskCarLimitWhy,
  resolveEffectivePlanStatus,
  resolveReportedCarChargeLimit,
  resolveSmartTaskCarChargeLimit,
  resolveSmartTaskListStatus,
  resolveSmartTaskLiveCause,
  resolveSmartTaskWidgetDetailCopy,
} from '../../packages/shared-domain/src/deadlineLabels';
import { partialDouble } from '../helpers/partialDouble';

// An EV smart task whose car's own charge limit sits below its target says so
// while it runs: the card shows the owner's 80 % target, which stays the target,
// and without a reason a car that stops at 70 % reads as PELS falling short.

const diag = (fields: Partial<DeferredObjectiveDiagnostic>): DeferredObjectiveDiagnostic => (
  partialDouble<DeferredObjectiveDiagnostic>({ targetValue: 80, reachableTargetValue: 80, currentValue: 60, ...fields })
);

describe('the plan\'s car-charge-limit overlay', () => {
  it('carries the cap while the car\'s limit holds the task below its target', () => {
    expect(resolveCarChargeLimitOverlay(diag({ reachableTargetValue: 70 }), undefined))
      .toEqual({ limitValue: 70, reached: false });
  });

  it('marks it reached once the car sits at its limit', () => {
    expect(resolveCarChargeLimitOverlay(diag({ reachableTargetValue: 70, currentValue: 70 }), undefined))
      .toEqual({ limitValue: 70, reached: true });
  });

  it('has nothing to explain for a car that arrived above its target', () => {
    expect(resolveCarChargeLimitOverlay(diag({ reachableTargetValue: 70, currentValue: 85 }), undefined))
      .toBeUndefined();
  });

  it('clears it once the task can reach its target again', () => {
    expect(resolveCarChargeLimitOverlay(diag({ reachableTargetValue: 80 }), { limitValue: 70, reached: false }))
      .toBeUndefined();
  });

  it('holds it through a cycle with no reading, when the charger ended the session at the limit', () => {
    const reached = { limitValue: 70, reached: true };
    expect(resolveCarChargeLimitOverlay(diag({ currentValue: null, reachableTargetValue: 80 }), reached))
      .toBe(reached);
  });

  it('writes and drops the key without leaving an undefined behind', () => {
    const plan = partialDouble<DeferredObjectiveActivePlanV1>({ deviceId: 'ev' });
    const cap = { limitValue: 70, reached: false };
    expect(withCarChargeLimit(plan, cap)).toEqual({ deviceId: 'ev', carChargeLimit: cap });
    expect(Object.keys(withCarChargeLimit({ ...plan, carChargeLimit: cap }, undefined))).toEqual(['deviceId']);
  });
});

describe('car-limit copy', () => {
  const charging = resolveSmartTaskCarChargeLimit({ limitValue: 70, reached: false }, 80)!;
  const stopped = resolveSmartTaskCarChargeLimit({ limitValue: 70, reached: true }, 80)!;

  it('is resolved only when the limit sits below the target', () => {
    expect(charging).toEqual({ limitValue: 70, targetValue: 80, reached: false });
    expect(resolveSmartTaskCarChargeLimit(undefined, 80)).toBeNull();
    expect(resolveSmartTaskCarChargeLimit({ limitValue: 80, reached: false }, 80)).toBeNull();
    expect(resolveSmartTaskCarChargeLimit({ limitValue: 70, reached: false }, null)).toBeNull();
  });

  it('names the car\'s own limit and keeps the requested target unmet', () => {
    expect(formatSmartTaskCarLimitReason(charging)).toBe(
      "Your car stops at its own charge limit of 70%, below this smart task’s 80% target."
        + ' Raise the car’s charge limit to allow this task to reach its target.',
    );
    expect(formatSmartTaskCarLimitReason(stopped)).toBe(
      "Your car stopped at its own charge limit of 70%, below this smart task’s 80% target."
        + ' Raise the car’s charge limit to let it continue.',
    );
    expect(formatSmartTaskCarLimitWhy(charging)).toBe('Your car stops at its own charge limit of 70%, below the 80% target.');
    expect(formatSmartTaskCarLimitListLine(charging)).toBe('Car stops at 70%');
    expect(formatSmartTaskCarLimitListLine(stopped)).toBe('Car stopped at its limit of 70%');
  });

  it('names the car\'s limit as the cause on the statuses that carry it, and only there', () => {
    expect(resolveSmartTaskWidgetDetailCopy({ statusId: 'at_risk', carChargeLimit: charging }).whyLabel)
      .toBe('Your car stops at its own charge limit of 70%, below the 80% target.');
    expect(resolveSmartTaskWidgetDetailCopy({ statusId: 'cannot_meet', carChargeLimit: charging }).whyLabel)
      .toBe('Your car stops at its own charge limit of 70%, below the 80% target.');
    expect(resolveSmartTaskWidgetDetailCopy({ statusId: 'cannot_meet' }).whyLabel)
      .toBe('Not enough delivery before the deadline.');
    // A satisfied task met its target: a held, stale limit would contradict it.
    expect(resolveSmartTaskWidgetDetailCopy({ statusId: 'satisfied', carChargeLimit: stopped }).whyLabel ?? '')
      .not.toContain('Your car');
  });
});

describe('the list status of a task held below target by the car\'s limit', () => {
  const stopped = resolveSmartTaskCarChargeLimit({ limitValue: 70, reached: true }, 80);
  const charging = resolveSmartTaskCarChargeLimit({ limitValue: 70, reached: false }, 80);
  const base = {
    pending: false,
    pendingReason: undefined,
    planStatus: 'on_track' as const,
    firstActionAtMs: null,
    nowMs: 0,
    liveCompletion: { kind: 'unavailable' as const },
  };

  it('reads at risk when the charger ended the session at the lower limit', () => {
    expect(resolveSmartTaskListStatus({
      ...base, diagnosticReasonCode: 'objective_invalid_session', carChargeLimit: stopped,
    })).toBe('at_risk');
    expect(resolveSmartTaskListStatus({
      ...base, diagnosticReasonCode: 'objective_invalid_session', carChargeLimit: null,
    })).toBe('paused_unplugged');
  });

  it('reads unplugged for a car unplugged on its way to a known lower limit', () => {
    // The recorder holds the last limit while the charger reports no level; a
    // car that never got there was unplugged, and the owner should plug it in.
    expect(resolveSmartTaskListStatus({
      ...base, diagnosticReasonCode: 'objective_invalid_session',
      carChargeLimit: resolveReportedCarChargeLimit({
        diagnosticReasonCode: 'objective_invalid_session', targetValue: 80, carChargeLimit: { limitValue: 70, reached: false },
      }),
    })).toBe('paused_unplugged');
  });

  // Owner decision: "On track" promises the target, and a known lower car limit
  // means the car will stop short of it.
  it('reads at risk before the car gets to a known lower limit, even with a later first hour', () => {
    expect(resolveSmartTaskListStatus({
      ...base, diagnosticReasonCode: undefined, carChargeLimit: charging, firstActionAtMs: 1000,
    })).toBe('at_risk');
  });

  it('ignores a limit at or above the target', () => {
    expect(resolveSmartTaskListStatus({
      ...base, diagnosticReasonCode: undefined,
      carChargeLimit: resolveSmartTaskCarChargeLimit({ limitValue: 80, reached: true }, 80),
    })).toBe('on_track');
  });

  // A pending plan has no committed status to overlay: the detail page shows
  // its pending hero and the Flow reports pending, so the chip does too.
  it.each([
    [undefined, 'building_plan'],
    ['invalid_session', 'paused_unplugged'],
    ['device_unmanaged', 'paused_unmanaged'],
    ['device_in_sub_home', 'unavailable'],
  ] as const)('keeps a pending plan on its pending ladder (%s)', (pendingReason, expected) => {
    expect(resolveSmartTaskListStatus({
      ...base, pending: true, pendingReason, planStatus: undefined, diagnosticReasonCode: undefined,
      carChargeLimit: stopped,
    })).toBe(expected);
    expect(resolveSmartTaskListStatus({
      ...base, pending: true, pendingReason, planStatus: 'on_track', diagnosticReasonCode: undefined,
      carChargeLimit: stopped,
    })).toBe(expected);
  });

  // Durable exclusions outrank every overlay, the car limit included: the detail
  // page and the Flow condition treat these tasks as paused.
  it.each([
    ['objective_device_in_sub_home', 'unavailable'],
    ['objective_device_unmanaged', 'paused_unmanaged'],
  ] as const)('lets %s outrank a reached or pending car limit', (diagnosticReasonCode, expected) => {
    for (const carChargeLimit of [stopped, charging]) {
      expect(resolveSmartTaskListStatus({ ...base, diagnosticReasonCode, carChargeLimit })).toBe(expected);
      expect(resolveSmartTaskListStatus({
        ...base, pending: true, planStatus: undefined, diagnosticReasonCode, carChargeLimit,
      })).toBe(expected);
    }
  });
});

// The car's own limit below the target: the list chip, the widget row and the
// detail hero derive the status through one rule and explain it with one resolver.
describe('a known car limit below the target reads the same on every surface', () => {
  const stopped = resolveSmartTaskCarChargeLimit({ limitValue: 70, reached: true }, 80)!;
  const listStatus = (
    planStatus: 'on_track' | 'at_risk' | 'cannot_meet', reached: boolean,
  ) => resolveSmartTaskListStatus({
    pending: false, pendingReason: undefined, diagnosticReasonCode: undefined, planStatus,
    firstActionAtMs: null, nowMs: 0, liveCompletion: { kind: 'unavailable' },
    carChargeLimit: resolveSmartTaskCarChargeLimit({ limitValue: 70, reached }, 80),
  });
  const heroStatus = (
    planStatus: 'on_track' | 'at_risk' | 'cannot_meet', reached: boolean,
  ) => resolveEffectivePlanStatus(planStatus, {
    liveCompletion: { kind: 'unavailable' }, targetValue: 80, carChargeLimit: { limitValue: 70, reached },
  });

  it.each([
    ['on_track', true], ['at_risk', true], ['cannot_meet', true],
    ['on_track', false], ['at_risk', false], ['cannot_meet', false],
  ] as const)('agrees on the status of a %s verdict (reached: %s)', (planStatus, reached) => {
    expect(listStatus(planStatus, reached)).toBe(heroStatus(planStatus, reached));
  });

  it('keeps a cannot-finish verdict and otherwise reads at risk', () => {
    expect(heroStatus('on_track', true)).toBe('at_risk');
    expect(heroStatus('on_track', false)).toBe('at_risk');
    expect(heroStatus('cannot_meet', true)).toBe('cannot_meet');
  });

  it.each(['objective_device_in_sub_home', 'objective_device_unmanaged'] as const)(
    'lets %s outrank the car limit in the reported status too', (diagnosticReasonCode) => {
      expect(resolveEffectivePlanStatus('on_track', {
        liveCompletion: { kind: 'unavailable' }, targetValue: 80, diagnosticReasonCode,
        carChargeLimit: { limitValue: 70, reached: true },
      })).toBe('on_track');
    },
  );

  it('ignores a stored limit that is not below the target', () => {
    expect(resolveEffectivePlanStatus('on_track', {
      liveCompletion: { kind: 'unavailable' }, targetValue: 70, carChargeLimit: { limitValue: 70, reached: true },
    })).toBe('on_track');
  });

  it.each(['at_risk', 'cannot_meet'] as const)('keeps the car-limit why-line on a %s widget row', (statusId) => {
    expect(resolveSmartTaskWidgetDetailCopy({ statusId, carChargeLimit: stopped })).toEqual({
      whyLabel: 'Your car stopped at its own charge limit of 70%, below the 80% target.',
      recourseHint: 'Raise the car’s charge limit to reach the target.',
    });
  });

  it('explains a limit the car has not reached yet on an at-risk row', () => {
    const charging = resolveSmartTaskCarChargeLimit({ limitValue: 70, reached: false }, 80)!;
    expect(resolveSmartTaskWidgetDetailCopy({ statusId: 'at_risk', carChargeLimit: charging })).toEqual({
      whyLabel: 'Your car stops at its own charge limit of 70%, below the 80% target.',
      recourseHint: 'Raise the car’s charge limit to reach the target.',
    });
  });

  it('gives the hero the same cause, with the full reason line', () => {
    expect(resolveSmartTaskLiveCause(undefined, stopped, 'none')).toEqual({
      why: 'Your car stopped at its own charge limit of 70%, below the 80% target.',
      recourseHint: 'Raise the car’s charge limit to reach the target.',
      reason: 'Your car stopped at its own charge limit of 70%, below this smart task’s 80% target.'
        + ' Raise the car’s charge limit to let it continue.',
      listLine: 'Car stopped at its limit of 70%',
    });
  });

  it('lets a confirmed stop outrank a limit the car has not reached', () => {
    const charging = resolveSmartTaskCarChargeLimit({ limitValue: 70, reached: false }, 80);
    expect(resolveSmartTaskLiveCause('objective_not_accepting_energy', charging, 'none')?.why)
      .toBe('Device stopped taking power.');
  });
});

describe('a car limit the car has not reached yet beside a daily-budget cause', () => {
  const charging = resolveSmartTaskCarChargeLimit({ limitValue: 70, reached: false }, 80)!;
  const stopped = resolveSmartTaskCarChargeLimit({ limitValue: 70, reached: true }, 80)!;

  it('yields to the budget, which is what holds the task back while the car still charges', () => {
    expect(resolveSmartTaskLiveCause(undefined, charging, 'sole')).toBeNull();
    expect(resolveSmartTaskLiveCause(undefined, charging, 'contributing')).toBeNull();
    expect(resolveSmartTaskLiveCause(undefined, charging, 'none')?.listLine).toBe('Car stops at 70%');
  });

  it('keeps a car stopped at its limit as the cause whatever the budget says', () => {
    expect(resolveSmartTaskLiveCause(undefined, stopped, 'sole')?.listLine).toBe('Car stopped at its limit of 70%');
  });

  it('sends the widget\'s cannot-finish row to the budget, not to the car', () => {
    expect(resolveSmartTaskWidgetDetailCopy({
      statusId: 'cannot_meet', floorShortfallCause: 'budget', carChargeLimit: charging,
    }).recourseHint).toBe(resolveSmartTaskWidgetDetailCopy({
      statusId: 'cannot_meet', floorShortfallCause: 'budget',
    }).recourseHint);
    expect(resolveSmartTaskWidgetDetailCopy({
      statusId: 'cannot_meet', floorShortfallCause: 'budget', carChargeLimit: charging,
    }).whyLabel).not.toContain('charge limit');
  });

  it('hedges the widget\'s at-risk row on the budget', () => {
    expect(resolveSmartTaskWidgetDetailCopy({
      statusId: 'at_risk', floorShortfallCause: 'budget', carChargeLimit: charging,
    }).whyLabel).toBe('Today’s daily budget may run out before the deadline.');
  });
});

describe('the car limit every surface reports for an unplugged car', () => {
  const plan = (reached: boolean, diagnosticReasonCode?: 'objective_invalid_session' | 'objective_device_unmanaged') => ({
    diagnosticReasonCode, targetValue: 80, carChargeLimit: { limitValue: 70, reached },
  });

  it('drops a limit the car had not reached when it was unplugged', () => {
    expect(resolveReportedCarChargeLimit(plan(false, 'objective_invalid_session'))).toBeNull();
    expect(resolveEffectivePlanStatus('on_track', {
      ...plan(false, 'objective_invalid_session'), liveCompletion: { kind: 'unavailable' },
    })).toBe('on_track');
  });

  it('keeps a limit the car reached, since that charger ends the session with the car still in', () => {
    expect(resolveReportedCarChargeLimit(plan(true, 'objective_invalid_session'))?.reached).toBe(true);
    expect(resolveEffectivePlanStatus('on_track', {
      ...plan(true, 'objective_invalid_session'), liveCompletion: { kind: 'unavailable' },
    })).toBe('at_risk');
  });

  it('keeps an unreached limit on a plugged-in car and drops any limit on an excluded device', () => {
    expect(resolveReportedCarChargeLimit(plan(false))?.reached).toBe(false);
    expect(resolveReportedCarChargeLimit(plan(true, 'objective_device_unmanaged'))).toBeNull();
  });

  it('agrees with the list chip, which pauses that car as unplugged', () => {
    expect(resolveSmartTaskListStatus({
      pending: false, pendingReason: undefined, diagnosticReasonCode: 'objective_invalid_session',
      planStatus: 'on_track', firstActionAtMs: null, nowMs: 0, liveCompletion: { kind: 'unavailable' },
      carChargeLimit: resolveReportedCarChargeLimit(plan(false, 'objective_invalid_session')),
    })).toBe('paused_unplugged');
  });
});
