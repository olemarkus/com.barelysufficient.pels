// Unit coverage for the pure `device_in_sub_home` reason/copy plumbing
// (multi-home v1 scopes smart tasks to the main home):
// - both app→UI reject-reason mappers pass the typed reason through instead of
//   collapsing it into `invalid_candidate`;
// - both surface copy resolvers return the dedicated "separate meter" line —
//   never the "check the goal" or retry framing, which would be dishonest for
//   a hard scope rejection.
import { describe, expect, it } from 'vitest';
import { mapSmartTaskAppReason } from '../../lib/objectives/deferredObjectives';
import { mapAppRescueReason } from '../../packages/shared-domain/src/starvationRescueShared';
import { resolveStarvationRescueRejectCopy } from '../../packages/shared-domain/src/planStarvation';
import { SMART_TASK_SUB_HOME_UNAVAILABLE } from '../../packages/shared-domain/src/objectiveWriteStrings';
import {
  resolveCreateSmartTaskRejectCopy,
  resolveSmartTaskListStatus,
  resolveSmartTaskEditRejectCopy,
  resolveSmartTaskWidgetDetailCopy,
} from '../../packages/shared-domain/src/deadlineLabels';

describe('device_in_sub_home reason mapping', () => {
  it('mapSmartTaskAppReason passes the typed reason through', () => {
    expect(mapSmartTaskAppReason('device_in_sub_home')).toBe('device_in_sub_home');
  });

  it('mapAppRescueReason passes the typed reason through', () => {
    expect(mapAppRescueReason('device_in_sub_home')).toBe('device_in_sub_home');
  });
});

describe('device_in_sub_home reject copy', () => {
  it('create widget resolver returns the dedicated separate-meter line', () => {
    expect(resolveCreateSmartTaskRejectCopy('device_in_sub_home')).toBe(SMART_TASK_SUB_HOME_UNAVAILABLE);
  });

  it('settings-UI edit resolver returns the same shared line', () => {
    expect(resolveSmartTaskEditRejectCopy('device_in_sub_home')).toBe(SMART_TASK_SUB_HOME_UNAVAILABLE);
  });

  it('starvation-rescue resolver returns the same shared line (stale-row race cover)', () => {
    expect(resolveStarvationRescueRejectCopy('device_in_sub_home')).toBe(SMART_TASK_SUB_HOME_UNAVAILABLE);
  });
});

describe('device_in_sub_home active-task presentation', () => {
  it('overrides a cached on-track revision with the unavailable list status', () => {
    expect(resolveSmartTaskListStatus({
      pending: false,
      pendingReason: undefined,
      diagnosticReasonCode: 'objective_device_in_sub_home',
      planStatus: 'on_track',
      firstActionAtMs: 1,
      nowMs: 0,
    })).toBe('unavailable');
  });

  it('maps a never-revised separate-meter task to unavailable instead of building-plan', () => {
    expect(resolveSmartTaskListStatus({
      pending: true,
      pendingReason: 'device_in_sub_home',
      diagnosticReasonCode: 'objective_device_in_sub_home',
      planStatus: undefined,
      firstActionAtMs: null,
      nowMs: 0,
    })).toBe('unavailable');
  });

  it('reuses the canonical separate-meter sentence in widget detail copy', () => {
    expect(resolveSmartTaskWidgetDetailCopy({
      statusId: 'unavailable',
      pendingReason: 'device_in_sub_home',
    })).toEqual({
      whyLabel: SMART_TASK_SUB_HOME_UNAVAILABLE,
      recourseHint: null,
    });
  });
});
