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
  resolveSmartTaskCarChargeLimit,
  resolveSmartTaskListStatus,
  resolveSmartTaskWidgetDetailCopy,
} from '../../packages/shared-domain/src/deadlineLabels';
import { partialDouble } from '../helpers/partialDouble';

// An EV smart task capped at its car's own charge limit (owner ruling
// 2026-09-26) says so while it runs: the card shows the owner's 80 % target, and
// without a reason a plan that stops at 70 % reads as PELS falling short.

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

  it('names the car\'s own limit and where PELS counts the task done', () => {
    expect(formatSmartTaskCarLimitReason(charging)).toBe(
      "Your car stops at its own charge limit of 70%, below this smart task's 80% target."
        + ' PELS charges to 70% and counts the task as done there.',
    );
    expect(formatSmartTaskCarLimitReason(stopped)).toBe(
      "Your car stopped at its own charge limit of 70%, below this smart task's 80% target."
        + ' PELS counted the task as done.',
    );
    expect(formatSmartTaskCarLimitWhy(charging)).toBe('Your car stops at its own charge limit of 70%, below the 80% target.');
    expect(formatSmartTaskCarLimitListLine(charging)).toBe('Car stops at 70%');
    expect(formatSmartTaskCarLimitListLine(stopped)).toBe('Car stopped at its limit of 70%');
  });

  it('explains a task running as planned, and leaves a task with a problem its own diagnosis', () => {
    expect(resolveSmartTaskWidgetDetailCopy({ statusId: 'on_track', carChargeLimit: charging }).whyLabel)
      .toBe('Your car stops at its own charge limit of 70%, below the 80% target.');
    expect(resolveSmartTaskWidgetDetailCopy({ statusId: 'satisfied', carChargeLimit: stopped }).whyLabel)
      .toBe('Your car stopped at its own charge limit of 70%, below the 80% target.');
    expect(resolveSmartTaskWidgetDetailCopy({ statusId: 'cannot_meet', carChargeLimit: charging }).whyLabel)
      .not.toContain('Your car');
  });

  it('keeps a scheduled task\'s start time ahead of the cap', () => {
    expect(resolveSmartTaskWidgetDetailCopy({
      statusId: 'queued', carChargeLimit: charging, firstPlannedTimeLabel: '02:00',
    }).whyLabel).toBe('Cheaper hours start at 02:00. Your car stops at its own charge limit of 70%, below the 80% target.');
  });
});

describe('the list status of a task done at the car\'s limit', () => {
  const base = {
    pending: false,
    pendingReason: undefined,
    planStatus: 'on_track' as const,
    firstActionAtMs: null,
    nowMs: 0,
  };

  it('reads done, not unplugged, when the charger ended the session at the limit', () => {
    expect(resolveSmartTaskListStatus({
      ...base, diagnosticReasonCode: 'objective_invalid_session', carChargeLimitReached: true,
    })).toBe('satisfied');
    expect(resolveSmartTaskListStatus({
      ...base, diagnosticReasonCode: 'objective_invalid_session', carChargeLimitReached: false,
    })).toBe('paused_unplugged');
  });

  it('still yields to a device moved to a separate meter', () => {
    expect(resolveSmartTaskListStatus({
      ...base, diagnosticReasonCode: 'objective_device_in_sub_home', carChargeLimitReached: true,
    })).toBe('unavailable');
  });
});
